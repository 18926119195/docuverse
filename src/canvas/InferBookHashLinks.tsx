/**
 * 左侧面 · inferKey（边中桥，非枢纽）：
 * - 单门/跨页：有向边 book → decision，ι 窗钉在边中点
 * - 双门同页：完整 A → B，ι 窗钉在中点；展开面板才离线
 */

import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import { PAGE_H, PAGE_W } from './geometry'
import { pagePointToLocal } from '../data/emphasis'
import { focusA1KeyOnPdf } from '../reasoning/focusA1Key'
import { useDocuverse } from './store'
import type { BookIndex } from '../reasoning/pipelineA'
import {
  InferAttentionCard,
  pairForInferEdge,
} from '../ui/InferAttentionCard'
import {
  FACE_LATERAL,
  FACE_OPEN_LIFT,
  edgeWindowMid,
  faceBridgePoint,
} from './keyPrismGeometry'
import { DirectedShaft } from './DirectedShaft'
import {
  inferInFocus,
  pathLineStyle,
  resolveFocusNeighborhood,
} from '../reasoning/pathFocus'

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

function centerLocal(
  chunk: BookIndex['chunks'][number],
): [number, number, number] {
  const bbox = pickBbox(chunk)
  const cx = (bbox[0] + bbox[2]) / 2
  const cy = (bbox[1] + bbox[3]) / 2
  const [lx, ly] = pagePointToLocal([cx, cy], PAGE_W, PAGE_H)
  return [lx, ly, 0.2]
}

function withAlpha(hex: string, opacity: number): string {
  const o = Math.max(0, Math.min(1, opacity))
  const n = Math.round(o * 255)
    .toString(16)
    .padStart(2, '0')
  if (hex.length === 7) return `${hex}${n}`
  return hex
}

type InferLinkGeom = {
  inferKey: string
  queryKey: string
  showPanel: boolean
  /** true：画完整 from→to，chip 在 mid；false：双门汇到 mid */
  fullEdge: boolean
  fromPt: [number, number, number]
  toPt: [number, number, number] | null
  mid: [number, number, number]
  panel: [number, number, number]
}

