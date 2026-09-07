/**
 * 轻量意图 → 写信台（§1.0.8 §7.5）
 * 第一步 = 未引入任何 LLM I/O；非第一步按 I/O 组合调度。
 */

import type { BookIndex } from './pipelineA'
import {
  useAttentionIo,
  type DeskJob,
  type LetterDeskPackage,
} from './attentionIoStore'
import { askDeepSeekWithLetterDesk } from './a1DsChat'
import { runAutoFlow } from './autoFlow'
import { LOCKED_LLM } from './modelRuntimeConfig'
import { loadDualModelConfig, reasonEndpointReady } from './modelRuntimeConfig'
import { demoAuthHeaders } from './demoAuth'
import {
  fallbackIntentFromGap,
  formatGapLedgerForIntent,
  gapToDeskPackages,
  inspectQueryGap,
  type QueryGap,
} from './gapNavigation'

export type IntroducedIoKind =
  | 'none'
  | 'desk_packages'
  | 'selected_edge'
  | 'selected_infer'
  | 'selected_query'

export function detectIntroducedIo(): {
  kind: IntroducedIoKind
  packages: LetterDeskPackage[]
  inferKey: string | null
  queryKey: string | null
  edgeId: string | null
} {
  const s = useAttentionIo.getState()
  // 台包仍算引入；钉窗只看 pinnedAttention（打开选中 ≠ 钉住）
  if (s.deskPackages.length > 0) {
    const pin = s.pinnedAttention
    return {
      kind: 'desk_packages',
      packages: s.deskPackages,
      inferKey: pin?.kind === 'infer' ? pin.inferKey : null,
      queryKey: pin?.kind === 'query' ? pin.queryKey : null,
      edgeId: pin?.kind === 'edge' ? pin.edgeId : null,
    }
  }
  const pin = s.pinnedAttention
  if (pin?.kind === 'infer') {
    return {
      kind: 'selected_infer',
      packages: [],
      inferKey: pin.inferKey,
      queryKey: null,
      edgeId: null,
    }
  }
  if (pin?.kind === 'query') {
    return {
      kind: 'selected_query',
      packages: [],
      inferKey: null,
      queryKey: pin.queryKey,
      edgeId: null,
    }
  }
  if (pin?.kind === 'edge') {
    return {
      kind: 'selected_edge',
      packages: [],
      inferKey: null,
      queryKey: null,
      edgeId: pin.edgeId,
    }
  }
  return {
    kind: 'none',
    packages: [],
    inferKey: null,
    queryKey: null,
    edgeId: null,
  }
}
export type IntentAction =
  | { type: 'auto_flow'; question?: string; note?: string }
  | { type: 'dispatch'; packages: LetterDeskPackage[] }
  | { type: 'critique'; queryKey: string; note?: string }
  | { type: 'ask_user'; prompt: string }
  | { type: 'noop'; note: string }
  | { type: 'show'; prompt: string }

/** 指令 vs 问题（架构：意图 LLM / 启发式先分流） */
export function classifyUtterance(userText: string): 'instruction' | 'question' {
  const t = userText.trim()
  if (!t) return 'question'
  // 指令：调显 / 单启工种 / 跳过匹配 / 匹配确认
  if (
    /^(显示|打开|调取|展开|看看|只看)/.test(t) ||
    /请?(跑|启|开|执行|重跑)?\s*(peek|decide|infer|query|reuse|监督)/i.test(t) ||
    /单启|单独跑|只跑|跳过匹配|监督匹配|确认匹配|path\s*匹配|深化|收窄|监督归因|不满|换方向|换推|推理不对|预测不对|材料不够/.test(t) ||
    /^(noop|通过)\s*$/i.test(t)
  ) {
    return 'instruction'
  }
  // 问句特征
  if (/[？?]$/.test(t) || /^(什么|为何|为什么|如何|怎么|是否|能否|哪)/.test(t)) {
    return 'question'
  }
  // 默认：有钉住 I/O 时偏指令调度；否则当问题走自动流
  return 'question'
}

