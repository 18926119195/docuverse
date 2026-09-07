/**
 * 找材料闭环（页上）：
 *   book ──peek(Δ)──► brief锚
 *   brief锚 ──decide(Δ)──► book
 * briefKey 只是边中桥，不是第三层节点。
 */

import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import { DirectedShaft } from './DirectedShaft'
import { faceBridgePoint } from './keyPrismGeometry'
import {
  edgeInFocus,
  resolveFocusNeighborhood,
} from '../reasoning/pathFocus'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import { PAGE_H, PAGE_W } from './geometry'
import { pagePointToLocal } from '../data/emphasis'
import { focusA1KeyOnPdf } from '../reasoning/focusA1Key'
import { useDocuverse } from './store'
import type { BookIndex } from '../reasoning/pipelineA'
import {
  DeltaAttentionCard,
  pairForEdge,
} from '../ui/DeltaAttentionCard'

function pickBbox(
  chunk: BookIndex['chunks'][number],
): [number, number, number, number] {
  const area = (b: [number, number, number, number]) =>
    Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
  const full = 0.82 * 1_000_000
  if (area(chunk.bbox) < full) return chunk.bbox
  const ink = (chunk.inkBoxes ?? []).find((b) => area(b) < full)
  return ink ?? chunk.bbox
}

