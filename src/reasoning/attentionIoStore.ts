/**
 * 评论层注意力 + 写信台递交确认（Q / 工种 / 版本）→ WM 包。
 * 几何：决策/主推理 = 评论同构同心外球（见 surfaceGeometry shell scales）。
 */

import { create } from 'zustand'
import {
  inferKeyOf,
  queryKeyOfQuestion,
  type InferPathRaw,
} from './inferPath'
import {
  deliveryId,
  type DeskDeliveryLink,
} from './deskDelivery'

export type KeyKind = 'query' | 'brief' | 'book' | 'delta' | 'infer' | 'other'

/** 写信台工种；都不选 = peek（换 I/O） */
export type DeskJob = 'peek' | 'query' | 'decide' | 'supervise' | 'mainInfer'
export type { DeskDeliveryJob, DeskDeliveryLink } from './deskDelivery'

export interface AttentionRow {
  key: string
  kind: KeyKind
  text: string
}

export interface AttentionStep {
  id: string
  deltaKey: string
  label: string
  premiseKeys: string[]
  input: AttentionRow[]
  output: AttentionRow[]
  /** 本步绑定的提问（问题域） */
  question: string
  createdAt: number
}

export interface AttentionEdge {
  id: string
  fromKey: string
  toKey: string
  stepId: string
  bondId?: string
}

/**
 * 主推理边：bookKey──(inferKey)──bookKey
 * inferKey = rationale 落账（类 briefKey）；UI 中桥，点开 = 左 in｜右 out 哈希异同
 */
export interface InferEdge {
  id: string
  inferKey: string
  /** 本步全部材料门（≥1；单门独自 / 二元 / 并肩） */
  bookKeys: string[]
  /** UI 连线端：单门时 from===to；多门时为首尾 */
  fromBookKey: string
  toBookKey: string
  rationale: string
  /** 哈希窗左（in）：材料摘录 + Q */
  leftText: string
  /** 哈希窗右（out）：本步 rationale */
  rightText: string
  question: string
  /** 路径回指成立后才有；settle 时一并铸 */
  queryKey: string
  pathIndex: number
  stepIndex: number
  /**
   * 落账时序序号（单调递增）。
   * 只标记进 LTM 的次序，便于查看/撤销；≠ 已调度进 WM，≠ 已钉注意力。
   */
  settleSeq: number
  createdAt: number
}

/** 现 queryKey ──增量边──► 旧 queryKey（复用采纳） */
export interface QueryReuseLink {
  id: string
  fromQueryKey: string
  toQueryKey: string
  question: string
  oldQuestion: string
  rationale: string
  /** 被采纳路径上的 inferKey */
  inferKeys: string[]
  /** 复用落账时序序号（与 InferEdge.settleSeq 同一计数器） */
  settleSeq: number
  createdAt: number
}

/** 评论层「注意力切换」后的确认草稿（未确认前不进写信台） */
export interface DeskConfirmDraft {
  edgeId: string
  qDraft: string
  /** 历史 Q 灰色补全（点才采纳） */
  qGhost: string | null
  job: DeskJob
  /** 0 = 最新 head；更大 = 更旧版本索引 */
  versionIndex: number
}

/** 确认后的写信台薄指令（门牌+工种+Q；正文由台 fetch，不在此打包） */
export interface LetterDeskPackage {
  id: string
  edgeId: string
  /** 种子门牌 */
  bookKey: string
  briefKey: string
  question: string
  job: DeskJob
  versionIndex: number
  createdAt: number
  /** @deprecated 正文应台侧 fetch；保留空串兼容 UI */
  bookText?: string
  briefText?: string
  /** mainInfer 排除玩法；缺省走 A（失败 ι→Q）或空 */
  excludeMode?: 'A' | 'B'
  /** 玩法 B：要排除的 inferKey[] */
  excludeInferKeys?: string[]
  /** decide：只压这些 briefKey（续滚）；缺省则 seed+同 Q 历史 */
  onlyBriefKeys?: string[]
}

/** 意图路由沿革 · 台侧记录（≠ 注意力窗 I/O） */
export interface IntentDeskLogEntry {
  id: string
  at: number
  sessionEpoch: number
  question: string
  action: string
  note: string
}