function sid(): string {
  return `intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 快速启发式（无选中包时）；迷糊 → ask_user */
export function heuristicIntent(input: {
  userText: string
  intro: ReturnType<typeof detectIntroducedIo>
}): IntentAction {
  const t = input.userText.trim()
  const lower = t.toLowerCase()
  const kind = classifyUtterance(t)

  if (input.intro.kind === 'none') {
    if (!t) return { type: 'ask_user', prompt: '请输入问题，或钉住某步 LLM 的 I/O 再调度。' }
    if (kind === 'instruction') {
      // 监督归因：预测轨 vs 狭义推理轨（需台账已有 prospect/infer）
      if (
        /监督归因|归因|不满|推理不对|预测不对|材料不够|换方向|换推/.test(t) ||
        (/监督/.test(t) && !/跳过匹配|监督匹配/.test(t))
      ) {
        const st = useAttentionIo.getState()
        const qk =
          st.pendingPathMatch?.queryKey ||
          st.selectedQueryKey ||
          (st.selectedInferKey
            ? st.inferEdges.find((e) => e.inferKey === st.selectedInferKey)
                ?.queryKey
            : undefined) ||
          Object.keys(st.settledQueries).slice(-1)[0]
        if (qk && (st.prospects.length > 0 || st.inferEdges.length > 0)) {
          return {
            type: 'critique',
            queryKey: qk,
            note: '监督归因 · 预测 vs 狭义推理',
          }
        }
        return {
          type: 'ask_user',
          prompt:
            '监督归因需要本问已有 prospect/infer。请先跑自动流，或钉住 query/infer。',
        }
      }
      // 单启某 LLM / 调显
      if (/跳过匹配|监督匹配/.test(t)) {
        return {
          type: 'ask_user',
          prompt:
            'path 匹配：请在图上高亮 infer×prospect 后确认匹配；或说「跳过匹配」以触发监督 LLM（需有 pending）。',
        }
      }
      if (/peek|铸贴/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_peek_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'peek',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/decide|决策/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_decide_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'decide',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/infer|推理|主推理/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_infer_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'infer',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/query|邻域|历史问/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_query_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'query',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/显示|调取|打开|展开/.test(t)) {
        return {
          type: 'show',
          prompt: `指令·调显：${t.slice(0, 120)}（请钉住对应 key 的注意力窗查看）`,
        }
      }
      return {
        type: 'ask_user',
        prompt:
          '识别为指令。请说明要：调显某内容，或单启 peek / decide / infer / query；path 可「确认匹配」或「跳过匹配」。',
      }
    }
    return { type: 'auto_flow' }
  }

  // 已确认写信台包 = 已引入 I/O + 已定 job → 直接投递
  if (input.intro.kind === 'desk_packages') {
    return { type: 'dispatch', packages: input.intro.packages }
  }

  const rerun =
    /重跑|重来|不对|不满|错了|再试|重新/.test(t) || /retry|again|wrong/.test(lower)
  const advance =
    /继续|推进|下一步|够了|满意|确认|提交/.test(t) || /next|enough|ok/.test(lower)
  const otherDir =
    /另一|别的方向|换路|多方向|不要这条|排除这条|换条路/.test(t)
  const justLook = /看看|只看|没事|通过|noop/.test(t) && t.length < 12

  if (justLook || (!t && !rerun)) {
    return { type: 'noop', note: '人工监督 · noop（未发调度指令）' }
  }

  if (input.intro.kind === 'selected_infer') {
    const ik = input.intro.inferKey!
    const edge = useAttentionIo
      .getState()
      .inferEdges.find((e) => e.inferKey === ik)
    if (!edge) {
      return { type: 'ask_user', prompt: '选中的 inferKey 已失效，请重新点开 ι。' }
    }
    if (otherDir || rerun) {
      const pkg: LetterDeskPackage = {
        id: sid(),
        edgeId: edge.id,
        bookKey: edge.fromBookKey,
        briefKey: '',
        question: t || edge.question,
        job: 'infer',
        versionIndex: 0,
        createdAt: Date.now(),
        excludeMode: 'B',
        excludeInferKeys: [ik],
      }
      return { type: 'dispatch', packages: [pkg] }
    }
    return {
      type: 'ask_user',
      prompt:
        '已钉住 inferKey I/O。请说明：重跑/换方向（玩法B），还是满意推进？',
    }
  }

  if (input.intro.kind === 'selected_query') {
    const parentQk = input.intro.queryKey!
    // 深化：钉住旧问后给出更具体问句 → 子 qk → auto_flow（可跳过 decide）
    if (/深化|收窄|更具体/.test(t)) {
      const deepText =
        t
          .replace(/^(请)?(深化|收窄|更具体)(问句|问题|一下|这题)?[：:\s]*/i, '')
          .trim() || t
      const childQk = useAttentionIo.getState().ensureDeepenedQueryKey({
        parentQueryKey: parentQk,
        question: deepText,
      })
      const childQ =
        useAttentionIo.getState().settledQueries[childQk] || deepText
      return {
        type: 'auto_flow',
        question: childQ,
        note: `深化 · child=${childQk} ← parent=${parentQk}`,
      }
    }
    if (advance || rerun || t) {
      const pkg: LetterDeskPackage = {
        id: sid(),
        edgeId: `qk_${input.intro.queryKey}`,
        bookKey: '',
        briefKey: '',
        question: t || useAttentionIo.getState().settledQueries[input.intro.queryKey!] || '',
        job: 'query',
        versionIndex: 0,
        createdAt: Date.now(),
      }
      return { type: 'dispatch', packages: [pkg] }
    }
    return {
      type: 'ask_user',
      prompt:
        '已钉住 queryKey。可：重跑阶段 A；或说「深化：…」收窄问法（子 qk，可跳过 decide）。',
    }
  }

  // selected_edge：Δ brief/book 窗
  if (input.intro.kind === 'selected_edge' && input.intro.edgeId) {
    const edge = useAttentionIo
      .getState()
      .edges.find((e) => e.id === input.intro.edgeId)
    if (!edge) {
      return { type: 'ask_user', prompt: '选中的注意力边已失效。' }
    }
    let job: DeskJob = 'decide'
    if (rerun) job = 'decide'
    if (/peek|铸贴|换贴|再贴/.test(t)) job = 'peek'
    if (/主推理|infer|路径/.test(t)) job = 'infer'
    if (/阶段\s*a|历史问|排序/.test(t)) job = 'query'
    if (!t && !rerun && !advance) {
      return {
        type: 'ask_user',
        prompt:
          '已钉住 LLM I/O 窗。请说明：不满 in/out 要重跑哪步，或满意推进下一步？',
      }
    }
    const pkg: LetterDeskPackage = {
      id: sid(),
      edgeId: edge.id,
      bookKey: edge.fromKey,
      briefKey: edge.toKey,
      question: t || '',
      job,
      versionIndex: 0,
      createdAt: Date.now(),
    }
    return { type: 'dispatch', packages: [pkg] }
  }

  return {
    type: 'ask_user',
    prompt: '说不清意图。请说明盯的是哪步 I/O 的 in 还是 out，以及要重跑还是推进。',
  }
}

/**
 * 可选：轻量意图 LLM（迷糊时）；失败则回退启发式。
 * 模型 = LOCKED deepseek-v4-flash。
 */
export async function refineIntentWithLlm(input: {
  userText: string
  intro: ReturnType<typeof detectIntroducedIo>
  heuristic: IntentAction
}): Promise<IntentAction> {
  if (input.heuristic.type !== 'ask_user') return input.heuristic
  if (!input.userText.trim()) return input.heuristic

  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) return input.heuristic

  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
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
              `你是轻量意图路由（会话 epoch=${useAttentionIo.getState().intentSessionEpoch}）。` +
              '先判 instruction|question。question→auto_flow；instruction→单启 peek/decide/infer/query、监督归因(critique)、调显或跳过匹配。' +
              '只输出 JSON：{"action":"auto_flow"|"critique"|"dispatch_decide"|"dispatch_peek"|"dispatch_query"|"dispatch_infer"|"skip_path_match"|"ask_user"|"noop"|"show","attentionArrived":true|false,"note":"…"}。' +
              '不满/推理不对/预测不对/材料不够/监督归因 → critique（需台账已有 prospect 或 infer）。' +
              '不写 keep/路径/brief；不翻库；不把意图记录当成注意力窗 I/O。',
          },
          {
            role: 'user',
            content: [
              `意图会话 epoch：${useAttentionIo.getState().intentSessionEpoch}`,
              `引入 I/O 类型：${input.intro.kind}`,
              `inferKey：${input.intro.inferKey ?? '∅'}`,
              `queryKey：${input.intro.queryKey ?? '∅'}`,
              `用户话：${input.userText}`,
            ].join('\n'),
          },
        ],
      }),
    })
    if (!res.ok) return input.heuristic
    const data: unknown = await res.json()
    const content =
      typeof data === 'object' &&
      data &&
      'choices' in data &&
      Array.isArray((data as { choices: unknown }).choices)
        ? (data as { choices: Array<{ message?: { content?: string } }> })
            .choices[0]?.message?.content
        : undefined
    if (typeof content !== 'string') return input.heuristic
    const { deskMonitorAttentionArrival } = await import('./attentionArrival')
    deskMonitorAttentionArrival({ job: 'intent', llmText: content })
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return input.heuristic
    const obj = JSON.parse(m[0]) as { action?: string; note?: string }
    const action = String(obj.action ?? '')
    if (action === 'auto_flow') return { type: 'auto_flow' }
    if (action === 'critique') {
      return heuristicIntent({
        userText: '监督归因',
        intro: input.intro,
      })
    }
    if (action === 'noop')
      return { type: 'noop', note: obj.note || 'noop' }
    if (action === 'show')
      return { type: 'show', prompt: obj.note || '调显' }
    if (action === 'skip_path_match')
      return { type: 'ask_user', prompt: '跳过匹配' }
    if (action === 'ask_user')
      return {
        type: 'ask_user',
        prompt: obj.note || input.heuristic.prompt,
      }
    // map dispatch_* back through heuristic with synthetic text
    if (action === 'dispatch_infer_B' && input.intro.inferKey) {
      return heuristicIntent({
        userText: '换方向 排除这条',
        intro: input.intro,
      })
    }
    if (action.startsWith('dispatch_')) {
      const raw = action.replace('dispatch_', '')
      const job = (raw === 'mainInfer' ? 'infer' : raw) as DeskJob
      const synth =
        job === 'peek'
          ? '再 peek'
          : job === 'query'
            ? '阶段A'
            : job === 'infer'
              ? 'infer'
              : '重跑决策'
      return heuristicIntent({ userText: synth, intro: input.intro })
    }
  } catch {
    /* fall through */
  }
  return input.heuristic
}

/**
 * 意图 LLM：读台账空位事实 + 用户话 → 决定调谁。
 * 失败则 fallbackIntentFromGap（代码兜底，不是主路径）。
 */
export async function navigateGapWithIntentLlm(input: {
  userText: string
  gap: QueryGap
}): Promise<IntentAction> {
  const fallback = fallbackIntentFromGap(input.gap, input.userText)
  const asAction = (): IntentAction => {
    if (fallback.type === 'auto_flow') return { type: 'auto_flow' }
    if (fallback.type === 'dispatch')
      return { type: 'dispatch', packages: fallback.packages! }
    if (fallback.type === 'ask_user')
      return { type: 'ask_user', prompt: fallback.prompt! }
    return { type: 'show', prompt: fallback.prompt! }
  }

  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) return asAction()

  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
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
              '你是意图导航：根据「台账空位事实」和用户话，决定写信台下一步。' +
              '台账由系统检视，你只做调度决策，不要编造 key。' +
              '只输出 JSON：{"action":"auto_flow"|"dispatch_peek"|"dispatch_query"|"dispatch_decide"|"dispatch_infer"|"ask_user"|"show"|"noop","note":"…"}。' +
              '规则：缺 brief→peek 或 auto_flow；缺 neighbour→query；缺 prospect→decide；缺 infer→infer；' +
              '缺 path→ask_user；可 reuse→auto_flow；账已齐→show；用户明确单启某工种则服从。',
          },
          {
            role: 'user',
            content: [
              '【台账空位】',
              formatGapLedgerForIntent(input.gap),
              '',
              `用户话：${input.userText}`,
            ].join('\n'),
          },
        ],
      }),
    })
    if (!res.ok) return asAction()
    const data: unknown = await res.json()
    const content =
      typeof data === 'object' &&
      data &&
      'choices' in data &&
      Array.isArray((data as { choices: unknown }).choices)
        ? (data as { choices: Array<{ message?: { content?: string } }> })
            .choices[0]?.message?.content
        : undefined
    if (typeof content !== 'string') return asAction()

    const { deskMonitorAttentionArrival } = await import('./attentionArrival')
    deskMonitorAttentionArrival({ job: 'intent', llmText: content })
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return asAction()
    const obj = JSON.parse(m[0]) as { action?: string; note?: string }
    const action = String(obj.action ?? '')

    if (action === 'auto_flow') return { type: 'auto_flow' }
    if (action === 'noop')
      return { type: 'noop', note: obj.note || 'noop' }
    if (action === 'show')
      return {
        type: 'show',
        prompt: obj.note || fallback.prompt || input.gap.reason,
      }
    if (action === 'ask_user')
      return {
        type: 'ask_user',
        prompt: obj.note || fallback.prompt || input.gap.reason,
      }
    if (action.startsWith('dispatch_')) {
      const raw = action.replace('dispatch_', '')
      const job = (raw === 'mainInfer' ? 'infer' : raw) as DeskJob
      if (
        job === 'peek' ||
        job === 'query' ||
        job === 'decide' ||
        job === 'infer' ||
        job === 'supervise'
      ) {
        if (job === 'peek' || (job === 'infer' && input.gap.kind === 'reuse')) {
          // 冷启 peek / 复用闸仍走 auto_flow（需 seal / 多步）
          if (job === 'peek' && input.gap.kind === 'brief')
            return { type: 'auto_flow' }
        }
        const packages = gapToDeskPackages(input.gap, input.userText, job)
        if (packages.length === 0) {
          if (job === 'peek') return { type: 'auto_flow' }
          return asAction()
        }
        return { type: 'dispatch', packages }
      }
    }
  } catch {
    /* fall through */
  }
  return asAction()
}

/** @deprecated 用 navigateGapWithIntentLlm；保留同步兜底 */
export function intentFromGap(gap: QueryGap, question: string): IntentAction {
  const fb = fallbackIntentFromGap(gap, question)
  if (fb.type === 'auto_flow') return { type: 'auto_flow' }
  if (fb.type === 'dispatch')
    return { type: 'dispatch', packages: fb.packages! }
  if (fb.type === 'ask_user') return { type: 'ask_user', prompt: fb.prompt! }
  return { type: 'show', prompt: fb.prompt! }
}

export async function runComposerTurn(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  sealItems: Parameters<typeof runAutoFlow>[0]['sealItems']
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const intro = detectIntroducedIo()
  const epoch = useAttentionIo.getState().intentSessionEpoch
  const qRaw = input.question.trim()

  let intent = heuristicIntent({ userText: input.question, intro })
  if (intent.type === 'ask_user' && qRaw) {
    input.onProgress?.(
      `意图路由 · 轻量 LLM（会话 epoch=${epoch}）…`,
    )
    intent = await refineIntentWithLlm({
      userText: input.question,
      intro,
      heuristic: intent,
    })
  }

  // 深化 auto_flow 已铸子 qk；监督归因用 intent.queryKey；其余路径再 ensure 根/同文键
  const flowQuestion =
    intent.type === 'auto_flow' && intent.question?.trim()
      ? intent.question.trim()
      : intent.type === 'critique'
        ? useAttentionIo.getState().settledQueries[intent.queryKey] || qRaw
        : qRaw
  const turnQueryKey =
    intent.type === 'critique'
      ? intent.queryKey
      : flowQuestion
        ? useAttentionIo.getState().ensureQueryKey(flowQuestion)
        : ''

  // 空位导航：纯问题 + 未钉包 → 台账事实交给意图 LLM 决策（失败才代码兜底）
  let gapNote = ''
  if (
    intro.kind === 'none' &&
    intent.type !== 'critique' &&
    flowQuestion &&
    turnQueryKey &&
    classifyUtterance(flowQuestion) === 'question' &&
    (intent.type === 'auto_flow' || intent.type === 'ask_user') &&
    !(intent.type === 'auto_flow' && intent.note?.startsWith('深化'))
  ) {
    const gap = inspectQueryGap({
      docId: input.bookIndex.docId,
      queryKey: turnQueryKey,
      question: flowQuestion,
    })
    input.onProgress?.(`空位检视 · ${gap.kind} · 交意图 LLM…`)
    intent = await navigateGapWithIntentLlm({ userText: flowQuestion, gap })
    gapNote = `gap=${gap.kind} · ${gap.reason}`
  }

  useAttentionIo.getState().pushIntentDeskLog({
    question: flowQuestion || input.question,
    action: intent.type,
    note:
      (gapNote ? `${gapNote} · ` : '') +
      (intent.type === 'ask_user'
        ? intent.prompt
        : intent.type === 'noop'
          ? intent.note
          : intent.type === 'show'
            ? intent.prompt
            : intent.type === 'critique'
              ? `critique · qk=${intent.queryKey}` +
                (intent.note ? ` · ${intent.note}` : '')
              : intent.type === 'dispatch'
                ? `dispatch×${intent.packages.length} · qk=${turnQueryKey}`
                : `auto_flow · qk=${turnQueryKey} · epoch=${epoch}` +
                  (intent.note ? ` · ${intent.note}` : '')),
  })

  if (intent.type === 'ask_user') {
    useAttentionIo.getState().setDeskPrompt(`写信台 · ${intent.prompt}`)
    return { ok: false, answer: '', note: `ask_user · ${intent.prompt}` }
  }
  if (intent.type === 'noop') {
    return { ok: true, answer: '', note: intent.note }
  }
  if (intent.type === 'show') {
    useAttentionIo.getState().setDeskPrompt(`写信台 · ${intent.prompt}`)
    return { ok: true, answer: intent.prompt, note: `show · ${intent.prompt}` }
  }

  // 指令：跳过 path 匹配 → 监督 LLM
  if (
    /跳过匹配|监督匹配/.test(input.question) &&
    useAttentionIo.getState().pendingPathMatch
  ) {
    input.onProgress?.('写信台 · 用户跳过匹配 → 监督 LLM…')
    const { skipPendingPathMatchToSupervise } = await import(
      './letterDeskDispatch'
    )
    const r = await skipPendingPathMatchToSupervise({
      onProgress: input.onProgress,
    })
    return {
      ok: r.pathKeys.length > 0,
      answer: `### path 监督匹配\n${r.note}\npathKeys: ${r.pathKeys.map((k) => `\`${k}\``).join(', ')}`,
      note: r.note,
    }
  }

  if (intent.type === 'critique') {
    input.onProgress?.(`监督归因 · qk=${intent.queryKey}…`)
    const { runSuperviseCritique } = await import('./superviseCritique')
    const { executeSuperviseCritique } = await import('./superviseCritiqueExec')
    const decision = await runSuperviseCritique({
      queryKey: intent.queryKey,
      userText: input.question,
      onProgress: input.onProgress,
    })
    return executeSuperviseCritique({
      decision,
      queryKey: intent.queryKey,
      bookIndex: input.bookIndex,
      userText: input.question,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
    })
  }

  if (intent.type === 'auto_flow') {
    return runAutoFlow({
      question: flowQuestion,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
    })
  }

  // dispatch（空位单步或显式指令）
  const packages = intent.packages.map((p) => ({
    ...p,
    question: p.question.trim() || flowQuestion,
  }))
  return askDeepSeekWithLetterDesk({
    question: flowQuestion,
    packages,
    bookIndex: input.bookIndex,
    docId: input.bookIndex.docId,
    turnQueryKey: turnQueryKey || undefined,
    onProgress: input.onProgress,
  })
}
