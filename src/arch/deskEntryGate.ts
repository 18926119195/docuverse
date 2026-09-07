/**
 * 入口闸（§1.0.8 M6）：第一步 = 未引入 LLM I/O；
 * 台再判 brief / queryKey（有触发，非盲扫）。
 */

import { useAttentionIo } from '../reasoning/attentionIoStore'
import { docHasAnyBrief } from '../reasoning/masterTableMap'

export type AutoEntryBranch =
  | { kind: 'peek' }
  | { kind: 'stageA_then_brief' }
  | { kind: 'brief_skip_A' }

/**
 * 第一步纯问、已开导航时的台侧分叉。
 * 触发：caller 已确认「未引入 LLM I/O ∧ 要开决策导航」。
 */
export function resolveFirstStepBranch(docId: string): AutoEntryBranch {
  if (!docHasAnyBrief(docId)) {
    return { kind: 'peek' }
  }
  const settled = useAttentionIo.getState().settledQueries
  const hasQueryKey = Object.keys(settled).length > 0
  if (hasQueryKey) return { kind: 'stageA_then_brief' }
  return { kind: 'brief_skip_A' }
}

export function deskHasSettledQueryKeys(): boolean {
  return Object.keys(useAttentionIo.getState().settledQueries).length > 0
}

export function listSettledQueryEntries(): Array<{
  queryKey: string
  qText: string
  parentQueryKey?: string
}> {
  const st = useAttentionIo.getState()
  const settled = st.settledQueries
  const parentOf = st.queryParentOf
  return Object.entries(settled).map(([queryKey, qText]) => ({
    queryKey,
    qText,
    parentQueryKey: parentOf[queryKey],
  }))
}

/**
 * queryLLM 历史池：含各题族的根与深化子问，排除 Q_now 自身。
 * 深化子问会出现在池中，供 neighbour 与父/兄比较。
 */
export function listHistoricQueryEntriesForNeighbour(nowQueryKey?: string): Array<{
  queryKey: string
  qText: string
  parentQueryKey?: string
  familyRole: 'root' | 'deepen'
}> {
  const now = nowQueryKey?.trim() || ''
  return listSettledQueryEntries()
    .filter((e) => e.queryKey !== now)
    .map((e) => ({
      queryKey: e.queryKey,
      qText: e.qText,
      parentQueryKey: e.parentQueryKey,
      familyRole: e.parentQueryKey ? ('deepen' as const) : ('root' as const),
    }))
}
