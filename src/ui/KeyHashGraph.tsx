import { useMemo } from 'react'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { shortHandle } from '../reasoning/ocrSlot'
import { focusA1KeyOnPdf } from '../reasoning/focusA1Key'
import { useIndexGate } from '../reasoning/indexGate'
import { useDocuverse } from '../canvas/store'
import {
  inferInFocus,
  queryInFocus,
  resolveFocusNeighborhood,
} from '../reasoning/pathFocus'

/**
 * Slim Δ rail: briefKeys + inferKeys.
 * Click → attention float (L|R hash).
 */
export function KeyHashGraph() {
  const edges = useAttentionIo((s) => s.edges)
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const queryReuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const deskDeliveries = useAttentionIo((s) => s.deskDeliveries)
  const steps = useAttentionIo((s) => s.steps)
  const selectedEdgeId = useAttentionIo((s) => s.selectedEdgeId)
  const selectedInferKey = useAttentionIo((s) => s.selectedInferKey)
  const selectedQueryKey = useAttentionIo((s) => s.selectedQueryKey)
  const wmEdgeIds = useAttentionIo((s) => s.wmEdgeIds)
  const graphOpen = useAttentionIo((s) => s.graphOpen)
  const openEdge = useAttentionIo((s) => s.openEdge)
  const openInferEdge = useAttentionIo((s) => s.openInferEdge)
  const closeAttention = useAttentionIo((s) => s.closeAttention)
  const setGraphOpen = useAttentionIo((s) => s.setGraphOpen)
  const clearAll = useAttentionIo((s) => s.clearAll)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const setCommentLayerExpanded = useDocuverse((s) => s.setCommentLayerExpanded)

  const focus = useMemo(
    () =>
      resolveFocusNeighborhood({
        selectedEdgeId,
        selectedInferKey,
        selectedQueryKey,
        edges,
        inferEdges,
        deskDeliveries,
        queryReuseLinks,
      }),
    [
      deskDeliveries,
      edges,
      inferEdges,
      queryReuseLinks,
      selectedEdgeId,
      selectedInferKey,
      selectedQueryKey,
    ],
  )
  if (!graphOpen) {
    return (
      <button
        type="button"
        className="key-hash-fab"
        onClick={() => setGraphOpen(true)}
        title="打开 Δ / ι key 列表"
      >
        Δ Keys
      </button>
    )
  }

  const latest = steps[steps.length - 1]
  const empty = edges.length === 0 && inferEdges.length === 0

  return (
    <aside className="key-hash-graph" aria-label="增量 key · 注意力入口">
      <header className="key-hash-head">
        <div>
          <div className="key-hash-title">Δ · ι · query</div>
          <p className="key-hash-sub">
            右 brief · 左 infer · 外 query · 点 brief / ι / qk → 只亮直接连线，其余降暗
          </p>
        </div>
        <div className="key-hash-head-actions">
          <button
            type="button"
            className="corpus-chip"
            onClick={() => clearAll()}
            disabled={empty}
          >
            清空
          </button>
          <button
            type="button"
            className="corpus-chip"
            onClick={() => setGraphOpen(false)}
          >
            收起
          </button>
        </div>
      </header>

      {empty ? (
        <p className="key-hash-empty">
          peek 铸贴后有 Δ；主推理落账后有 ι 中桥边。
        </p>
      ) : (
        <>
          {latest && <p className="key-hash-batch">{latest.label}</p>}
          {edges.length > 0 && (
            <ul className="key-hash-edges">
              {edges.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className={
                      selectedEdgeId === e.id
                        ? 'key-hash-edge active'
                        : wmEdgeIds.includes(e.id)
                          ? 'key-hash-edge wm'
                          : 'key-hash-edge'
                    }
                    onClick={() => {
                      if (selectedEdgeId === e.id) {
                        closeAttention()
                        setCommentLayerExpanded(false)
                        return
                      }
                      openEdge(e.id)
                      setCommentLayerExpanded(true)
                      if (bookIndex) {
                        focusA1KeyOnPdf({
                          key: e.fromKey,
                          bookIndex,
                          swoopToPage,
                        })
                      }
                    }}
                  >
                    <code title={e.fromKey}>{shortHandle(e.fromKey)}</code>
                    <span className="key-hash-arrow" aria-hidden>
                      →
                    </span>
                    <code className="delta" title={e.toKey}>
                      {shortHandle(e.toKey)}
                    </code>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {inferEdges.length > 0 && (
            <>
              <p className="key-hash-batch">ι · 推理边</p>
              <ul className="key-hash-edges">
                {inferEdges.map((e) => {
                  const onPath = inferInFocus(focus, e.inferKey)
                  const active = selectedInferKey === e.inferKey
                  return (
                  <li key={e.id}>
                    <button
                      type="button"
                      className={
                        active
                          ? 'key-hash-edge active infer path-lit'
                          : onPath
                            ? 'key-hash-edge infer path-lit'
                            : 'key-hash-edge infer path-dim'
                      }
                      onClick={() => {
                        if (selectedInferKey === e.inferKey) {
                          closeAttention()
                          setCommentLayerExpanded(false)
                          return
                        }
                        openInferEdge(
                          e.inferKey,
                          bookIndex?.chunks.find((c) => c.key === e.fromBookKey)
                            ?.page,
                        )
                        setCommentLayerExpanded(true)
                        if (bookIndex) {
                          focusA1KeyOnPdf({
                            key: e.fromBookKey,
                            bookIndex,
                            swoopToPage,
                            alsoKeys: e.bookKeys?.length
                              ? e.bookKeys.filter((k) => k !== e.fromBookKey)
                              : [e.toBookKey],
                          })
                        }
                      }}
                    >
                      <code title={e.fromBookKey}>
                        {shortHandle(e.fromBookKey)}
                      </code>
                      <span className="key-hash-arrow" aria-hidden>
                        ─ι─
                      </span>
                      <code title={e.toBookKey}>
                        {shortHandle(e.toBookKey)}
                      </code>
                    </button>
                  </li>
                  )
                })}
              </ul>
            </>
          )}
          {deskDeliveries.length > 0 && (
          <>
            <p className="key-hash-batch">台递送 · from ──► to</p>
            <ul className="key-hash-edges">
              {deskDeliveries.map((d) => (
                <li key={d.id}>
                  <div className="key-hash-edge delivery" title={d.toKey}>
                    <span className="key-hash-job">{d.job}</span>
                    <code title={d.fromKeys.join(' · ')}>
                      {d.fromKeys.map((k) => shortHandle(k)).join('·')}
                    </code>
                    <span className="key-hash-arrow" aria-hidden>
                      ──►
                    </span>
                    <code className="delta" title={d.toKey}>
                      {shortHandle(d.toKey)}
                    </code>
                    <span className="key-hash-seq">#{d.settleSeq}</span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {queryReuseLinks.length > 0 && (
            <>
              <p className="key-hash-batch">复用 · 增量边</p>
              <ul className="key-hash-edges">
                {queryReuseLinks.map((l) => {
                  const onPath =
                    queryInFocus(focus, l.fromQueryKey) || queryInFocus(focus, l.toQueryKey)
                  return (
                  <li key={l.id}>
                    <button
                      type="button"
                      className={
                        onPath
                          ? 'key-hash-edge reuse path-lit'
                          : 'key-hash-edge reuse path-dim'
                      }
                      title={l.rationale}
                      onClick={() => {
                        const ik = l.inferKeys[0]
                        if (!ik) return
                        openInferEdge(ik)
                        setCommentLayerExpanded(true)
                      }}
                    >
                      <code title={l.fromQueryKey}>
                        {shortHandle(l.fromQueryKey)}
                      </code>
                      <span className="key-hash-arrow" aria-hidden>
                        ──►
                      </span>
                      <code title={l.toQueryKey}>
                        {shortHandle(l.toQueryKey)}
                      </code>
                    </button>
                  </li>
                  )
                })}
              </ul>
            </>
          )}
        </>
      )}
    </aside>
  )
}
