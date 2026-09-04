/**
 * 外层 query 壳 + 主推理 / 问题↔材料闭环：
 *
 *   book ──(ι)──► book|decision     主推理注意力窗在边上
 *   ι中桥 ──► queryKey               落账尖端
 *   queryKey ──► bookKey 材料         问题驱动回指材料；Δ 窗在边中点
 *
 * 节点层只有 bookKey（页上 OCR）与 queryKey（壳）；ι / Δ 都是边中桥。
 */

import { useMemo } from 'react'
import { Html } from '@react-three/drei'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import { useDocuverse } from './store'
import { pageLocalToWorld, PAGE_H, PAGE_W } from './geometry'
import { pagePointToLocal } from '../data/emphasis'
import type { BookIndex } from '../reasoning/pipelineA'
import { QueryAttentionCard } from '../ui/QueryAttentionCard'
import { mapBriefToBook } from '../reasoning/masterTableMap'
import { edgeWindowMid, faceBridgePoint } from './keyPrismGeometry'
import { shortHandle } from '../reasoning/ocrSlot'
import {
  pathLineStyle,
  queryInFocus,
  resolveFocusNeighborhood,
} from '../reasoning/pathFocus'
import { DirectedShaft } from './DirectedShaft'

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

function bookKeyWorld(
  bookKey: string,
  bookIndex: BookIndex,
  total: number,
): [number, number, number] | null {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  if (!chunk) return null
  const bbox = pickBbox(chunk)
  const cx = (bbox[0] + bbox[2]) / 2
  const cy = (bbox[1] + bbox[3]) / 2
  const [lx, ly] = pagePointToLocal([cx, cy], PAGE_W, PAGE_H)
  return pageLocalToWorld(chunk.page, total, [lx, ly, 0.2])
}

function bookCenterLocal(
  bookKey: string,
  bookIndex: BookIndex,
): { page: number; center: [number, number, number] } | null {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  if (!chunk) return null
  const bbox = pickBbox(chunk)
  const cx = (bbox[0] + bbox[2]) / 2
  const cy = (bbox[1] + bbox[3]) / 2
  const [lx, ly] = pagePointToLocal([cx, cy], PAGE_W, PAGE_H)
  return { page: chunk.page, center: [lx, ly, 0.2] }
}

function radialOut(
  p: [number, number, number],
  scale: number,
): [number, number, number] {
  const len = Math.hypot(p[0], p[1], p[2]) || 1
  return [
    (p[0] / len) * len * scale,
    (p[1] / len) * len * scale,
    (p[2] / len) * len * scale,
  ]
}

function withAlpha(hex: string, opacity: number): string {
  const o = Math.max(0, Math.min(1, opacity))
  const n = Math.round(o * 255)
    .toString(16)
    .padStart(2, '0')
  if (hex.length === 7) return `${hex}${n}`
  return hex
}

