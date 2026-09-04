/**
 * 写信台残余递送：只画非中桥端点（如 →queryKey）。
 * peek/decide/ι 闭环由 BookKeyHashLinks / InferBookHashLinks / AttentionShellLayer 负责。
 */
import { useMemo } from 'react'
import * as THREE from 'three'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { useIndexGate } from '../reasoning/indexGate'
import { mapBriefToBook } from '../reasoning/masterTableMap'
import type { BookIndex } from '../reasoning/pipelineA'
import { pageLocalToWorld, PAGE_H, PAGE_W } from './geometry'
import { pagePointToLocal } from '../data/emphasis'
import { useDocuverse } from './store'
import { DirectedShaft } from './DirectedShaft'
import {
  keyInFocus,
  resolveFocusNeighborhood,
} from '../reasoning/pathFocus'

const JOB_COLOR: Record<string, string> = {
  peek: '#00e5ff',
  query: '#c5b0ff',
  decide: '#5cffb1',
  supervise: '#9ad4ff',
  infer: '#f0a202',
  mainInfer: '#f0a202', // legacy alias
  reuse: '#ff8fab',
}

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

function v3(p: [number, number, number]) {
  return new THREE.Vector3(p[0], p[1], p[2])
}

export function DeskDeliveryArrows() {
  const deskDeliveries = useAttentionIo((s) => s.deskDeliveries)
  const edges = useAttentionIo((s) => s.edges)
  const inferEdges = useAttentionIo((s) => s.inferEdges)
  const selectedEdgeId = useAttentionIo((s) => s.selectedEdgeId)
  const selectedInferKey = useAttentionIo((s) => s.selectedInferKey)
  const selectedQueryKey = useAttentionIo((s) => s.selectedQueryKey)
  const queryReuseLinks = useAttentionIo((s) => s.queryReuseLinks)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const pages = useDocuverse((s) => s.pages)
  const total = Math.max(pages.length, 1)
  const docId = bookIndex?.docId ?? ''

  const bookPos = useMemo(() => {
    const map = new Map<string, [number, number, number]>()
    if (!bookIndex) return map
    for (const c of bookIndex.chunks) {
      const w = bookKeyWorld(c.key, bookIndex, total)
      if (w) map.set(c.key, w)
    }
    return map
  }, [bookIndex, total])

  const queryPos = useMemo(() => {
    const map = new Map<string, [number, number, number]>()
    if (!bookIndex) return map
    const byQ = new Map<string, typeof inferEdges>()
    for (const e of inferEdges) {
      const list = byQ.get(e.queryKey) ?? []
      list.push(e)
      byQ.set(e.queryKey, list)
    }
    for (const [qk, eds] of byQ) {
      const bk = eds[0]?.fromBookKey || eds[0]?.bookKeys[0]
      if (!bk) continue
      const anchor = bookPos.get(bk) ?? bookKeyWorld(bk, bookIndex, total)
      if (!anchor) continue
      map.set(qk, radialOut(anchor, 1.28))
    }
    return map
  }, [bookIndex, bookPos, inferEdges, total])

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

  const shafts = useMemo(() => {
    const out: Array<{
      id: string
      job: string
      from: THREE.Vector3
      to: THREE.Vector3
      lit: boolean
    }> = []
    if (!bookIndex) return out
    const inferByKey = new Map(inferEdges.map((e) => [e.inferKey, e]))
    const briefByKey = new Map(edges.map((e) => [e.toKey, e]))

    for (const d of deskDeliveries) {
      if (inferByKey.has(d.toKey) || briefByKey.has(d.toKey)) continue
      if (d.job === 'peek' || d.job === 'decide' || d.job === 'infer' || d.job === 'mainInfer') continue
      let toPos = queryPos.get(d.toKey) ?? bookPos.get(d.toKey) ?? null
      if (!toPos && docId) {
        const hit = mapBriefToBook(docId, d.toKey)
        if (hit) toPos = bookPos.get(hit.bookKey) ?? null
      }
      if (!toPos) continue
      const to = v3(toPos)
      for (const fk of d.fromKeys) {
        if (fk === d.toKey) continue
        if (inferByKey.has(fk) || briefByKey.has(fk)) continue
        let fromPos = bookPos.get(fk) ?? queryPos.get(fk) ?? null
        if (!fromPos && docId) {
          const hit = mapBriefToBook(docId, fk)
          if (hit) fromPos = bookPos.get(hit.bookKey) ?? null
        }
        if (!fromPos) continue
        const from = v3(fromPos)
        if (from.distanceToSquared(to) < 1e-6) continue
        const lit =
          !focus.hasFocus ||
          keyInFocus(focus, fk) ||
          keyInFocus(focus, d.toKey)
        out.push({ id: `${d.id}__${fk}`, job: d.job, from, to, lit })
      }
    }
    return out
  }, [
    bookIndex,
    bookPos,
    deskDeliveries,
    docId,
    edges,
    focus,
    inferEdges,
    queryPos,
  ])

  if (shafts.length === 0) return null
  return (
    <group>
      {shafts.map((a) => (
        <DirectedShaft
          key={a.id}
          from={a.from}
          to={a.to}
          color={JOB_COLOR[a.job] ?? '#9aa3b5'}
          dim={!a.lit}
          lineWidth={2.4}
        />
      ))}
    </group>
  )
}
