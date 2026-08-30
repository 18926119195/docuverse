/**
 * 注意力焦点：
 * - 旧：同 Q 整条路径（resolveFocusedQueryKey）
 * - 新：点 brief / ι / qk → 只亮与之直接连线的一跳邻域，其余降亮
 */

import type {
  AttentionEdge,
  InferEdge,
  QueryReuseLink,
} from './attentionIoStore'
import type { DeskDeliveryLink } from './deskDelivery'

export type PathFocusSlice = {
  selectedQueryKey: string | null
  selectedInferKey: string | null
  inferEdges: InferEdge[]
}

/** 当前路径所属 queryKey（点 qk 或点 ι 均可） */
export function resolveFocusedQueryKey(s: PathFocusSlice): string | null {
  if (s.selectedQueryKey) return s.selectedQueryKey
  if (s.selectedInferKey) {
    return (
      s.inferEdges.find((e) => e.inferKey === s.selectedInferKey)?.queryKey ??
      null
    )
  }
  return null
}

export type FocusNeighborhood = {
  hasFocus: boolean
  /** 选中点 + 一跳邻域 key（book/brief/ι/qk） */
  keys: Set<string>
  /** 应亮的 Δ edge id */
  edgeIds: Set<string>
  /** 应亮的 inferKey */
  inferKeys: Set<string>
  /** 应亮的 queryKey */
  queryKeys: Set<string>
}

function booksOfInfer(e: InferEdge): string[] {
  if (e.bookKeys?.length) return e.bookKeys.filter(Boolean)
  return [e.fromBookKey, e.toBookKey].filter(Boolean)
}

/**
 * 点选 briefKey（Δ边）/ inferKey / queryKey 时的一跳邻域。
 * 只沿「画出来的连线」扩一跳，不把同 Q 全部 ι 自动算进来（除非点的是 qk）。
 */
export function resolveFocusNeighborhood(input: {
  selectedEdgeId: string | null
  selectedInferKey: string | null
  selectedQueryKey: string | null
  edges: AttentionEdge[]
  inferEdges: InferEdge[]
  deskDeliveries: DeskDeliveryLink[]
  queryReuseLinks: QueryReuseLink[]
}): FocusNeighborhood {
  const keys = new Set<string>()
  const edgeIds = new Set<string>()
  const inferKeys = new Set<string>()
  const queryKeys = new Set<string>()

  const {
    selectedEdgeId,
    selectedInferKey,
    selectedQueryKey,
    edges,
    inferEdges,
    deskDeliveries,
    queryReuseLinks,
  } = input

  if (!selectedEdgeId && !selectedInferKey && !selectedQueryKey) {
    return { hasFocus: false, keys, edgeIds, inferKeys, queryKeys }
  }

  const seeds = new Set<string>()
  if (selectedQueryKey) {
    seeds.add(selectedQueryKey)
    queryKeys.add(selectedQueryKey)
    keys.add(selectedQueryKey)
  }
  if (selectedInferKey) {
    seeds.add(selectedInferKey)
    inferKeys.add(selectedInferKey)
    keys.add(selectedInferKey)
  }
  if (selectedEdgeId) {
    edgeIds.add(selectedEdgeId)
    const e = edges.find((x) => x.id === selectedEdgeId)
    if (e) {
      seeds.add(e.fromKey)
      seeds.add(e.toKey)
      keys.add(e.fromKey)
      keys.add(e.toKey)
    }
  }

  const knownInfer = new Set(inferEdges.map((e) => e.inferKey))
  const knownQuery = new Set(inferEdges.map((e) => e.queryKey))
  for (const l of queryReuseLinks) {
    knownQuery.add(l.fromQueryKey)
    knownQuery.add(l.toQueryKey)
  }

  const classify = (k: string) => {
    keys.add(k)
    if (knownInfer.has(k)) inferKeys.add(k)
    if (knownQuery.has(k)) queryKeys.add(k)
  }

  const expandFrom = (seed: string) => {
    for (const d of deskDeliveries) {
      if (d.toKey !== seed && !d.fromKeys.includes(seed)) continue
      classify(d.toKey)
      for (const f of d.fromKeys) classify(f)
    }

    for (const e of edges) {
      if (e.fromKey !== seed && e.toKey !== seed) continue
      edgeIds.add(e.id)
      classify(e.fromKey)
      classify(e.toKey)
    }

    for (const ie of inferEdges) {
      const books = booksOfInfer(ie)
      if (
        ie.inferKey !== seed &&
        ie.queryKey !== seed &&
        !books.includes(seed)
      ) {
        continue
      }
      classify(ie.inferKey)
      classify(ie.queryKey)
      for (const b of books) classify(b)
    }

    for (const l of queryReuseLinks) {
      if (l.fromQueryKey !== seed && l.toQueryKey !== seed) continue
      classify(l.fromQueryKey)
      classify(l.toQueryKey)
    }
  }

  for (const seed of [...seeds]) expandFrom(seed)

  // 端点已在邻域内的 Δ 边也亮（材料门上的 brief 桥）
  for (const e of edges) {
    if (keys.has(e.fromKey) || keys.has(e.toKey)) edgeIds.add(e.id)
  }

  return { hasFocus: true, keys, edgeIds, inferKeys, queryKeys }
}

