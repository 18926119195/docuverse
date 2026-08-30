/**
 * Post-upload TOC wizard:
 * 1) calibrate printed page ↔ strandIndex
 * 2) pick TOC page(s) → parse → edit
 * 3) confirm → memberKeys; or skip with warning
 */

import { useEffect, useMemo, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { useIndexGate } from '../reasoning/indexGate'
import {
  calibrationNote,
  makeCalibration,
  printedRangeToStrandRange,
} from '../reasoning/pageCalibration'
import {
  emptyTocEntry,
  fillEndPrinted,
  parseTocText,
  type TocEntryDraft,
} from '../reasoning/tocParse'
import { atomSearchText } from '../reasoning/hybridRetrieve'

type Step = 'calibrate' | 'pick_toc' | 'edit' | 'preview'

export function TocWizard() {
  const open = useIndexGate((s) => s.tocWizardOpen)
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const calibration = useIndexGate((s) => s.pageCalibration)
  const setPageCalibration = useIndexGate((s) => s.setPageCalibration)
  const confirmTocWizard = useIndexGate((s) => s.confirmTocWizard)
  const skipTocWizard = useIndexGate((s) => s.skipTocWizard)
  const closeTocWizard = useIndexGate((s) => s.closeTocWizard)

  const pages = useDocuverse((s) => s.pages)
  const currentStrand = useDocuverse((s) => s.currentStrand)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)
  const ocrByStrand = useDocuverse((s) => s.ocrByStrand)

  const [step, setStep] = useState<Step>('calibrate')
  const [printedInput, setPrintedInput] = useState('')
  const [tocStrands, setTocStrands] = useState<number[]>([])
  const [entries, setEntries] = useState<TocEntryDraft[]>([])
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setStep('calibrate')
    setErr(null)
  }, [open])

  const maxStrand = useMemo(() => {
    if (!bookIndex?.chunks.length) return Math.max(0, pages.length - 1)
    return Math.max(0, ...bookIndex.chunks.map((c) => c.page))
  }, [bookIndex, pages.length])

  const previewRows = useMemo(() => {
    if (!calibration || entries.length === 0) return []
    return entries.map((e) => {
      const range = printedRangeToStrandRange(
        e.startPrinted,
        e.endPrinted,
        calibration,
      )
      const startPage = Math.max(0, range.startPage)
      const endPage = Math.min(maxStrand, range.endPage)
      let keyCount = 0
      if (bookIndex) {
        for (const c of bookIndex.chunks) {
          if (c.page >= startPage && c.page <= endPage) keyCount += 1
        }
      }
      return { ...e, startPage, endPage, keyCount }
    })
  }, [entries, calibration, bookIndex, maxStrand])

  if (!open || tocStatus === 'confirmed') return null

  const pageText = (strand: number): string => {
    const ocr = ocrByStrand[strand]
    if (ocr?.blocks?.length) {
      return ocr.blocks.map((b) => b.content || '').join('\n')
    }
    const page = pages.find((p) => p.strandIndex === strand)
    if (page?.textChunks?.length) {
      return page.textChunks.map((c) => c.content).join('\n')
    }
    if (bookIndex) {
      return bookIndex.chunks
        .filter((c) => c.page === strand)
        .map((c) => atomSearchText(c))
        .join('\n')
    }
    return page?.text ?? ''
  }

  const onCalibrate = () => {
    setErr(null)
    const printed = Number(printedInput.trim())
    if (!Number.isFinite(printed)) {
      setErr('请输入你在书页上看到的页码数字（阿拉伯数字）')
      return
    }
    const cal = makeCalibration(currentStrand, printed)
    setPageCalibration(cal)
    setStep('pick_toc')
  }

  const toggleTocStrand = (s: number) => {
    setTocStrands((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s].sort((a, b) => a - b),
    )
  }

  const onParseToc = () => {
    setErr(null)
    if (tocStrands.length === 0) {
      setErr('请至少点选一页目录')
      return
    }
    const raw = tocStrands.map((s) => pageText(s)).join('\n')
    let parsed = parseTocText(raw)
    if (parsed.length === 0) {
      parsed = [emptyTocEntry(1)]
      setErr('未能自动解析目录行，已给出空行请手填')
    }
    const lastPrinted = calibration
      ? maxStrand - calibration.offset
      : maxStrand + 1
    parsed = fillEndPrinted(parsed, lastPrinted)
    setEntries(parsed)
    setStep('edit')
  }

  const onConfirm = () => {
    setErr(null)
    const filled = fillEndPrinted(entries)
    const r = confirmTocWizard(filled)
    if (!r.ok) setErr(r.error || '确认失败')
  }

  return (
    <div className="toc-wizard-backdrop" role="dialog" aria-modal="true">
      <div className="toc-wizard">
        <header className="toc-wizard-head">
          <div>
            <div className="toc-wizard-title">建库向导 · 目录与页码对齐</div>
            <div className="toc-wizard-sub">
              把书上印的页码对齐到机器牌（strand），再确认目录以分配 key。可跳过（带警告）。
            </div>
          </div>
          <button
            type="button"
            className="fanout-btn"
            onClick={() => {
              skipTocWizard()
            }}
          >
            跳过（用启发式）
          </button>
        </header>

        <nav className="toc-wizard-steps">
          <span className={step === 'calibrate' ? 'on' : ''}>① 校准</span>
          <span className={step === 'pick_toc' ? 'on' : ''}>② 点目录页</span>
          <span className={step === 'edit' ? 'on' : ''}>③ 编辑</span>
          <span className={step === 'preview' ? 'on' : ''}>④ 确认</span>
        </nav>

        {step === 'calibrate' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              在左侧扑克环或下方缩略图选一页（建议选印着阿拉伯页码的正文页），然后填写你在书上看到的页码。
            </p>
            <p className="toc-wizard-p strong">
              当前选中：机器第 {currentStrand + 1} 张牌（strand {currentStrand}）
              {pages[currentStrand]?.title ? ` · ${pages[currentStrand].title}` : ''}
            </p>
            <div className="toc-thumb-row">
              {pages.slice(0, 48).map((p) => (
                <button
                  key={p.strandIndex}
                  type="button"
                  className={
                    p.strandIndex === currentStrand
                      ? 'toc-thumb on'
                      : 'toc-thumb'
                  }
                  onClick={() => swoopToPage(p.strandIndex)}
                  title={p.title}
                >
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt="" />
                  ) : (
                    <span>s{p.strandIndex}</span>
                  )}
                  <em>{p.strandIndex + 1}</em>
                </button>
              ))}
            </div>
            <label className="toc-field">
              <span>你看到的真实页码（数字）</span>
              <input
                value={printedInput}
                onChange={(e) => setPrintedInput(e.target.value)}
                placeholder="例如 15"
                inputMode="numeric"
              />
            </label>
            <div className="toc-wizard-actions">
              <button type="button" className="fanout-btn primary" onClick={onCalibrate}>
                保存校准 →
              </button>
            </div>
          </section>
        )}

        {step === 'pick_toc' && (
          <section className="toc-wizard-body">
            {calibration && (
              <p className="toc-wizard-p strong">{calibrationNote(calibration)}</p>
            )}
            <p className="toc-wizard-p">
              请点选目录所在页（可多选）。将用该页 OCR/文字解析章节与页码。
            </p>
            <div className="toc-thumb-row">
              {pages.slice(0, 48).map((p) => (
                <button
                  key={p.strandIndex}
                  type="button"
                  className={
                    tocStrands.includes(p.strandIndex)
                      ? 'toc-thumb on'
                      : 'toc-thumb'
                  }
                  onClick={() => {
                    swoopToPage(p.strandIndex)
                    toggleTocStrand(p.strandIndex)
                  }}
                >
                  {p.imageUrl ? (
                    <img src={p.imageUrl} alt="" />
                  ) : (
                    <span>s{p.strandIndex}</span>
                  )}
                  <em>{p.strandIndex + 1}</em>
                </button>
              ))}
            </div>
            <p className="toc-wizard-p">
              已选目录页：
              {tocStrands.length
                ? tocStrands.map((s) => s + 1).join(', ')
                : '无'}
            </p>
            <div className="toc-wizard-actions">
              <button type="button" className="fanout-btn" onClick={() => setStep('calibrate')}>
                ← 校准
              </button>
              <button type="button" className="fanout-btn primary" onClick={onParseToc}>
                解析目录 →
              </button>
            </div>
          </section>
        )}

        {step === 'edit' && (
          <section className="toc-wizard-body">
            <p className="toc-wizard-p">
              核对章节名与印码起止（书上页码）。结束页可自动用下一章起点 −1。
            </p>
            <div className="toc-entry-table">
              <div className="toc-entry-head">
                <span>章名</span>
                <span>起</span>
                <span>止</span>
                <span />
              </div>
              {entries.map((e, i) => (
                <div key={e.id} className="toc-entry-row">
                  <input
                    value={e.title}
                    onChange={(ev) => {
                      const v = ev.target.value
                      setEntries((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, title: v } : r)),
                      )
                    }}
                  />
                  <input
                    type="number"
                    value={e.startPrinted}
                    onChange={(ev) => {
                      const n = Number(ev.target.value)
                      setEntries((rows) =>
                        rows.map((r, j) =>
                          j === i
                            ? { ...r, startPrinted: Number.isFinite(n) ? n : r.startPrinted }
                            : r,
                        ),
                      )
                    }}
                  />
                  <input
                    type="number"
                    value={e.endPrinted}
                    onChange={(ev) => {
                      const n = Number(ev.target.value)
                      setEntries((rows) =>
                        rows.map((r, j) =>
                          j === i
                            ? { ...r, endPrinted: Number.isFinite(n) ? n : r.endPrinted }
                            : r,
                        ),
                      )
                    }}
                  />
                  <button
                    type="button"
                    className="fanout-btn"
                    onClick={() =>
                      setEntries((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    删
                  </button>
                </div>
              ))}
            </div>
            <div className="toc-wizard-actions">
              <button
                type="button"
                className="fanout-btn"
                onClick={() =>
                  setEntries((rows) => [
                    ...rows,
                    emptyTocEntry(
                      rows.length
                        ? rows[rows.length - 1].endPrinted + 1
                        : 1,
                    ),
                  ])
                }
              >
                + 加一行
              </button>
              <button type="button" className="fanout-btn" onClick={() => setStep('pick_toc')}>
                ← 目录页
              </button>
              <button
                type="button"
                className="fanout-btn primary"
                onClick={() => {
                  setEntries((rows) => fillEndPrinted(rows))
                  setStep('preview')
                }}
              >
                预览归属 →
              </button>
            </div>
          </section>
        )}

        {step === 'preview' && (
          <section className="toc-wizard-body">
            {calibration && (
              <p className="toc-wizard-p">{calibrationNote(calibration)}</p>
            )}
            <ul className="toc-preview-list">
              {previewRows.map((r) => (
                <li key={r.id} className={r.keyCount === 0 ? 'bad' : ''}>
                  <strong>{r.title}</strong>
                  <span>
                    印码 {r.startPrinted}–{r.endPrinted} → 牌 {r.startPage + 1}–
                    {r.endPage + 1} · key {r.keyCount}
                  </span>
                </li>
              ))}
            </ul>
            <div className="toc-wizard-actions">
              <button type="button" className="fanout-btn" onClick={() => setStep('edit')}>
                ← 编辑
              </button>
              <button type="button" className="fanout-btn primary" onClick={onConfirm}>
                确认目录并分配 key
              </button>
            </div>
          </section>
        )}

        {err && <p className="toc-wizard-error">{err}</p>}

        <footer className="toc-wizard-foot">
          <button type="button" className="fanout-linkish" onClick={() => closeTocWizard()}>
            先关掉向导（稍后再开）
          </button>
        </footer>
      </div>
    </div>
  )
}

/** Persistent warning when TOC was skipped */
export function TocSkipBanner() {
  const tocStatus = useIndexGate((s) => s.tocStatus)
  const openTocWizard = useIndexGate((s) => s.openTocWizard)
  if (tocStatus !== 'skipped') return null
  return (
    <div className="toc-skip-banner" role="status">
      <strong>警告：</strong>
      已跳过目录确认 · 无 TOC 闭集。提问将走全书 BM25；建议重新打开向导确认真目录。
      <button type="button" className="fanout-btn" onClick={() => openTocWizard()}>
        打开目录向导
      </button>
    </div>
  )
}