export function AttentionShellLayer() {
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const edges = useAttentionIo((s) => s.edges)
  const queryReuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const settledQueries = useAttentionIo((s) => s.settledQueries)
  const queryKeyToBriefKeys = useAttentionIo((s) => s.queryKeyToBriefKeys)
  const selectedQueryKey = useAttentionIo((s) => s.selectedQueryKey)
  const selectedInferKey = useAttentionIo((s) => s.selectedInferKey)
  const selectedEdgeId = useAttentionIo((s) => s.selectedEdgeId)
  const deskDeliveries = useAttentionIo((s) => s.deskDeliveries)
  const openQueryKey = useAttentionIo((s) => s.openQueryKey)
  const openInferEdge = useAttentionIo((s) => s.openInferEdge)
  const openEdge = useAttentionIo((s) => s.openEdge)
  const closeAttention = useAttentionIo((s) => s.closeAttention)
  const pinnedAttention = useAttentionIo((s) => s.pinnedAttention)
  const pinAttentionQuery = useAttentionIo((s) => s.pinAttentionQuery)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const pages = useDocuverse((s) => s.pages)
  const setCommentLayerExpanded = useDocuverse((s) => s.setCommentLayerExpanded)
  const total = Math.max(pages.length, 1)
  const docId = bookIndex?.docId ?? ''

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

  const markers = useMemo(() => {
    if (!bookIndex || inferEdges.length === 0) return []
    const byQ = new Map<string, typeof inferEdges>()
    for (const e of inferEdges) {
      const list = byQ.get(e.queryKey) ?? []
      list.push(e)
      byQ.set(e.queryKey, list)
    }
    const out: Array<{
      queryKey: string
      question: string
      query: [number, number, number]
      books: Array<{ key: string; pos: [number, number, number] }>
      inferMids: Array<{
        inferKey: string
        mid: [number, number, number]
        from: [number, number, number]
        to: [number, number, number]
      }>
      edges: typeof inferEdges
      reuse: (typeof queryReuseLinks)[0] | null
      briefMids: Array<{
        briefKey: string
        mid: [number, number, number]
        bookPos: [number, number, number]
      }>
    }> = []

    for (const [queryKey, eds] of byQ) {
      const bookSet = new Set<string>()
      for (const e of eds) {
        for (const k of e.bookKeys?.length
          ? e.bookKeys
          : [e.fromBookKey, e.toBookKey]) {
          if (k) bookSet.add(k)
        }
      }
      const books: Array<{ key: string; pos: [number, number, number] }> = []
      for (const bk of bookSet) {
        const pos = bookKeyWorld(bk, bookIndex, total)
        if (pos) books.push({ key: bk, pos })
      }
      if (books.length === 0) continue
      const anchor = books[0]!.pos
      const query = radialOut(anchor, 1.28)

      const inferMids: (typeof out)[0]['inferMids'] = []
      for (const e of eds) {
        const a =
          bookKeyWorld(e.fromBookKey, bookIndex, total) ??
          books.find((b) => b.key === e.fromBookKey)?.pos
        const b =
          bookKeyWorld(e.toBookKey, bookIndex, total) ??
          books.find((b) => b.key === e.toBookKey)?.pos
        if (!a) continue
        if (!b || e.fromBookKey === e.toBookKey) {
          const local = bookCenterLocal(e.fromBookKey, bookIndex)
          if (!local) continue
          const bridge = faceBridgePoint(local.center, 'infer', false)
          const from = pageLocalToWorld(local.page, total, bridge.from)
          const to = pageLocalToWorld(local.page, total, bridge.to)
          const mid = pageLocalToWorld(local.page, total, bridge.mid)
          inferMids.push({ inferKey: e.inferKey, mid, from, to })
        } else {
          inferMids.push({
            inferKey: e.inferKey,
            mid: edgeWindowMid(a, b),
            from: a,
            to: b,
          })
        }
      }

      const briefMids: (typeof out)[0]['briefMids'] = []
      const briefKeys = queryKeyToBriefKeys[queryKey] ?? []
      for (const bk of briefKeys) {
        const hit = docId ? mapBriefToBook(docId, bk) : null
        const bookKey =
          hit?.bookKey ??
          edges.find((e) => e.toKey === bk)?.fromKey ??
          null
        if (!bookKey) continue
        const local = bookCenterLocal(bookKey, bookIndex)
        const bookPos = bookKeyWorld(bookKey, bookIndex, total)
        if (!local || !bookPos) continue
        const bridge = faceBridgePoint(local.center, 'peek', false)
        const mid = pageLocalToWorld(local.page, total, bridge.mid)
        briefMids.push({ briefKey: bk, mid, bookPos })
      }

      out.push({
        queryKey,
        question: settledQueries[queryKey] ?? eds[0]!.question,
        query,
        books,
        inferMids,
        edges: eds,
        reuse:
          queryReuseLinks.find((l) => l.fromQueryKey === queryKey) ?? null,
        briefMids,
      })
    }
    return out
  }, [
    bookIndex,
    docId,
    edges,
    inferEdges,
    queryKeyToBriefKeys,
    queryReuseLinks,
    settledQueries,
    total,
  ])

  const queryPosByQk = useMemo(() => {
    const m = new Map<string, [number, number, number]>()
    for (const x of markers) m.set(x.queryKey, x.query)
    return m
  }, [markers])

  if (markers.length === 0) return null

  return (
    <group>
      {markers.map((m) => {
        const open = selectedQueryKey === m.queryKey
        const onPath = queryInFocus(focus, m.queryKey)
        const style = pathLineStyle({
          onPath,
          selected: open,
          hasFocus,
        })
        const qColor = withAlpha('#c5b0ff', style.opacity)
        const inferColor = withAlpha('#f0a202', style.opacity)
        const backColor = withAlpha('#00e5ff', style.opacity)

        return (
          <group key={m.queryKey}>
            {/* 主推理：book──(ι)──►… 再 ι──►query */}
            {m.inferMids.map((im) => (
              <group key={`${m.queryKey}_${im.inferKey}`}>
                <DirectedShaft
                  from={im.from}
                  to={im.to}
                  color={inferColor}
                  dim={!style.lit}
                  lineWidth={style.lineWidth}
                />
                <DirectedShaft
                  from={im.mid}
                  to={m.query}
                  color={qColor}
                  dim={!style.lit}
                  lineWidth={style.lineWidth + 0.2}
                />
                <Html
                  position={im.mid}
                  center
                  zIndexRange={[170, 0]}
                  style={{
                    pointerEvents: 'auto',
                    opacity: style.opacity,
                  }}
                >
                  <button
                    type="button"
                    className="hash-delta-chip infer-chip edge-mid-chip"
                    title={im.inferKey}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      openInferEdge(im.inferKey)
                      setCommentLayerExpanded(true)
                    }}
                  >
                    ι {shortHandle(im.inferKey)}
                  </button>
                </Html>
                <Html
                  position={edgeWindowMid(im.mid, m.query)}
                  center
                  style={{ pointerEvents: 'none', opacity: style.opacity }}
                >
                  <span className="edge-job-tag infer-tag">→query</span>
                </Html>
              </group>
            ))}

            {/* 问题→材料闭环：query ──► bookKey；Δ 窗钉在边中点 */}
            {m.briefMids.map((bm) => {
              const qToBookMid = edgeWindowMid(m.query, bm.bookPos)
              return (
              <group key={`${m.queryKey}_back_${bm.briefKey}`}>
                <DirectedShaft
                  from={m.query}
                  to={bm.bookPos}
                  color={backColor}
                  dim={!style.lit}
                  lineWidth={Math.max(1.2, style.lineWidth - 0.2)}
                />
                <Html
                  position={qToBookMid}
                  center
                  zIndexRange={[165, 0]}
                  style={{
                    pointerEvents: 'auto',
                    opacity: style.opacity,
                  }}
                >
                  <button
                    type="button"
                    className="hash-delta-chip edge-mid-chip"
                    title={`Q→peek · ${bm.briefKey}`}
                    onClick={(ev) => {
                      ev.stopPropagation()
                      const edge = edges.find((e) => e.toKey === bm.briefKey)
                      if (edge) openEdge(edge.id)
                      setCommentLayerExpanded(true)
                    }}
                  >
                    Δ {shortHandle(bm.briefKey)}
                  </button>
                </Html>
              </group>
              )
            })}

            <Html
              position={m.query}
              center
              zIndexRange={open || onPath ? [220, 0] : [80, 0]}
              style={{
                pointerEvents: 'auto',
                opacity: style.opacity,
                filter: style.lit ? undefined : 'saturate(0.2) grayscale(0.35)',
              }}
            >
              <QueryAttentionCard
                queryKey={m.queryKey}
                question={m.question}
                edges={m.edges}
                reuse={m.reuse}
                expanded={open}
                pathLit={style.lit}
                onToggle={() => {
                  if (open) {
                    closeAttention()
                    setCommentLayerExpanded(false)
                    return
                  }
                  openQueryKey(m.queryKey)
                  setCommentLayerExpanded(true)
                }}
                onSwitchAttention={() => pinAttentionQuery(m.queryKey)}
                attentionPinned={
                  pinnedAttention?.kind === 'query' &&
                  pinnedAttention.queryKey === m.queryKey
                }
                onOpenInfer={(ik) => {
                  const edge = m.edges.find((x) => x.inferKey === ik)
                  const page = edge
                    ? bookIndex?.chunks.find((c) => c.key === edge.fromBookKey)
                        ?.page
                    : undefined
                  openInferEdge(ik, page)
                  setCommentLayerExpanded(true)
                }}
              />
            </Html>
          </group>
        )
      })}

      {/* 复用：新 qk ──► 旧 qk */}
      {queryReuseLinks.map((l) => {
        const from = queryPosByQk.get(l.fromQueryKey)
        const to = queryPosByQk.get(l.toQueryKey)
        if (!from || !to) return null
        const onPath =
          queryInFocus(focus, l.fromQueryKey) ||
          queryInFocus(focus, l.toQueryKey)
        const style = pathLineStyle({
          onPath,
          selected: false,
          hasFocus,
        })
        return (
          <DirectedShaft
            key={l.id}
            from={from}
            to={to}
            color={withAlpha('#9d7cff', style.opacity)}
            dim={!style.lit}
            lineWidth={style.lineWidth + 0.4}
          />
        )
      })}
    </group>
  )
}
