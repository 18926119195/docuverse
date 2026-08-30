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
  | { type: 'auto_flow' }
  | { type: 'dispatch'; packages: LetterDeskPackage[] }
  | { type: 'ask_user'; prompt: string }
  | { type: 'noop'; note: string }

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

  if (input.intro.kind === 'none') {
    if (!t) return { type: 'ask_user', prompt: '请输入问题，或钉住某步 LLM 的 I/O 再调度。' }
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
        job: 'mainInfer',
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
      prompt: '已钉住 queryKey I/O。要重跑阶段 A，还是说明你想做什么？',
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
    if (/主推理|infer|路径/.test(t)) job = 'mainInfer'
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
              `你是轻量意图路由（会话 epoch=${useAttentionIo.getState().intentSessionEpoch}；进过主推理后会换新会话）。只输出 JSON：` +
              '{"action":"auto_flow"|"dispatch_decide"|"dispatch_peek"|"dispatch_query"|"dispatch_mainInfer_B"|"ask_user"|"noop","attentionArrived":true|false,"note":"…"}。' +
              '不写 keep/路径/brief；不翻库；不把意图记录当成注意力窗 I/O。' +
              'attentionArrived=你对本回合调度信息是否注意力到位。',
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
    if (action === 'noop')
      return { type: 'noop', note: obj.note || 'noop' }
    if (action === 'ask_user')
      return {
        type: 'ask_user',
        prompt: obj.note || input.heuristic.prompt,
      }
    // map dispatch_* back through heuristic with synthetic text
    if (action === 'dispatch_mainInfer_B' && input.intro.inferKey) {
      return heuristicIntent({
        userText: '换方向 排除这条',
        intro: input.intro,
      })
    }
    if (action.startsWith('dispatch_')) {
      const job = action.replace('dispatch_', '') as DeskJob
      const synth =
        job === 'peek'
          ? '再 peek'
          : job === 'query'
            ? '阶段A'
            : job === 'mainInfer'
              ? '主推理'
              : '重跑决策'
      return heuristicIntent({ userText: synth, intro: input.intro })
    }
  } catch {
    /* fall through */
  }
  return input.heuristic
}

export async function runComposerTurn(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  sealItems: Parameters<typeof runAutoFlow>[0]['sealItems']
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const intro = detectIntroducedIo()
  const epoch = useAttentionIo.getState().intentSessionEpoch
  let intent = heuristicIntent({ userText: input.question, intro })
  if (intent.type === 'ask_user' && input.question.trim()) {
    input.onProgress?.(
      `意图路由 · 轻量 LLM（会话 epoch=${epoch}）…`,
    )
    intent = await refineIntentWithLlm({
      userText: input.question,
      intro,
      heuristic: intent,
    })
  }

  useAttentionIo.getState().pushIntentDeskLog({
    question: input.question,
    action: intent.type,
    note:
      intent.type === 'ask_user'
        ? intent.prompt
        : intent.type === 'noop'
          ? intent.note
          : intent.type === 'dispatch'
            ? `dispatch×${intent.packages.length}`
            : `auto_flow · epoch=${epoch}`,
  })

  if (intent.type === 'ask_user') {
    useAttentionIo.getState().setDeskPrompt(`写信台 · ${intent.prompt}`)
    return { ok: false, answer: '', note: `ask_user · ${intent.prompt}` }
  }
  if (intent.type === 'noop') {
    return { ok: true, answer: '', note: intent.note }
  }
  if (intent.type === 'auto_flow') {
    return runAutoFlow({
      question: input.question,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
    })
  }

  // dispatch
  const q =
    input.question.trim() ||
    intent.packages[0]?.question ||
    ''
  const packages = intent.packages.map((p) => ({
    ...p,
    question: p.question.trim() || q,
  }))
  return askDeepSeekWithLetterDesk({
    question: q,
    packages,
    bookIndex: input.bookIndex,
    docId: input.bookIndex.docId,
    onProgress: input.onProgress,
  })
}