export function InferBookHashLinks({ strandIndex }: { strandIndex: number }) {
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const selectedInferKey = useAttentionIo((s) => s.selectedInferKey)
  const selectedQueryKey = useAttentionIo((s) => s.selectedQueryKey)
  const selectedEdgeId = useAttentionIo((s) => s.selectedEdgeId)
  const edges = useAttentionIo((s) => s.edges)
  const deskDeliveries = useAttentionIo((s) => s.deskDeliveries)
  const queryReuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const selectedInferHostStrand = useAttentionIo(
    (s) => s.selectedInferHostStrand,
  )
  const openInferEdge = useAttentionIo((s) => s.openInferEdge)
  const openQueryKey = useAttentionIo((s) => s.openQueryKey)
  const closeAttention = useAttentionIo((s) => s.closeAttention)
  const pinnedAttention = useAttentionIo((s) => s.pinnedAttention)
  const pinAttentionInfer = useAttentionIo((s) => s.pinAttentionInfer)
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
  const hasFocus = focus.hasFocus

  const links = useMemo((): InferLinkGeom[] => {
    if (!bookIndex) return []
    const out: InferLinkGeom[] = []

    for (const e of inferEdges) {
      const ca = bookIndex.chunks.find((c) => c.key === e.fromBookKey)
      const cb = bookIndex.chunks.find((c) => c.key === e.toBookKey)
      if (!ca || !cb) continue
      const aOn = ca.page === strandIndex
      const bOn = cb.page === strandIndex
      if (!aOn && !bOn) continue

      const open = e.inferKey === selectedInferKey
      const samePage = aOn && bOn
      const host =
        selectedInferHostStrand == null
          ? strandIndex
          : selectedInferHostStrand
      const showPanel = open && host === strandIndex

      if (samePage) {
        const fromPt = centerLocal(ca)
        const toPt = centerLocal(cb)
        const unary = e.fromBookKey === e.toBookKey
        if (unary) {
          const bridge = faceBridgePoint(fromPt, 'infer', showPanel)
          out.push({
            inferKey: e.inferKey,
            queryKey: e.queryKey,
            showPanel,
            fullEdge: true,
            fromPt: bridge.from,
            toPt: bridge.to,
            mid: bridge.mid,
            panel: bridge.panel,
          })
          continue
        }
        // ι 严格在 bookA→bookB 线段中点（中桥，不是枢纽顶点）
        const mid = edgeWindowMid(fromPt, toPt)
        const panel: [number, number, number] = showPanel
          ? [
              mid[0] - FACE_LATERAL,
              mid[1] + 0.14,
              mid[2] + FACE_OPEN_LIFT,
            ]
          : mid
        out.push({
          inferKey: e.inferKey,
          queryKey: e.queryKey,
          showPanel,
          fullEdge: true,
          fromPt,
          toPt,
          mid,
          panel,
        })
        continue
      }

      const anchor = aOn ? ca : cb
      const bridge = faceBridgePoint(centerLocal(anchor), 'infer', showPanel)
      out.push({
        inferKey: e.inferKey,
        queryKey: e.queryKey,
        showPanel,
        fullEdge: true,
        fromPt: bridge.from,
        toPt: bridge.to,
        mid: bridge.mid,
        panel: bridge.panel,
      })
    }
    return out
  }, [
    bookIndex,
    inferEdges,
    strandIndex,
    selectedInferKey,
    selectedInferHostStrand,
  ])

  const uniqueLinks = useMemo(() => {
    const seen = new Set<string>()
    const list: InferLinkGeom[] = []
    for (const L of links) {
      const id = `${L.inferKey}:${L.showPanel ? 'p' : 'c'}`
      if (seen.has(id)) continue
      seen.add(id)
      list.push(L)
    }
    return list
  }, [links])

  if (uniqueLinks.length === 0) return null

  return (
    <group>
      {uniqueLinks.map((L) => {
        const edge = inferEdges.find((e) => e.inferKey === L.inferKey)
        if (!edge) return null
        const selected = L.inferKey === selectedInferKey
        const onPath = inferInFocus(focus, L.inferKey)
        const style = pathLineStyle({ onPath, selected, hasFocus })
        const pair = pairForInferEdge(edge)
        const edgeColor = withAlpha(
          selected ? '#ffb347' : onPath ? '#e8a838' : '#8a7a50',
          style.opacity,
        )
        const syncColor = withAlpha('#7ec8ff', style.opacity)

        return (
          <group
            key={`${L.inferKey}_${strandIndex}_${L.showPanel ? 'p' : 'c'}`}
          >
            {L.fullEdge && L.toPt ? (
              <DirectedShaft
                from={L.fromPt}
                to={L.toPt}
                color={edgeColor}
                dim={!style.lit}
                lineWidth={style.lineWidth}
              />
            ) : (
              <>
                <DirectedShaft
                  from={L.fromPt}
                  to={L.mid}
                  color={edgeColor}
                  dim={!style.lit}
                  lineWidth={style.lineWidth}
                />
                {L.toPt && (
                  <DirectedShaft
                    from={L.toPt}
                    to={L.mid}
                    color={edgeColor}
                    dim={!style.lit}
                    lineWidth={style.lineWidth}
                  />
                )}
              </>
            )}
            {L.showPanel && (
              <DirectedShaft
                from={L.mid}
                to={L.panel}
                color={syncColor}
                lineWidth={2.2}
              />
            )}

            {/* ι 窗永远钉在 I/O 边中点；展开面板才离线 */}
            <Html
              position={L.mid}
              center
              zIndexRange={L.showPanel || onPath ? [210, 0] : [90, 0]}
              style={{
                pointerEvents: L.showPanel ? 'none' : 'auto',
                opacity: L.showPanel ? 0 : style.opacity,
                filter: style.lit
                  ? undefined
                  : 'saturate(0.2) grayscale(0.35)',
              }}
            >
              {!L.showPanel && (
                <InferAttentionCard
                  edge={edge}
                  pair={pair}
                  expanded={false}
                  onSwitchAttention={() => pinAttentionInfer(edge.inferKey)}
                  attentionPinned={
                    pinnedAttention?.kind === 'infer' &&
                    pinnedAttention.inferKey === edge.inferKey
                  }
                  onToggle={() => {
                    if (selected) {
                      closeAttention()
                      setCommentLayerExpanded(false)
                      return
                    }
                    openInferEdge(L.inferKey, strandIndex)
                    setCommentLayerExpanded(true)
                  }}
                />
              )}
            </Html>

            {L.showPanel && (
              <Html
                position={L.panel}
                center
                zIndexRange={[215, 0]}
                style={{
                  pointerEvents: 'auto',
                  opacity: style.opacity,
                }}
              >
                <div className="infer-io-with-anchor">
                  <InferAttentionCard
                    edge={edge}
                    pair={pair}
                    expanded
                    onSwitchAttention={() =>
                      pinAttentionInfer(edge.inferKey)
                    }
                    attentionPinned={
                      pinnedAttention?.kind === 'infer' &&
                      pinnedAttention.inferKey === edge.inferKey
                    }
                    onToggle={() => {
                      closeAttention()
                      setCommentLayerExpanded(false)
                    }}
                    onOpenQuery={() => {
                      openQueryKey(edge.queryKey)
                      setCommentLayerExpanded(true)
                    }}
                    onFocusFrom={() => {
                      if (!bookIndex) return
                      const also = (edge.bookKeys ?? []).filter(
                        (k) => k !== edge.fromBookKey,
                      )
                      focusA1KeyOnPdf({
                        key: edge.fromBookKey,
                        bookIndex,
                        swoopToPage,
                        alsoKeys: also.length ? also : [edge.toBookKey],
                      })
                    }}
                    onFocusTo={() => {
                      if (!bookIndex) return
                      focusA1KeyOnPdf({
                        key: edge.toBookKey,
                        bookIndex,
                        swoopToPage,
                        alsoKeys: [edge.fromBookKey],
                      })
                    }}
                  />
                </div>
              </Html>
            )}

            {L.showPanel && (
              <Html
                position={L.mid}
                center
                zIndexRange={[205, 0]}
                style={{ pointerEvents: 'none' }}
              >
                <span className="infer-sync-dot" title={edge.inferKey} />
              </Html>
            )}
          </group>
        )
      })}
    </group>
  )
}
