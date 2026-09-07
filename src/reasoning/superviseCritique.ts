/**
 * 监督归因（两轨）：
 * - predict：材料/prospect；尸检旧 ι → 迭代 decide 策略（其后才可能 seedRange/peek）
 * - reason_narrow：材料∩大方向仍成立；必带排除坏 ι → infer（可深化），不过 decide
 *
 * 与 path 配对监督（matches）分工：配对结 path；本模块管不满后的归因调度。
 */

import { extractJsonObject } from './inferPath'
import { useAttentionIo } from './attentionIoStore'
import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import { ingestKeyIncrementStatuses } from './attentionArrival'

export type CritiqueFault = 'predict' | 'reason_narrow' | 'ask_user'

export type PredictSub =
  | 'reframe' // A1 框错 → 只重 decide
  | 'need_peek' // A2 门偏/不够 → decide 后再 peek（策略先迭代）
  | 'drop_briefs' // A3 死路 brief

export type ReasonSub =
  | 'same_q' // B1 同问换推
  | 'deepen' // B2 深化 Q

export interface CritiqueAutopsy {
  /** 把推理带进死胡同的 prospect */
  badProspectKeys: string[]
  /** ι 咬过、仍可能有用的 brief */
  keepBriefKeys: string[]
  /** 应剔的死路 brief */
  dropBriefKeys: string[]
  /** 应排除的坏 ι（推理轨必带；预测轨作尸检记录） */
  excludeInferKeys: string[]
  /** ι 咬过的 bookKey（供后续 seedRange 参考，不直接当 seed） */
  touchedBookKeys: string[]
  /** 给人看的失败形态 */
  failShape: string
}

export interface CritiqueDecision {
  fault: CritiqueFault
  predictSub?: PredictSub
  reasonSub?: ReasonSub
  /** 深化问文（reason_narrow + deepen） */
  deepenQuestion?: string
  autopsy: CritiqueAutopsy
  /** 写入 decide 窗的策略提示（预测轨） */
  decideStrategyHint: string
  why: string
  raw: string
}

export interface CritiqueLedger {
  queryKey: string
  question: string
  parentQueryKey: string | null
  prospects: Array<{
    prospectKey: string
    briefKey: string
    text: string
  }>
  infers: Array<{
    inferKey: string
    bookKeys: string[]
    text: string
  }>
  pathKeys: string[]
  pending: boolean
  weakDecideKeys: string[]
  unreadDecideKeys: string[]
}

export function gatherCritiqueLedger(queryKey: string): CritiqueLedger | null {
  const qk = queryKey.trim()
  if (!qk) return null
  const st = useAttentionIo.getState()
  const family = new Set(st.listQuerySelfAndAncestors(qk))
  const question = st.settledQueries[qk] ?? ''
  const prospects = st.prospects
    .filter((p) => family.has(p.queryKey))
    .map((p) => ({
      prospectKey: p.prospectKey,
      briefKey: p.briefKey,
      text: p.text,
    }))
  const infers = st.inferEdges
    .filter((e) => family.has(e.queryKey))
    .map((e) => ({
      inferKey: e.inferKey,
      bookKeys: [...e.bookKeys],
      text: e.infer || e.rationale,
    }))
  if (prospects.length === 0 && infers.length === 0) return null
  const pathKeys = st
    .listPathsForQueryKey(qk)
    .map((p) => p.pathKey)
  return {
    queryKey: qk,
    question,
    parentQueryKey: st.getQueryParent(qk),
    prospects,
    infers,
    pathKeys,
    pending: Boolean(
      st.pendingPathMatch && st.pendingPathMatch.queryKey === qk,
    ),
    weakDecideKeys: st.listKeysNeedingMore('decide'),
    unreadDecideKeys: st.listKeysUnread('decide'),
  }
}