export function keyInFocus(nb: FocusNeighborhood, key: string | null | undefined): boolean {
  if (!nb.hasFocus) return true
  if (!key) return false
  return nb.keys.has(key)
}

export function inferInFocus(
  nb: FocusNeighborhood,
  inferKey: string,
): boolean {
  if (!nb.hasFocus) return true
  return nb.inferKeys.has(inferKey) || nb.keys.has(inferKey)
}

export function queryInFocus(
  nb: FocusNeighborhood,
  queryKey: string,
): boolean {
  if (!nb.hasFocus) return true
  return nb.queryKeys.has(queryKey) || nb.keys.has(queryKey)
}

export function edgeInFocus(nb: FocusNeighborhood, edgeId: string): boolean {
  if (!nb.hasFocus) return true
  return nb.edgeIds.has(edgeId)
}

export function inferKeysForQuery(
  edges: InferEdge[],
  queryKey: string,
): Set<string> {
  const set = new Set<string>()
  for (const e of edges) {
    if (e.queryKey === queryKey) set.add(e.inferKey)
  }
  return set
}

export function bookKeysForQuery(
  edges: InferEdge[],
  queryKey: string,
): Set<string> {
  const set = new Set<string>()
  for (const e of edges) {
    if (e.queryKey !== queryKey) continue
    const keys = e.bookKeys?.length
      ? e.bookKeys
      : [e.fromBookKey, e.toBookKey]
    for (const k of keys) if (k) set.add(k)
  }
  return set
}

/** 复用边是否挂在当前焦点 Q 上 */
export function reuseOnFocusedPath(
  link: QueryReuseLink,
  focusedQk: string | null,
): boolean {
  if (!focusedQk) return true
  return link.fromQueryKey === focusedQk || link.toQueryKey === focusedQk
}

/**
 * 线宽 / 是否虚线 / 透明度。
 * 无焦点：全员可见（中等）。
 * 有焦点：路径内加亮；路径外降亮。
 */
export function pathLineStyle(input: {
  onPath: boolean
  selected: boolean
  hasFocus: boolean
}): { lineWidth: number; dashed: boolean; opacity: number; lit: boolean } {
  if (!input.hasFocus) {
    return { lineWidth: 1.8, dashed: false, opacity: 0.85, lit: true }
  }
  if (input.selected) {
    return { lineWidth: 3.2, dashed: false, opacity: 1, lit: true }
  }
  if (input.onPath) {
    return { lineWidth: 2.4, dashed: false, opacity: 0.95, lit: true }
  }
  return { lineWidth: 1, dashed: true, opacity: 0.22, lit: false }
}
