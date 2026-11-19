/**
 * 台账空位检视（事实层，非意图决策）。
 * 只回答「本问缺哪类增量、相关 key 是谁」；
 * 「下一步调谁」由意图 LLM 根据本账 + 用户话决定（代码仅作 LLM 失败时的兜底）。
 */

import {
  useAttentionIo,
  type DeskJob,
  type LetterDeskPackage,
} from '../reasoning/attentionIoStore'
import { listAllSettledBriefs, mapBriefToBook } from '../reasoning/masterTableMap'
import { listSettledQueryEntries } from './deskEntryGate'

export type GapKind =
  | 'brief'
  | 'neighbour'
  | 'reuse'
  | 'prospect'
  | 'infer'
  | 'path'
  | 'done'

export interface QueryGap {
  kind: GapKind
  /** 给人看的空位说明 */
  reason: string
  /** 因果序上「建议」的工种（供意图 LLM 参考，非强制） */
  suggestedJob: DeskJob | null
  briefKeys: string[]
  bookKeys: string[]
  pathKeys: string[]
  queryKey: string
}

function sid(): string {
  return `gap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function briefsForQuery(
  docId: string,
  queryKey: string,
  question: string,
): string[] {
  const s = useAttentionIo.getState()
  const fromQk = s.queryKeyToBriefKeys[queryKey] ?? []
  const fromQ = s.questionToBriefKeys[question] ?? []
  const merged = [...new Set([...fromQk, ...fromQ])]
  if (merged.length > 0) return merged
  return listAllSettledBriefs(docId).map((b) => b.briefKey)
}

/** 给意图 LLM 的台账摘要（只含事实 + 候选 key） */
export function formatGapLedgerForIntent(gap: QueryGap): string {
  return [
    `queryKey=${gap.queryKey}`,
    `最前空位 kind=${gap.kind}`,
    `说明：${gap.reason}`,
    `建议工种（可改）=${gap.suggestedJob ?? '∅'}`,
    `候选 briefKeys：${gap.briefKeys.slice(0, 24).join(', ') || '∅'}`,
    `候选 bookKeys：${gap.bookKeys.slice(0, 24).join(', ') || '∅'}`,
    `候选 pathKeys：${gap.pathKeys.slice(0, 12).join(', ') || '∅'}`,
  ].join('\n')
}

/**
 * 按因果序找本问第一条空位（事实）。
 * 同问复用同一 queryKey 时：已齐的环跳过。
 */
export function inspectQueryGap(input: {
  docId: string
  queryKey: string
  question: string
}): QueryGap {
  const q = input.question.trim()
  const qk = input.queryKey.trim()
  const s = useAttentionIo.getState()

  const historicOthers = listSettledQueryEntries().filter(
    (e) => e.queryKey !== qk && e.qText.trim().length > 0,
  )
  const neighboursNow = s.neighbours.filter((n) => n.nowQueryKey === qk)
  const briefs = briefsForQuery(input.docId, qk, q)
  const prospects = s.prospects.filter((p) => p.queryKey === qk)
  const inferEdges = s.inferEdges.filter((e) => e.queryKey === qk)
  const paths = s.paths.filter((p) => p.queryKey === qk)
  const reuseLinks = s.queryReuseLinks.filter((l) => l.fromQueryKey === qk)
  const pending = s.pendingPathMatch

  if (historicOthers.length > 0) {
    if (neighboursNow.length === 0) {
      return {
        kind: 'neighbour',
        reason: `有历史问线×${historicOthers.length}，本问尚无 neighbour`,
        suggestedJob: 'query',
        briefKeys: [],
        bookKeys: [],
        pathKeys: [],
        queryKey: qk,
      }
    }
    const historicWithPath = new Set<string>()
    for (const n of neighboursNow) {
      for (const p of s.paths.filter(
        (x) => x.queryKey === n.historicQueryKey,
      )) {
        historicWithPath.add(p.pathKey)
      }
    }
    if (historicWithPath.size > 0 && reuseLinks.length === 0) {
      return {
        kind: 'reuse',
        reason: `neighbour 已指向含 path 的旧问，本问尚未 reuse`,
        suggestedJob: null,
        briefKeys: [],
        bookKeys: [],
        pathKeys: [...historicWithPath],
        queryKey: qk,
      }
    }
  }

  if (briefs.length === 0) {
    return {
      kind: 'brief',
      reason: '本问尚无 brief',
      suggestedJob: 'peek',
      briefKeys: [],
      bookKeys: [],
      pathKeys: [],
      queryKey: qk,
    }
  }

  if (prospects.length === 0) {
    const unread = s.listKeysUnread('decide').filter((k) => briefs.includes(k))
    const weak = s.listKeysNeedingMore('decide').filter((k) =>
      briefs.includes(k),
    )
    const target =
      unread.length > 0 ? unread : weak.length > 0 ? weak : briefs
    return {
      kind: 'prospect',
      reason: `brief×${briefs.length} 已有，本问尚无 prospect`,
      suggestedJob: 'decide',
      briefKeys: target,
      bookKeys: [],
      pathKeys: [],
      queryKey: qk,
    }
  }

  if (inferEdges.length === 0) {
    const bookKeys: string[] = []
    for (const p of prospects) {
      const hit = mapBriefToBook(input.docId, p.briefKey)
      if (hit?.bookKey && !bookKeys.includes(hit.bookKey)) {
        bookKeys.push(hit.bookKey)
      }
    }
    if (bookKeys.length === 0) {
      for (const bk of briefs) {
        const hit = mapBriefToBook(input.docId, bk)
        if (hit?.bookKey && !bookKeys.includes(hit.bookKey)) {
          bookKeys.push(hit.bookKey)
        }
      }
    }
    return {
      kind: 'infer',
      reason: `prospect×${prospects.length} 已有，本问尚无 infer`,
      suggestedJob: 'infer',
      briefKeys: prospects.map((p) => p.briefKey),
      bookKeys,
      pathKeys: [],
      queryKey: qk,
    }
  }

  if (paths.length === 0) {
    const pendingNote =
      pending && pending.queryKey === qk
        ? '（已挂 pending）'
        : '（需人手或跳过→监督）'
    return {
      kind: 'path',
      reason: `infer×${inferEdges.length} 与 prospect 已有，尚无 path ${pendingNote}`,
      suggestedJob: null,
      briefKeys: prospects.map((p) => p.briefKey),
      bookKeys: inferEdges.flatMap((e) => e.bookKeys),
      pathKeys: [],
      queryKey: qk,
    }
  }

  return {
    kind: 'done',
    reason:
      `本问账已齐：prospect×${prospects.length} · infer×${inferEdges.length} · path×${paths.length}` +
      (reuseLinks.length ? ` · reuse×${reuseLinks.length}` : ''),
    suggestedJob: null,
    briefKeys: prospects.map((p) => p.briefKey),
    bookKeys: inferEdges.flatMap((e) => e.bookKeys),
    pathKeys: paths.map((p) => p.pathKey),
    queryKey: qk,
  }
}

/** 空位 → 写信台包（意图 LLM / 兜底选用） */
export function gapToDeskPackages(
  gap: QueryGap,
  question: string,
  jobOverride?: DeskJob | null,
): LetterDeskPackage[] {
  const job = jobOverride ?? gap.suggestedJob
  if (!job) return []
  const q = question.trim()
  const pkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `gap_${gap.kind}_${sid()}`,
    bookKey: gap.bookKeys[0] || '',
    briefKey: gap.briefKeys[0] || '',
    question: q,
    job,
    versionIndex: 0,
    createdAt: Date.now(),
    onlyBriefKeys:
      job === 'decide' && gap.briefKeys.length > 0
        ? gap.briefKeys
        : undefined,
  }
  return [pkg]
}

/**
 * 兜底：意图 LLM 不可用时，按因果序建议动作。
 * 正式路径应由意图 LLM 读台账后决定。
 */
export function fallbackIntentFromGap(
  gap: QueryGap,
  question: string,
): {
  type: 'auto_flow' | 'dispatch' | 'ask_user' | 'show'
  packages?: LetterDeskPackage[]
  prompt?: string
} {
  switch (gap.kind) {
    case 'brief':
    case 'reuse':
      return { type: 'auto_flow' }
    case 'neighbour':
    case 'prospect':
    case 'infer': {
      const packages = gapToDeskPackages(gap, question)
      if (packages.length === 0) return { type: 'auto_flow' }
      return { type: 'dispatch', packages }
    }
    case 'path':
      return {
        type: 'ask_user',
        prompt: `${gap.reason}。请匹配 infer×prospect，或说「跳过匹配」。`,
      }
    case 'done':
      return {
        type: 'show',
        prompt: `空位已齐 · ${gap.reason}。qk=\`${gap.queryKey}\`；不满某环请钉窗或说重跑。`,
      }
    default:
      return { type: 'auto_flow' }
  }
}