export interface LetterDeskPickup {
  packages: LetterDeskPackage[]
  edgeIds: string[]
  bookKeys: string[]
  briefKeys: string[]
  pairs: Array<{
    edgeId: string
    bookKey: string
    briefKey: string
    bookText: string
    briefText: string
    question: string
    job: DeskJob
  }>
}

/** bookKey → 曾用过的提问原文（倒查排除问法） */
function queryKeyOf(question: string): string {
  return queryKeyOfQuestion(question)
}

/** 显式「切换注意力」钉住；≠ 仅打开查看 */
export type PinnedAttention =
  | { kind: 'edge'; edgeId: string; label: string }
  | { kind: 'infer'; inferKey: string }
  | { kind: 'query'; queryKey: string }

interface AttentionIoState {
  steps: AttentionStep[]
  edges: AttentionEdge[]
  /** 主推理哈希边 book──(inferKey)──book */
  inferEdges: InferEdge[]
  selectedEdgeId: string | null
  selectedInferKey: string | null
  /** 点开 ι 时所在页：展开面板挂这里（与 book 哪一页无关，只防双开） */
  selectedInferHostStrand: number | null
  selectedQueryKey: string | null
  /** 钉住的注意力窗（非第一步）；打开窗不会自动写入 */
  pinnedAttention: PinnedAttention | null
  /** 正在评论层确认的草稿（点注意力切换打开） */
  confirmDraft: DeskConfirmDraft | null
  /** 已确认、待/已投递写信台 */
  deskPackages: LetterDeskPackage[]
  graphOpen: boolean
  lastStatus: string | null
  /**
   * 写信台给人看的提示条（单问安全阀触顶等）。
   * 不进注意力窗 steps/edges。
   */
  deskPrompt: string | null
  /**
   * 意图↔台 调度沿革（保留）；禁止当注意力窗 I/O 写入。
   */
  intentDeskLog: IntentDeskLogEntry[]
  /** 意图会话代数：进过 mainInfer 后 +1，下一轮意图 LLM 当新会话 */
  intentSessionEpoch: number
  /** @deprecated 用 deskPackages；保留兼容 chip 高亮 */
  wmEdgeIds: string[]
  /** 沿革：bookKey → 提问原文[]（主推理倒查排除问法） */
  bookKeyToQuestions: Record<string, string[]>
  questionToBookKeys: Record<string, string[]>
  questionToBriefKeys: Record<string, string[]>
  /** 已落账 queryKey → 该问曾挂 briefKey[]（阶段 A→B 容器 join） */
  queryKeyToBriefKeys: Record<string, string[]>
  /** 已落账 queryKey → 问原文（仅路径回指后） */
  settledQueries: Record<string, string>
  /** 复用增量边：现问 → 旧问 */
  queryReuseLinks: QueryReuseLink[]
  /**
   * 下一笔落账用的时序序号（从 1 起）。
   * 调度（隐→显）与注意力切换分轨；本计数只服务 LTM 落账次序。
   */
  nextSettleSeq: number
  /** 写信台递送有向边：fromKeys ──► toKey（尖 = 递送 key） */
  deskDeliveries: DeskDeliveryLink[]
  recordDeskDelivery: (input: {
    job: DeskDeliveryLink['job']
    fromKeys: string[]
    toKey: string
    stepId?: string
  }) => void
  pushPeekStep: (input: {
    question: string
    items: Array<{
      key: string
      brief: string
      briefKey?: string
      bookText?: string
      bondId?: string
    }>
    mode?: 'cold' | 'hot'
  }) => string
  pushFlashStep: (input: {
    question: string
    items: Array<{
      key: string
      brief: string
      rationale?: string
      briefKey?: string
      bookText?: string
      bondId?: string
    }>
    answer?: string
  }) => string
  attachBondIds: (
    stepId: string,
    map: Array<{ bookKey: string; bondId: string }>,
  ) => void
  openEdge: (edgeId: string) => void
  openInferEdge: (inferKey: string, hostStrand?: number) => void
  openQueryKey: (queryKey: string) => void
  closeAttention: () => void
  /** 打开确认（不立刻进写信台） */
  beginAttentionSwitch: (edgeId: string) => void
  pinAttentionEdge: (edgeId: string) => void
  pinAttentionInfer: (inferKey: string) => void
  pinAttentionQuery: (queryKey: string) => void
  unpinAttention: () => void
  /** 打开钉住的窗（UI 跳转）；不改变钉住状态 */
  focusPinnedAttention: () => void
  cancelConfirm: () => void
  setConfirmQDraft: (text: string) => void
  acceptQGhost: () => void
  setConfirmJob: (job: DeskJob) => void
  setConfirmVersion: (index: number) => void
  /** 确认 → 写入 deskPackages；job=peek 只标记需换贴 */
  commitConfirmToDesk: () => boolean
  removeDeskPackage: (id: string) => void
  clearDesk: () => void
  getLetterDeskPickup: () => LetterDeskPickup
  listHistoricQuestions: () => string[]
  listVersionsForEdge: (edgeId: string) => Array<{
    briefKey: string
    briefText: string
    question: string
    stepId: string
  }>
  suggestQGhost: (prefix: string) => string | null
  listBriefKeysForQuestion: (question: string) => string[]
  listBookKeysForQuestion: (question: string) => string[]
  listQuestionsForBookKeys: (
    bookKeys: string[],
  ) => Array<{ queryKey: string; qText: string }>
  listInferEdgesForBookKeys: (bookKeys: string[]) => InferEdge[]
  /**
   * 主推理 out 落账：每步哈希直连 + 铸 inferKey；
   * 同时铸 queryKey（路径回指成立）。
   */
  settleInferPaths: (input: {
    question: string
    paths: InferPathRaw[]
    bookTexts?: Record<string, string>
  }) => { queryKey: string; inferKeys: string[] }
  /**
   * 复用闸通过：铸现 queryKey，增量边 → 旧 queryKey，显影旧 infer 边（不新开主推理）。
   */
  adoptReusePath: (input: {
    question: string
    oldQueryKey: string
    rationale: string
  }) => {
    queryKey: string
    oldQueryKey: string
    inferKeys: string[]
  } | null
  setGraphOpen: (open: boolean) => void
  setLastStatus: (msg: string | null) => void
  /** 写信台提示（安全阀 / 台监）；不写注意力窗 */
  setDeskPrompt: (msg: string | null) => void
  clearDeskPrompt: () => void
  /** 意图↔台记录：保留；不进 steps/edges */
  pushIntentDeskLog: (input: {
    question: string
    action: string
    note: string
  }) => void
  /** 本问已进过主推理 → 换新意图会话 */
  bumpIntentSessionAfterMainInfer: (reason?: string) => void
  clearAll: () => void
  /** 兼容旧调用 */
  toggleWm: (edgeId: string) => void
  setWm: (edgeId: string, on: boolean) => void
  clearWm: () => void
}