function formatLedger(ledger: CritiqueLedger): string {
  const lines = [
    `queryKey=\`${ledger.queryKey}\``,
    `Q：${ledger.question}`,
    `parentQueryKey=${ledger.parentQueryKey ?? '∅（根）'}`,
    `pendingPath=${ledger.pending}`,
    `pathKeys：${ledger.pathKeys.join(', ') || '∅'}`,
    `decide weak：${ledger.weakDecideKeys.slice(0, 12).join(', ') || '∅'}`,
    `decide unread：${ledger.unreadDecideKeys.slice(0, 12).join(', ') || '∅'}`,
    '',
    '【prospects】',
  ]
  for (const p of ledger.prospects) {
    lines.push(
      `prospectKey=\`${p.prospectKey}\` briefKey=\`${p.briefKey}\`\n${p.text}\n`,
    )
  }
  lines.push('【infers】')
  for (const e of ledger.infers) {
    lines.push(
      `inferKey=\`${e.inferKey}\` bookKeys=${e.bookKeys.map((k) => `\`${k}\``).join(',')}\nι：${e.text}\n`,
    )
  }
  return lines.join('\n')
}

function emptyAutopsy(): CritiqueAutopsy {
  return {
    badProspectKeys: [],
    keepBriefKeys: [],
    dropBriefKeys: [],
    excludeInferKeys: [],
    touchedBookKeys: [],
    failShape: '',
  }
}

/** 启发式归因（LLM 失败或可规则命中时） */
export function heuristicCritique(input: {
  userText: string
  ledger: CritiqueLedger
}): CritiqueDecision {
  const t = input.userText.trim()
  const { ledger } = input
  const autopsy: CritiqueAutopsy = {
    ...emptyAutopsy(),
    excludeInferKeys: ledger.infers.map((e) => e.inferKey),
    touchedBookKeys: [
      ...new Set(ledger.infers.flatMap((e) => e.bookKeys)),
    ],
    keepBriefKeys: [
      ...new Set(ledger.prospects.map((p) => p.briefKey).filter(Boolean)),
    ],
    badProspectKeys: ledger.prospects.map((p) => p.prospectKey),
    failShape: 'heuristic',
  }

  const wantDeepen = /深化|收窄|更具体/.test(t)
  const materialish =
    /材料|原文|贴|brief|不够|缺|seed|peek|扩搜|门牌|找错/.test(t)
  const predictish =
    /预测|prospect|框错|不是这个可能|decide|决策/.test(t) || materialish
  const reasonish =
    /推理|方向|换推|infer|ι|推歪|换条路|排除这条/.test(t) || wantDeepen

  const hasProspect = ledger.prospects.length > 0
  const hasInfer = ledger.infers.length > 0
  const weak =
    ledger.weakDecideKeys.length > 0 || ledger.unreadDecideKeys.length > 0

  // 材料∩大方向：有充分 prospect 且用户未主攻材料/预测
  if (reasonish && !predictish && hasProspect && hasInfer) {
    const deepText = wantDeepen
      ? t
          .replace(/^(请)?(深化|收窄|更具体)(问句|问题|一下|这题)?[：:\s]*/i, '')
          .trim() || t
      : undefined
    return {
      fault: 'reason_narrow',
      reasonSub: wantDeepen ? 'deepen' : 'same_q',
      deepenQuestion: deepText,
      autopsy: {
        ...autopsy,
        badProspectKeys: [], // 狭义推理不否定 prospect 大框
        failShape: 'reason_narrow·须排除坏ι',
      },
      decideStrategyHint: '',
      why: wantDeepen
        ? '材料与预测大方向仍可用；深化 Q + 排除坏 ι，跳过 decide'
        : '材料与预测大方向仍可用；同问换推，必排坏 ι，跳过 decide',
      raw: '',
    }
  }

  if (predictish || weak || (hasInfer && !reasonish)) {
    const sub: PredictSub = materialish || weak
      ? 'need_peek'
      : /剔|死路|别用这|换材料/.test(t)
        ? 'drop_briefs'
        : 'reframe'
    const hint =
      sub === 'reframe'
        ? `【监督尸检→decide 策略】勿再铸同构 prospect：${autopsy.badProspectKeys.map((k) => `\`${k}\``).join(', ') || '（见上轮）'}。` +
          `失败形态：旧 ι 在错误预测上硬撑。新 prospect 须避开这类走法。` +
          `可留 brief：${autopsy.keepBriefKeys.slice(0, 8).join(', ') || '窗内 brief'}。` +
          `（本步只迭代 decide；若仍不够再 stopReason:peek+seedRange。）`
        : sub === 'need_peek'
          ? `【监督尸检→decide 策略】材料/邻域可能不够。先重 decide；若仍 insufficient，再 peek。` +
            `ι 咬过 book：${autopsy.touchedBookKeys.slice(0, 8).join(', ') || '∅'}（供日后 seedRange 参考，非本步直接写 seed）。` +
            `坏 prospect：${autopsy.badProspectKeys.slice(0, 6).join(', ') || '∅'}。`
          : `【监督尸检→decide 策略】死路 brief 建议剔除后再预测：` +
            `${autopsy.dropBriefKeys.slice(0, 8).join(', ') || autopsy.keepBriefKeys.slice(0, 4).join(', ')}。`

    if (sub === 'drop_briefs' && autopsy.dropBriefKeys.length === 0) {
      autopsy.dropBriefKeys = autopsy.keepBriefKeys.slice(0, 2)
    }

    return {
      fault: 'predict',
      predictSub: sub,
      autopsy,
      decideStrategyHint: hint,
      why:
        sub === 'reframe'
          ? '预测框错；迭代 decide 策略（旧 ι 作尸检，非玩法 B）'
          : sub === 'need_peek'
            ? '材料侧嫌疑；先 decide 策略，不够再热启 peek'
            : '死路 brief；剔后重 decide',
      raw: '',
    }
  }

  return {
    fault: 'ask_user',
    autopsy,
    decideStrategyHint: '',
    why: '说不清是预测（材料/prospect）还是狭义推理（方向/ι）。请点明。',
    raw: '',
  }
}

function parseCritiqueJson(
  content: string,
  ledger: CritiqueLedger,
): CritiqueDecision | null {
  const obj = extractJsonObject(content)
  if (!obj || typeof obj !== 'object') return null
  const root = obj as Record<string, unknown>
  const faultRaw = String(root.fault ?? root.track ?? '').trim()
  let fault: CritiqueFault = 'ask_user'
  if (/predict|预测|材料|prospect/i.test(faultRaw)) fault = 'predict'
  else if (/reason|推理|narrow|方向/i.test(faultRaw)) fault = 'reason_narrow'
  else if (/ask/i.test(faultRaw)) fault = 'ask_user'

  const subRaw = String(root.sub ?? root.predictSub ?? root.reasonSub ?? '').trim()
  const autopsyIn =
    (root.autopsy as Record<string, unknown> | undefined) ?? root
  const asKeys = (v: unknown): string[] => {
    if (!Array.isArray(v)) return []
    return v.map((x) => String(x).trim()).filter(Boolean)
  }

  const autopsy: CritiqueAutopsy = {
    badProspectKeys: asKeys(
      autopsyIn.badProspectKeys ?? autopsyIn.badProspects,
    ),
    keepBriefKeys: asKeys(autopsyIn.keepBriefKeys ?? autopsyIn.keepBriefs),
    dropBriefKeys: asKeys(autopsyIn.dropBriefKeys ?? autopsyIn.dropBriefs),
    excludeInferKeys: asKeys(
      autopsyIn.excludeInferKeys ?? autopsyIn.excludeInfers,
    ),
    touchedBookKeys: asKeys(
      autopsyIn.touchedBookKeys ?? autopsyIn.bookKeys,
    ),
    failShape: String(autopsyIn.failShape ?? root.why ?? '').trim(),
  }
  if (autopsy.excludeInferKeys.length === 0) {
    autopsy.excludeInferKeys = ledger.infers.map((e) => e.inferKey)
  }

  const why = String(root.why ?? root.note ?? '').trim() || fault
  const deepenQuestion = String(
    root.deepenQuestion ?? root.deepen ?? '',
  ).trim()

  if (fault === 'reason_narrow') {
    const reasonSub: ReasonSub =
      /deepen|深化|收窄/i.test(subRaw) || deepenQuestion
        ? 'deepen'
        : 'same_q'
    return {
      fault,
      reasonSub,
      deepenQuestion: deepenQuestion || undefined,
      autopsy: { ...autopsy, badProspectKeys: [] },
      decideStrategyHint: '',
      why,
      raw: content,
    }
  }

  if (fault === 'predict') {
    let predictSub: PredictSub = 'reframe'
    if (/peek|seed|材料|扩/i.test(subRaw)) predictSub = 'need_peek'
    else if (/drop|剔|死路/i.test(subRaw)) predictSub = 'drop_briefs'
    const hint =
      String(root.decideStrategyHint ?? root.strategyHint ?? '').trim() ||
      heuristicCritique({
        userText: why,
        ledger,
      }).decideStrategyHint
    return {
      fault,
      predictSub,
      autopsy,
      decideStrategyHint: hint,
      why,
      raw: content,
    }
  }

  return {
    fault: 'ask_user',
    autopsy,
    decideStrategyHint: '',
    why: why || '请说明是预测问题还是推理方向问题',
    raw: content,
  }
}

export async function runSuperviseCritique(input: {
  userText: string
  queryKey: string
  onProgress?: (msg: string) => void
}): Promise<CritiqueDecision> {
  const ledger = gatherCritiqueLedger(input.queryKey)
  if (!ledger) {
    return {
      fault: 'ask_user',
      autopsy: emptyAutopsy(),
      decideStrategyHint: '',
      why: '台账无 prospect/infer，无法监督归因。请先跑完自动流或钉住本问。',
      raw: '',
    }
  }

  const fallback = heuristicCritique({
    userText: input.userText,
    ledger,
  })

  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) return fallback

  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  input.onProgress?.('监督归因 · 预测轨 vs 狭义推理轨…')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...demoAuthHeaders(),
      },
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              '你是写信台监督归因（不是 path 配对）。只判两轨之一：\n' +
              '1) predict：材料/prospect 问题；旧 ι 只作尸检，给下一轮 decide 策略（勿直接当换推理；seedRange 只在 decide 仍不够后才考虑）。\n' +
              '2) reason_narrow：材料∩预测大方向仍成立；同问换推或深化 Q；必须排除坏 ι；禁止重跑 decide。\n' +
              '只输出 JSON：{"fault":"predict"|"reason_narrow"|"ask_user","sub":"reframe|need_peek|drop_briefs|same_q|deepen","deepenQuestion":"…或空","autopsy":{"badProspectKeys":[],"keepBriefKeys":[],"dropBriefKeys":[],"excludeInferKeys":[],"touchedBookKeys":[],"failShape":"…"},"decideStrategyHint":"预测轨给 decide 的策略原文；推理轨留空","why":"…"}',
          },
          {
            role: 'user',
            content: [
              '【用户不满】',
              input.userText,
              '',
              '【台账】',
              formatLedger(ledger),
            ].join('\n'),
          },
        ],
      }),
    })
    if (!res.ok) return fallback
    const data: unknown = await res.json()
    const content =
      typeof data === 'object' &&
      data &&
      'choices' in data &&
      Array.isArray((data as { choices: unknown }).choices)
        ? (data as { choices: Array<{ message?: { content?: string } }> })
            .choices[0]?.message?.content
        : undefined
    if (typeof content !== 'string') return fallback
    ingestKeyIncrementStatuses({
      job: 'supervise',
      llmText: content,
      windowKeys: [
        ...ledger.prospects.map((p) => p.prospectKey),
        ...ledger.infers.map((e) => e.inferKey),
      ],
    })
    return parseCritiqueJson(content, ledger) ?? fallback
  } catch {
    return fallback
  }
}

/** 本问族已有 ι → 再开 infer 必须排除（狭义推理记忆） */
export function priorInferKeysForQuery(queryKey: string): string[] {
  const st = useAttentionIo.getState()
  const family = new Set(st.listQuerySelfAndAncestors(queryKey))
  return st.inferEdges
    .filter((e) => family.has(e.queryKey))
    .map((e) => e.inferKey)
}
