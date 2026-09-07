/**
 * Parse TOC-ish OCR / text into editable chapter rows (title + printed page).
 */

export interface TocEntryDraft {
  id: string
  title: string
  /** Inclusive printed start (user-facing number) */
  startPrinted: number
  /** Inclusive printed end; filled after parse or by user */
  endPrinted: number
}

function newId(): string {
  return `toc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/**
 * Pull "title …. 12" / "第一章  15" style lines from raw page text.
 */
export function parseTocText(raw: string): TocEntryDraft[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length >= 2)

  const entries: TocEntryDraft[] = []
  for (const line of lines) {
    // trailing page number (Arabic)
    const m = line.match(/^(.*?)[\s.·…．。\-—–]*(\d{1,4})\s*$/)
    if (!m) continue
    const title = m[1].replace(/[\s.·…．。\-—–]+$/g, '').trim()
    const startPrinted = Number(m[2])
    if (!title || !Number.isFinite(startPrinted) || startPrinted < 0) continue
    // skip pure digit lines / noise
    if (title.length < 1 || /^\d+$/.test(title)) continue
    entries.push({
      id: newId(),
      title: title.slice(0, 120),
      startPrinted,
      endPrinted: startPrinted,
    })
  }

  return fillEndPrinted(entries)
}

/** endPrinted = next.start - 1 (last keeps start until caller sets max). */
export function fillEndPrinted(
  entries: TocEntryDraft[],
  lastEndFallback?: number,
): TocEntryDraft[] {
  const sorted = [...entries].sort((a, b) => a.startPrinted - b.startPrinted)
  return sorted.map((e, i) => {
    const next = sorted[i + 1]
    const endPrinted = next
      ? Math.max(e.startPrinted, next.startPrinted - 1)
      : lastEndFallback != null
        ? Math.max(e.startPrinted, lastEndFallback)
        : e.endPrinted || e.startPrinted
    return { ...e, endPrinted }
  })
}

export function emptyTocEntry(startPrinted = 1): TocEntryDraft {
  return {
    id: newId(),
    title: '新章节',
    startPrinted,
    endPrinted: startPrinted,
  }
}