function sid(): string {
  return `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

function pairText(
  steps: AttentionStep[],
  edge: AttentionEdge,
  versionIndex: number,
): { bookText: string; briefText: string; briefKey: string; question: string } {
  const versions: AttentionStep[] = []
  for (const st of steps) {
    const hasBook = st.input.some(
      (r) => r.kind === 'book' && r.key === edge.fromKey,
    )
    if (hasBook) versions.push(st)
  }
  versions.sort((a, b) => b.createdAt - a.createdAt)
  const step = versions[versionIndex] ?? versions[0]
  const bookText =
    step?.input.find((r) => r.kind === 'book' && r.key === edge.fromKey)
      ?.text ?? ''
  const out =
    step?.output.find((r) => r.kind === 'brief' || r.kind === 'delta') ??
    step?.output.find((r) => r.key === edge.toKey)
  return {
    bookText,
    briefText: out?.text ?? '',
    briefKey: out?.key ?? edge.toKey,
    question: step?.question ?? '',
  }
}

export const useAttentionIo = create<AttentionIoState>((set, get) => ({
  steps: [],
  edges: [],
  inferEdges: [],
  selectedEdgeId: null,
  selectedInferKey: null,
  selectedInferHostStrand: null,
  selectedQueryKey: null,
  pinnedAttention: null,
  confirmDraft: null,
  deskPackages: [],
  graphOpen: true,
  lastStatus: null,
  deskPrompt: null,
  intentDeskLog: [],
  intentSessionEpoch: 0,
  wmEdgeIds: [],
  bookKeyToQuestions: {},
  questionToBookKeys: {},
  questionToBriefKeys: {},
  queryKeyToBriefKeys: {},
  settledQueries: {},
  queryReuseLinks: [],
  nextSettleSeq: 1,
  deskDeliveries: [],

  recordDeskDelivery: ({ job, fromKeys, toKey, stepId }) => {
    const to = toKey.trim()
    if (!to) return
    const from = [
      ...new Set(fromKeys.map((k) => k.trim()).filter(Boolean)),
    ].filter((k) => k !== to)
    if (from.length === 0) return
    const settleSeq = get().nextSettleSeq
    const link: DeskDeliveryLink = {
      id: deliveryId(job, to, settleSeq),
      job,
      fromKeys: from,
      toKey: to,
      stepId,
      settleSeq,
      createdAt: Date.now(),
    }
    set((s) => ({
      deskDeliveries: [...s.deskDeliveries, link],
      nextSettleSeq: settleSeq + 1,
    }))
  },

  pushPeekStep: ({ question, items, mode = 'cold' }) => {
    const id = sid()
    const deltaKey =
      items.map((it) => it.briefKey || `brief:${it.key}`).join('|') ||
      `peek_${id}`
    const input: AttentionRow[] = [
      { key: 'Q_now', kind: 'query', text: question },
      ...items.map((it) => ({
        key: it.key,
        kind: 'book' as const,
        text: (it.bookText || '').trim() || `bookKey ${it.key}`,
      })),
    ]
    const output: AttentionRow[] = items.map((it) => ({
      key: it.briefKey || `brief:${it.key}`,
      kind: 'brief' as KeyKind,
      text: it.brief,
    }))
    const edges: AttentionEdge[] = items.map((it) => ({
      id: `${id}_${it.key}`,
      fromKey: it.key,
      toKey: it.briefKey || `brief:${it.key}`,
      stepId: id,
      bondId: it.bondId,
    }))
    const step: AttentionStep = {
      id,
      deltaKey,
      label:
        mode === 'cold'
          ? `peek · 冷启 · ${items.length} 门贴`
          : `peek · 扩搜 · ${items.length} 门贴`,
      premiseKeys: items.map((it) => it.key),
      input,
      output,
      question,
      createdAt: Date.now(),
    }
    set((s) => {
      const bookKeyToQuestions = { ...s.bookKeyToQuestions }
      const questionToBookKeys = { ...s.questionToBookKeys }
      const questionToBriefKeys = { ...s.questionToBriefKeys }
      const qBooks = new Set(questionToBookKeys[question] ?? [])
      const qBriefs = new Set(questionToBriefKeys[question] ?? [])
      for (const it of items) {
        qBooks.add(it.key)
        const bq = new Set(bookKeyToQuestions[it.key] ?? [])
        bq.add(question)
        bookKeyToQuestions[it.key] = [...bq]
        if (it.briefKey) qBriefs.add(it.briefKey)
      }
      questionToBookKeys[question] = [...qBooks]
      questionToBriefKeys[question] = [...qBriefs]
      return {
        steps: [...s.steps, step],
        edges: [...s.edges, ...edges],
        selectedEdgeId: null,
        graphOpen: true,
        bookKeyToQuestions,
        questionToBookKeys,
        questionToBriefKeys,
      }
    })
    for (const it of items) {
      const briefKey = it.briefKey || `brief:${it.key}`
      get().recordDeskDelivery({
        job: 'peek',
        fromKeys: [it.key],
        toKey: briefKey,
        stepId: id,
      })
    }
    return id
  },

  pushFlashStep: ({ question, items }) =>
    get().pushPeekStep({ question, items, mode: 'cold' }),

  attachBondIds: (stepId, map) => {
    const byBook = new Map(map.map((m) => [m.bookKey, m.bondId]))
    set((s) => ({
      edges: s.edges.map((e) => {
        if (e.stepId !== stepId) return e
        const bondId = byBook.get(e.fromKey)
        return bondId ? { ...e, bondId } : e
      }),
    }))
  },

  openEdge: (edgeId) =>
    set({
      selectedEdgeId: edgeId,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
    }),
  openInferEdge: (inferKey, hostStrand) =>
    set({
      selectedInferKey: inferKey,
      selectedInferHostStrand:
        typeof hostStrand === 'number' ? hostStrand : null,
      selectedEdgeId: null,
      selectedQueryKey: null,
    }),
  openQueryKey: (queryKey) =>
    set({
      selectedQueryKey: queryKey,
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
    }),
  closeAttention: () =>
    set({
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
      confirmDraft: null,
    }),

  beginAttentionSwitch: (edgeId) => {
    const s = get()
    const edge = s.edges.find((e) => e.id === edgeId)
    if (!edge) return
    const step = s.steps.find((st) => st.id === edge.stepId)
    const q = step?.question ?? ''
    set({
      selectedEdgeId: edgeId,
      confirmDraft: {
        edgeId,
        qDraft: q,
        qGhost: null,
        job: 'peek',
        versionIndex: 0,
      },
    })
  },


  pinAttentionEdge: (edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId)
    if (!edge) return
    const label = edge.toKey || edge.fromKey || edgeId
    set({
      pinnedAttention: { kind: 'edge', edgeId, label },
      selectedEdgeId: edgeId,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
    })
  },
  pinAttentionInfer: (inferKey) => {
    if (!get().inferEdges.some((e) => e.inferKey === inferKey)) return
    set({
      pinnedAttention: { kind: 'infer', inferKey },
      selectedInferKey: inferKey,
      selectedEdgeId: null,
      selectedQueryKey: null,
    })
  },
  pinAttentionQuery: (queryKey) => {
    const qk = queryKey.trim()
    if (!qk) return
    set({
      pinnedAttention: { kind: 'query', queryKey: qk },
      selectedQueryKey: qk,
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
    })
  },
  unpinAttention: () => set({ pinnedAttention: null }),
  focusPinnedAttention: () => {
    const pin = get().pinnedAttention
    if (!pin) return
    if (pin.kind === 'edge') get().openEdge(pin.edgeId)
    else if (pin.kind === 'infer') get().openInferEdge(pin.inferKey)
    else get().openQueryKey(pin.queryKey)
  },
  cancelConfirm: () => set({ confirmDraft: null }),

  setConfirmQDraft: (text) => {
    const ghost = get().suggestQGhost(text)
    set((s) =>
      s.confirmDraft
        ? {
            confirmDraft: {
              ...s.confirmDraft,
              qDraft: text,
              qGhost:
                ghost &&
                ghost !== text &&
                ghost.toLowerCase().startsWith(text.toLowerCase())
                  ? ghost
                  : null,
            },
          }
        : {},
    )
  },

  acceptQGhost: () => {
    set((s) => {
      if (!s.confirmDraft?.qGhost) return {}
      return {
        confirmDraft: {
          ...s.confirmDraft,
          qDraft: s.confirmDraft.qGhost,
          qGhost: null,
        },
      }
    })
  },

  setConfirmJob: (job) => {
    set((s) =>
      s.confirmDraft
        ? { confirmDraft: { ...s.confirmDraft, job } }
        : {},
    )
  },

  setConfirmVersion: (index) => {
    set((s) =>
      s.confirmDraft
        ? {
            confirmDraft: {
              ...s.confirmDraft,
              versionIndex: Math.max(0, index),
            },
          }
        : {},
    )
  },

  commitConfirmToDesk: () => {
    const s = get()
    const draft = s.confirmDraft
    if (!draft) return false
    const edge = s.edges.find((e) => e.id === draft.edgeId)
    if (!edge) return false
    const texts = pairText(s.steps, edge, draft.versionIndex)
    const q = draft.qDraft.trim() || texts.question
    const pkg: LetterDeskPackage = {
      id: sid(),
      edgeId: edge.id,
      bookKey: edge.fromKey,
      briefKey: texts.briefKey,
      question: q,
      job: draft.job,
      versionIndex: draft.versionIndex,
      createdAt: Date.now(),
    }
    set((st) => ({
      deskPackages: [
        ...st.deskPackages.filter((p) => p.edgeId !== edge.id),
        pkg,
      ],
      wmEdgeIds: st.wmEdgeIds.includes(edge.id)
        ? st.wmEdgeIds
        : [...st.wmEdgeIds, edge.id],
      confirmDraft: null,
      lastStatus:
        draft.job === 'peek'
          ? '已确认 · 工种=再 peek（当前 I/O 待换贴）→ 写信台'
          : `已确认 · ${draft.job} → 写信台`,
    }))
    return true
  },

  removeDeskPackage: (id) => {
    set((s) => {
      const gone = s.deskPackages.find((p) => p.id === id)
      const deskPackages = s.deskPackages.filter((p) => p.id !== id)
      const wmEdgeIds = gone
        ? s.wmEdgeIds.filter((e) => e !== gone.edgeId)
        : s.wmEdgeIds
      return { deskPackages, wmEdgeIds }
    })
  },

  clearDesk: () => set({ deskPackages: [], wmEdgeIds: [] }),

  getLetterDeskPickup: () => {
    const packages = get().deskPackages
    return {
      packages,
      edgeIds: packages.map((p) => p.edgeId),
      bookKeys: packages.map((p) => p.bookKey),
      briefKeys: packages.map((p) => p.briefKey),
      pairs: packages.map((p) => ({
        edgeId: p.edgeId,
        bookKey: p.bookKey,
        briefKey: p.briefKey,
        bookText: p.bookText ?? '',
        briefText: p.briefText ?? '',
        question: p.question,
        job: p.job,
      })),
    }
  },

  listBriefKeysForQuestion: (question) => {
    const q = question.trim()
    return get().questionToBriefKeys[q] ?? []
  },

  listBookKeysForQuestion: (question) => {
    const q = question.trim()
    return get().questionToBookKeys[q] ?? []
  },

  listQuestionsForBookKeys: (bookKeys) => {
    const s = get()
    const seen = new Set<string>()
    const out: Array<{ queryKey: string; qText: string }> = []
    for (const bk of bookKeys) {
      for (const q of s.bookKeyToQuestions[bk] ?? []) {
        if (seen.has(q)) continue
        seen.add(q)
        out.push({ queryKey: queryKeyOf(q), qText: q })
      }
    }
    return out
  },

  listInferEdgesForBookKeys: (bookKeys) => {
    const setKeys = new Set(bookKeys)
    return get().inferEdges.filter(
      (e) =>
        setKeys.has(e.fromBookKey) ||
        setKeys.has(e.toBookKey) ||
        e.bookKeys.some((k) => setKeys.has(k)),
    )
  },

  settleInferPaths: ({ question, paths, bookTexts = {} }) => {
    const q = question.trim()
    const queryKey = queryKeyOfQuestion(q)
    const minted: InferEdge[] = []
    const inferKeys: string[] = []
    const now = Date.now()
    let seq = get().nextSettleSeq

    paths.forEach((path, pathIndex) => {
      path.steps.forEach((step, stepIndex) => {
        const keys = [...new Set(step.bookKeys.map((k) => k.trim()).filter(Boolean))]
        if (keys.length < 1) return
        const fromBookKey = keys[0]!
        const toBookKey = keys[keys.length - 1]!
        const rationale = step.rationale.trim()
        const inferKey = inferKeyOf(rationale)
        const materialBlocks = keys.map((bk, i) => {
          const label =
            keys.length === 1
              ? '单门 · 原文'
              : keys.length === 2
                ? `bookKey ${i === 0 ? 'A' : 'B'} · 原文`
                : `bookKey[${i}] · 原文`
          const T = (bookTexts[bk] ?? '').slice(0, 400)
          return [`【${label}】\`${bk}\``, T || '（无 T）'].join('\n')
        })
        const leftText = [`Q_now：${q}`, '', ...materialBlocks].join('\n\n')
        const outLabel =
          keys.length === 1
            ? '【依据 · 单门如何独自走向 Q】'
            : keys.length === 2
              ? '【依据 · 两材料如何互撑 / 如何走向 Q】'
              : '【依据 · 多门并肩如何走向 Q】'
        minted.push({
          id: `inf_${now.toString(36)}_${pathIndex}_${stepIndex}`,
          inferKey,
          bookKeys: keys,
          fromBookKey,
          toBookKey,
          rationale,
          leftText,
          rightText: [outLabel, rationale].join('\n'),
          question: q,
          queryKey,
          pathIndex,
          stepIndex,
          settleSeq: seq++,
          createdAt: now,
        })
        inferKeys.push(inferKey)
      })
    })

    set((s) => {
      const bookKeyToQuestions = { ...s.bookKeyToQuestions }
      const questionToBookKeys = { ...s.questionToBookKeys }
      const qBooks = new Set(questionToBookKeys[q] ?? [])
      for (const e of minted) {
        for (const bk of e.bookKeys) {
          qBooks.add(bk)
          const set = new Set(bookKeyToQuestions[bk] ?? [])
          set.add(q)
          bookKeyToQuestions[bk] = [...set]
        }
      }
      questionToBookKeys[q] = [...qBooks]
      const briefsForQ = s.questionToBriefKeys[q] ?? []
      const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
      if (briefsForQ.length > 0) {
        queryKeyToBriefKeys[queryKey] = [
          ...new Set([
            ...(queryKeyToBriefKeys[queryKey] ?? []),
            ...briefsForQ,
          ]),
        ]
      }
      // 同 inferKey 覆盖更新（内容哈希碰撞则替换）
      const byIk = new Map(s.inferEdges.map((e) => [e.inferKey, e]))
      for (const e of minted) byIk.set(e.inferKey, e)
      return {
        inferEdges: [...byIk.values()],
        settledQueries: { ...s.settledQueries, [queryKey]: q },
        queryKeyToBriefKeys,
        nextSettleSeq: seq,
        // 落账 = LTM 缓冲（可撤销），≠ 调度进 WM，≠ 钉注意力
        graphOpen: true,
        lastStatus: `主推理落账 · queryKey=${queryKey} · ${minted.length} 条 inferKey 边 · seq→${seq - 1}`,
      }
    })

    // 本问已进主推理 → 意图窗立刻换新会话（不碰注意力窗 I/O）
    get().bumpIntentSessionAfterMainInfer(
      `主推理落账后换新意图 · qk=${queryKey}`,
    )

    for (const e of minted) {
      get().recordDeskDelivery({
        job: 'mainInfer',
        fromKeys: e.bookKeys,
        toKey: e.inferKey,
      })
    }
    if (inferKeys.length > 0) {
      get().recordDeskDelivery({
        job: 'mainInfer',
        fromKeys: inferKeys,
        toKey: queryKey,
      })
    }
    return { queryKey, inferKeys }
  },

  adoptReusePath: ({ question, oldQueryKey, rationale }) => {
    const q = question.trim()
    if (!q || !oldQueryKey.trim()) return null
    const queryKey = queryKeyOfQuestion(q)
    const oldEdges = get().inferEdges.filter(
      (e) => e.queryKey === oldQueryKey,
    )
    if (oldEdges.length === 0) return null
    const inferKeys = oldEdges.map((e) => e.inferKey)
    const oldQuestion =
      get().settledQueries[oldQueryKey] ?? oldEdges[0]?.question ?? ''
    const settleSeq = get().nextSettleSeq
    const link: QueryReuseLink = {
      id: `reuse_${Date.now().toString(36)}`,
      fromQueryKey: queryKey,
      toQueryKey: oldQueryKey,
      question: q,
      oldQuestion,
      rationale: rationale.trim() || '复用闸：旧路径能回 Q_now',
      inferKeys,
      settleSeq,
      createdAt: Date.now(),
    }

    set((s) => {
      const bookKeyToQuestions = { ...s.bookKeyToQuestions }
      const questionToBookKeys = { ...s.questionToBookKeys }
      const qBooks = new Set(questionToBookKeys[q] ?? [])
      for (const e of oldEdges) {
        qBooks.add(e.fromBookKey)
        qBooks.add(e.toBookKey)
        const a = new Set(bookKeyToQuestions[e.fromBookKey] ?? [])
        a.add(q)
        bookKeyToQuestions[e.fromBookKey] = [...a]
        const b = new Set(bookKeyToQuestions[e.toBookKey] ?? [])
        b.add(q)
        bookKeyToQuestions[e.toBookKey] = [...b]
      }
      questionToBookKeys[q] = [...qBooks]
      const links = [
        ...s.queryReuseLinks.filter(
          (l) =>
            !(
              l.fromQueryKey === queryKey && l.toQueryKey === oldQueryKey
            ),
        ),
        link,
      ]
      const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
      const fromOld = s.queryKeyToBriefKeys[oldQueryKey] ?? []
      const fromQ = s.questionToBriefKeys[q] ?? []
      queryKeyToBriefKeys[queryKey] = [
        ...new Set([
          ...(queryKeyToBriefKeys[queryKey] ?? []),
          ...fromOld,
          ...fromQ,
        ]),
      ]
      return {
        settledQueries: { ...s.settledQueries, [queryKey]: q },
        queryReuseLinks: links,
        questionToBookKeys,
        bookKeyToQuestions,
        queryKeyToBriefKeys,
        nextSettleSeq: settleSeq + 1,
        // 复用落账同理：只进 LTM 缓冲，不自动钉注意力 / 不自动算已调度进 WM
        graphOpen: true,
        lastStatus:
          queryKey === oldQueryKey
            ? `复用 · 同问已有路径 · 显影 ${inferKeys.length} 条 ι · #${settleSeq}`
            : `复用采纳 · ${queryKey} ──► ${oldQueryKey} · ${inferKeys.length} 条 ι · #${settleSeq}`,
      }
    })

    get().recordDeskDelivery({
      job: 'reuse',
      fromKeys: [oldQueryKey],
      toKey: queryKey,
    })
    return { queryKey, oldQueryKey, inferKeys }
  },

  listHistoricQuestions: () => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const st of get().steps) {
      const q = st.question.trim()
      if (!q || seen.has(q)) continue
      seen.add(q)
      out.push(q)
    }
    return out
  },

  listVersionsForEdge: (edgeId) => {
    const edge = get().edges.find((e) => e.id === edgeId)
    if (!edge) return []
    const rows: Array<{
      briefKey: string
      briefText: string
      question: string
      stepId: string
    }> = []
    const steps = [...get().steps].sort((a, b) => b.createdAt - a.createdAt)
    for (const st of steps) {
      if (!st.input.some((r) => r.kind === 'book' && r.key === edge.fromKey))
        continue
      const out = st.output.find((r) => r.kind === 'brief' || r.kind === 'delta')
      if (!out) continue
      rows.push({
        briefKey: out.key,
        briefText: out.text,
        question: st.question,
        stepId: st.id,
      })
    }
    return rows
  },

  suggestQGhost: (prefix) => {
    const p = prefix.trim().toLowerCase()
    if (!p) return null
    const hist = get().listHistoricQuestions()
    const hit = hist.find(
      (q) =>
        q.toLowerCase().startsWith(p) && q.toLowerCase() !== p,
    )
    return hit ?? null
  },

  setGraphOpen: (open) => set({ graphOpen: open }),
  setLastStatus: (msg) => set({ lastStatus: msg }),
  setDeskPrompt: (msg) => set({ deskPrompt: msg }),
  clearDeskPrompt: () => set({ deskPrompt: null }),
  pushIntentDeskLog: ({ question, action, note }) => {
    const entry: IntentDeskLogEntry = {
      id: sid(),
      at: Date.now(),
      sessionEpoch: get().intentSessionEpoch,
      question: question.trim().slice(0, 240),
      action,
      note: note.slice(0, 400),
    }
    set((s) => ({
      intentDeskLog: [...s.intentDeskLog.slice(-79), entry],
    }))
  },
  bumpIntentSessionAfterMainInfer: (reason) => {
    const next = get().intentSessionEpoch + 1
    set({
      intentSessionEpoch: next,
      lastStatus:
        reason ||
        `意图会话已换新 · epoch=${next}（本问已进过主推理）`,
    })
    get().pushIntentDeskLog({
      question: '',
      action: 'intent_session_bump',
      note: reason || `epoch→${next} · after mainInfer`,
    })
  },
  clearAll: () =>
    set({
      steps: [],
      edges: [],
      inferEdges: [],
      selectedEdgeId: null,
      selectedInferKey: null,
      selectedInferHostStrand: null,
      selectedQueryKey: null,
      pinnedAttention: null,
      confirmDraft: null,
      deskPackages: [],
      wmEdgeIds: [],
      lastStatus: null,
      deskPrompt: null,
      intentDeskLog: [],
      intentSessionEpoch: 0,
      bookKeyToQuestions: {},
      questionToBookKeys: {},
      questionToBriefKeys: {},
      queryKeyToBriefKeys: {},
      settledQueries: {},
      queryReuseLinks: [],
      deskDeliveries: [],
      nextSettleSeq: 1,
    }),

  toggleWm: (edgeId) => {
    const s = get()
    if (s.wmEdgeIds.includes(edgeId)) {
      set({
        wmEdgeIds: s.wmEdgeIds.filter((id) => id !== edgeId),
        deskPackages: s.deskPackages.filter((p) => p.edgeId !== edgeId),
        confirmDraft:
          s.confirmDraft?.edgeId === edgeId ? null : s.confirmDraft,
      })
      return
    }
    get().beginAttentionSwitch(edgeId)
  },

  setWm: (edgeId, on) => {
    if (on) get().beginAttentionSwitch(edgeId)
    else get().toggleWm(edgeId)
  },

  clearWm: () => get().clearDesk(),
}))

export function getSelectedEdge(): AttentionEdge | null {
  const s = useAttentionIo.getState()
  if (!s.selectedEdgeId) return null
  return s.edges.find((e) => e.id === s.selectedEdgeId) ?? null
}