export function BookKeyHashLinks({ strandIndex }: { strandIndex: number }) {
  const edges = useAttentionIo((s) => s.edges)
  const steps = useAttentionIo((s) => s.steps)
  const selectedEdgeId = useAttentionIo((s) => s.selectedEdgeId)
  const selectedInferKey = useAttentionIo((s) => s.selectedInferKey)
  const selectedQueryKey = useAttentionIo((s) => s.selectedQueryKey)
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const deskDeliveries = useAttentionIo((s) => s.deskDeliveries)
  const queryReuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const wmEdgeIds = useAttentionIo((s) => s.wmEdgeIds)
  const openEdge = useAttentionIo((s) => s.openEdge)
  const closeAttention = useAttentionIo((s) => s.closeAttention)
  const pinnedAttention = useAttentionIo((s) => s.pinnedAttention)
  const pinAttentionEdge = useAttentionIo((s) => s.pinAttentionEdge)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const setCommentLayerExpanded = useDocuverse(
    (s) => s.setCommentLayerExpanded,
  )

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

  const links = useMemo(() => {
    if (!bookIndex) return []
    const out: Array<{
      edgeId: string
      bookKey: string
      briefKey: string
      peek: ReturnType<typeof faceBridgePoint>
      decide: ReturnType<typeof faceBridgePoint>
    }> = []
    for (const e of edges) {
      const chunk = bookIndex.chunks.find((c) => c.key === e.fromKey)
      if (!chunk || chunk.page !== strandIndex) continue
      const bbox = pickBbox(chunk)
      const cx = (bbox[0] + bbox[2]) / 2
      const cy = (bbox[1] + bbox[3]) / 2
      const [lx, ly] = pagePointToLocal([cx, cy], PAGE_W, PAGE_H)
      const bookCenter: [number, number, number] = [lx, ly, 0.2]
      const open = e.id === selectedEdgeId
      out.push({
        edgeId: e.id,
        bookKey: e.fromKey,
        briefKey: e.toKey,
        peek: faceBridgePoint(bookCenter, 'peek', open),
        decide: faceBridgePoint(bookCenter, 'decide', open),
      })
    }
    return out
  }, [bookIndex, edges, strandIndex, selectedEdgeId])

  if (links.length === 0) return null

  return (
    <group>
      {links.map((L) => {
        const active = L.edgeId === selectedEdgeId
        const lit = edgeInFocus(focus, L.edgeId)
        const edge = edges.find((e) => e.id === L.edgeId)
        const step = edge ? steps.find((s) => s.id === edge.stepId) : null
        const pair = edge && step ? pairForEdge(step, edge) : null
        const peekColor = active ? '#5cffb1' : '#00e5ff'
        const decideColor = active ? '#9dffc8' : '#5cffb1'

        return (
          <group key={L.edgeId}>
            {/* 出站：book ──peek──► brief锚 */}
            <DirectedShaft
              from={L.peek.from}
              to={L.peek.to}
              color={peekColor}
              dim={!lit}
              lineWidth={active ? 2.6 : 1.8}
            />
            {/* 回站：brief锚 ──decide──► book（闭环） */}
            <DirectedShaft
              from={L.decide.from}
              to={L.decide.to}
              color={decideColor}
              dim={!lit}
              lineWidth={active ? 2.4 : 1.6}
            />
            {active && (
              <DirectedShaft
                from={L.peek.mid}
                to={L.peek.panel}
                color="#9ad4ff"
                lineWidth={2}
              />
            )}
            {/* peek / decide 标签与 Δ 窗：一律钉在边中点；展开面板才离线 */}
            <Html
              position={L.peek.mid}
              center
              zIndexRange={[190, 0]}
              style={{
                pointerEvents: 'none',
                opacity: lit ? 1 : 0.25,
              }}
            >
              <span className="edge-job-tag peek-tag" title={`peek · ${L.briefKey}`}>
                peek
              </span>
            </Html>
            <Html
              position={L.decide.mid}
              center
              zIndexRange={[189, 0]}
              style={{
                pointerEvents: 'none',
                opacity: lit ? 1 : 0.25,
              }}
            >
              <span
                className="edge-job-tag decide-tag"
                title={`decide · ${L.briefKey}`}
              >
                decide
              </span>
            </Html>
            {/* 中桥 chip 永远在 peek 边中点 */}
            <Html
              position={L.peek.mid}
              center
              zIndexRange={active || lit ? [200, 0] : [80, 0]}
              style={{
                pointerEvents: active ? 'none' : 'auto',
                opacity: active ? 0 : lit ? 1 : 0.2,
                filter: lit ? undefined : 'saturate(0.2)',
              }}
            >
              {!active && (
                <DeltaAttentionCard
                  briefKey={L.briefKey}
                  bookKey={L.bookKey}
                  pair={pair}
                  expanded={false}
                  wmOn={wmEdgeIds.includes(L.edgeId)}
                  onToggle={() => {
                    openEdge(L.edgeId)
                    setCommentLayerExpanded(true)
                  }}
                  onSwitchAttention={() => pinAttentionEdge(L.edgeId)}
                  attentionPinned={
                    pinnedAttention?.kind === 'edge' &&
                    pinnedAttention.edgeId === L.edgeId
                  }
                  onFocusBook={() => {
                    if (!bookIndex) return
                    focusA1KeyOnPdf({
                      key: L.bookKey,
                      bookIndex,
                      swoopToPage,
                    })
                  }}
                />
              )}
            </Html>
            {active && (
              <Html
                position={L.peek.panel}
                center
                zIndexRange={[210, 0]}
                style={{ pointerEvents: 'auto' }}
              >
                <DeltaAttentionCard
                  briefKey={L.briefKey}
                  bookKey={L.bookKey}
                  pair={pair}
                  expanded
                  wmOn={wmEdgeIds.includes(L.edgeId)}
                  onToggle={() => {
                    closeAttention()
                    setCommentLayerExpanded(false)
                  }}
                  onSwitchAttention={() => pinAttentionEdge(L.edgeId)}
                  attentionPinned={
                    pinnedAttention?.kind === 'edge' &&
                    pinnedAttention.edgeId === L.edgeId
                  }
                  onFocusBook={() => {
                    if (!bookIndex) return
                    focusA1KeyOnPdf({
                      key: L.bookKey,
                      bookIndex,
                      swoopToPage,
                    })
                  }}
                />
              </Html>
            )}
            {active && (
              <Html
                position={L.peek.mid}
                center
                zIndexRange={[205, 0]}
                style={{ pointerEvents: 'none' }}
              >
                <span className="infer-sync-dot" title={L.briefKey} />
              </Html>
            )}
          </group>
        )
      })}
    </group>
  )
}
