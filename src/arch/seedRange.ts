/**
 * 热启 peek：seedRange（两 briefKey）→ 书序闭区间 bookKey[]（§4.4.4）
 */

import type { BookIndex, AChunk } from '../reasoning/pipelineA'
import { isRetrievableAtom } from '../reasoning/hybridRetrieve'
import { mapBriefToBook, doorHasBrief } from '../reasoning/masterTableMap'

export type SeedRange = { from: string; to: string }

const DEFAULT_MAX_KEYS = 24

function sortChunks(chunks: AChunk[]): AChunk[] {
  return [...chunks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0] || a.slotK - b.slotK
  })
}

/** A1 书序门牌（可检索） */
export function orderedRetrievableBookKeys(bookIndex: BookIndex): string[] {
  return sortChunks(bookIndex.chunks)
    .filter((c) => isRetrievableAtom(c))
    .map((c) => c.key)
}

export function parseSeedRange(raw: unknown): SeedRange | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const from = String(o.from ?? o.start ?? o.lo ?? '').trim()
  const to = String(o.to ?? o.end ?? o.hi ?? '').trim()
  if (!from || !to) return null
  return { from, to }
}

/** 缺 seedRange 时：用队列首尾 / lastBriefKey 兜底两端 */
export function fallbackSeedRange(
  briefKeys: string[],
  lastBriefKey: string | null,
): SeedRange | null {
  const uniq = [...new Set(briefKeys.filter(Boolean))]
  if (uniq.length === 0) return null
  if (uniq.length === 1) {
    const only = uniq[0]!
    return { from: only, to: only }
  }
  if (lastBriefKey && uniq.includes(lastBriefKey)) {
    const i = uniq.indexOf(lastBriefKey)
    const from = uniq[Math.max(0, i - 1)]!
    return { from, to: lastBriefKey }
  }
  return { from: uniq[0]!, to: uniq[uniq.length - 1]! }
}

export function expandSeedRangeToBookKeys(input: {
  docId: string
  bookIndex: BookIndex
  seed: SeedRange
  maxKeys?: number
}): {
  bookKeys: string[]
  unopened: string[]
  opened: string[]
  note: string
} {
  const maxKeys = input.maxKeys ?? DEFAULT_MAX_KEYS
  const fromBook = mapBriefToBook(input.docId, input.seed.from)?.bookKey
  const toBook = mapBriefToBook(input.docId, input.seed.to)?.bookKey
  if (!fromBook || !toBook) {
    return {
      bookKeys: [],
      unopened: [],
      opened: [],
      note: `seedRange 硬闸：无法 map brief→book（from=${fromBook ? 'ok' : '∅'} to=${toBook ? 'ok' : '∅'}）`,
    }
  }

  const ordered = orderedRetrievableBookKeys(input.bookIndex)
  let i0 = ordered.indexOf(fromBook)
  let i1 = ordered.indexOf(toBook)
  if (i0 < 0 || i1 < 0) {
    return {
      bookKeys: [],
      unopened: [],
      opened: [],
      note: `seedRange 硬闸：端点不在 A1 书序（from=${fromBook.slice(0, 16)}… to=${toBook.slice(0, 16)}…）`,
    }
  }
  if (i0 > i1) {
    const t = i0
    i0 = i1
    i1 = t
  }

  let slice = ordered.slice(i0, i1 + 1)
  if (slice.length > maxKeys) {
    slice = slice.slice(0, maxKeys)
  }

  const unopened: string[] = []
  const opened: string[] = []
  for (const k of slice) {
    if (doorHasBrief(input.docId, k)) opened.push(k)
    else unopened.push(k)
  }
  // 组窗序：未开前、已开后（§4.4.5）
  const bookKeys = [...unopened, ...opened]
  return {
    bookKeys,
    unopened,
    opened,
    note: `seedRange → 书序 N=${bookKeys.length}（未开 ${unopened.length} · 已开 ${opened.length}）`,
  }
}

/** lastBriefKey 之后尚可续滚的 brief */
export function briefsAfterCursor(
  queue: string[],
  lastBriefKey: string | null,
): string[] {
  if (!lastBriefKey) return [...queue]
  const i = queue.indexOf(lastBriefKey)
  if (i < 0) return [...queue]
  return queue.slice(i + 1)
}
