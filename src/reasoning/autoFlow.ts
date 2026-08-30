/**
 * 自动流（§1.0.8 M6 + §4.4）：
 * 第一步 = 未引入 LLM I/O（纯问）。
 * 台：无 brief→冷启 peek；有 brief∧有 queryKey→阶段A→B；有 brief∧无 qk→跳过A。
 * decide：enough→reuse/mainInfer；
 *   partial→续滚 lastBriefKey 后；
 *   滚完仍不够 / stopReason:peek→热启 peek（seedRange→书序）→再 decide。
 */

import type { BookIndex } from './pipelineA'
import { askDeepSeekWithA1, askDeepSeekWithLetterDesk } from './a1DsChat'
import { atomSearchText } from './hybridRetrieve'
import { useAttentionIo, type LetterDeskPackage } from './attentionIoStore'
import { mapBriefToBook, listAllHeadBriefs } from './masterTableMap'
import { extractJsonObject, parseOrderedQueryKeys } from './inferPath'
import { resolveFirstStepBranch, listSettledQueryEntries } from './deskEntryGate'
import {
  briefsAfterCursor,
  expandSeedRangeToBookKeys,
  fallbackSeedRange,
  parseSeedRange,
  type SeedRange,
} from './seedRange'
import { deskMonitorAttentionArrival } from './attentionArrival'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
} from './pathIncrementReturn'

const MAX_HOT_PEEK = 2
const MAX_DECIDE_ROUNDS = 6

function sid(): string {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** decide out 硬闸（M1）：必须有 lastBriefKey + coverage */
export function normalizeDecideCoverage(raw: string): string {
  const s = raw.trim()
  const lower = s.toLowerCase()
  if (
    lower === 'enough' ||
    lower === 'partial' ||
    lower === 'insufficient'
  ) {
    return lower
  }
  // 模型常把 coverage 写成中文说明：按语义收成协议枚举
  if (
    /足以|足够|够了|可以回应|已覆盖|材料够|够用|commit|enough/.test(s) ||
    /足以回应|多角度.*够|核心.*覆盖/.test(s)
  ) {
    return 'enough'
  }
  if (/peek|扩搜|还要贴|缺材料|不够看/.test(s)) {
    return 'insufficient'
  }
  if (/部分|未全|还要滚|续滚|partial|继续看/.test(s)) {
    return 'partial'
  }
  // 未知长文：不当 enough，避免误开主推理
  return lower.slice(0, 48) || 'unknown'
}

export function parseDecideOutcome(llmText: string): {
  briefKeys: string[]
  lastBriefKey: string | null
  coverage: string | null
  stopReason: string | null
  seedRange: SeedRange | null
  ok: boolean
  note: string
} {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') {
    return {
      briefKeys: [],
      lastBriefKey: null,
      coverage: null,
      stopReason: null,
      seedRange: null,
      ok: false,
      note: 'decide 硬闸：无法解析 JSON',
    }
  }
  const root = obj as Record<string, unknown>
  const lastBriefKey = String(root.lastBriefKey ?? '').trim() || null
  const coverageRaw = String(root.coverage ?? '').trim()
  const coverage = coverageRaw ? normalizeDecideCoverage(coverageRaw) : null
  const stopReason = String(root.stopReason ?? '').trim() || null
  const seedRange = parseSeedRange(root.seedRange)
  const keep = root.keep
  const briefKeys: string[] = []
  if (Array.isArray(keep)) {
    for (const row of keep) {
      if (!row || typeof row !== 'object') continue
      const bk = String((row as { briefKey?: unknown }).briefKey ?? '').trim()
      if (bk) briefKeys.push(bk)
    }
  }
  if (!lastBriefKey || !coverage) {
    return {
      briefKeys: [...new Set(briefKeys)],
      lastBriefKey,
      coverage,
      stopReason,
      seedRange,
      ok: false,
      note: 'decide 硬闸：缺少 lastBriefKey 或 coverage（M1 必须有）',
    }
  }
  return {
    briefKeys: [...new Set(briefKeys)],
    lastBriefKey,
    coverage,
    stopReason,
    seedRange,
    ok: true,
    note: `decide · coverage=${coverage}` +
      (stopReason ? ` · stop=${stopReason}` : '') +
      (seedRange ? ` · seedRange` : ''),
  }
}

/** @deprecated 用 parseDecideOutcome */
export function parseDecideKeepBriefKeys(llmText: string): string[] {
  return parseDecideOutcome(llmText).briefKeys
}

async function runStageA(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
}): Promise<{ ordered: string[]; raw: string; note: string }> {
  const entries = listSettledQueryEntries()
  if (entries.length === 0) {
    return { ordered: [], raw: '', note: '阶段A跳过·无 queryKey' }
  }
  const pkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `stageA_${sid()}`,
    bookKey: '',
    briefKey: '',
    question: input.question,
    job: 'query',
    versionIndex: 0,
    createdAt: Date.now(),
  }
  const res = await askDeepSeekWithLetterDesk({
    question: input.question,
    packages: [pkg],
    bookIndex: input.bookIndex,
    docId: input.bookIndex.docId,
    onProgress: input.onProgress,
  })
  const ordered = parseOrderedQueryKeys(res.answer)
  const fallback = ordered.length > 0 ? ordered : entries.map((e) => e.queryKey)
  return {
    ordered: fallback,
    raw: res.answer,
    note: res.note || `阶段A · ${fallback.length} qk`,
  }
}

/** 按 orderedQueryKeys 展 brief，再接未挂任何已排 qk 的剩余 head brief */
function briefQueueAfterStageA(
  docId: string,
  orderedQueryKeys: string[],
): string[] {
  const heads = listAllHeadBriefs(docId)
  const settled = useAttentionIo.getState().settledQueries
  const qkBriefs = useAttentionIo.getState().queryKeyToBriefKeys
  const qBriefs = useAttentionIo.getState().questionToBriefKeys
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const qk of orderedQueryKeys) {
    for (const bk of qkBriefs[qk] ?? []) {
      if (seen.has(bk)) continue
      seen.add(bk)
      ordered.push(bk)
    }
    const qText = settled[qk]
    if (qText) {
      for (const bk of qBriefs[qText] ?? []) {
        if (seen.has(bk)) continue
        seen.add(bk)
        ordered.push(bk)
      }
    }
  }
  for (const h of heads) {
    if (seen.has(h.briefKey)) continue
    seen.add(h.briefKey)
    ordered.push(h.briefKey)
  }
  return ordered
}

function attachBriefsToQuestion(q: string, briefKeys: string[]) {
  useAttentionIo.setState((s) => ({
    questionToBriefKeys: {
      ...s.questionToBriefKeys,
      [q]: [...new Set([...(s.questionToBriefKeys[q] ?? []), ...briefKeys])],
    },
  }))
}

function wantsHotPeek(
  coverage: string,
  stopReason: string | null,
  remaining: string[],
): boolean {
  if (stopReason === 'peek') return true
  if (coverage === 'insufficient') return true
  // 队列已滚完仍 partial：升热启 peek（勿空转）
  if (coverage === 'partial' && remaining.length === 0) return true
  return false
}

/** 单问安全阀 / 暂停 → 写信台提示（不进注意力窗） */
function deskPromptSafety(msg: string) {
  useAttentionIo.getState().setDeskPrompt(msg)
  useAttentionIo.getState().setLastStatus(msg)
}

export async function runAutoFlow(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  sealItems: (items: Array<{
    key: string
    brief: string
    briefKey: string
    bookText?: string
  }>) => Array<{
    key: string
    brief: string
    briefKey: string
    bookText?: string
    bondId: string
  }>
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const q = input.question.trim()
  if (!q) {
    return { ok: false, answer: '', note: '自动流需要问句' }
  }

  const parts: string[] = []
  const notes: string[] = []
  const docId = input.bookIndex.docId

  // 自动流入口 = 第一步（composer 纯问，未引入 LLM I/O）
  const branch = resolveFirstStepBranch(docId)
  notes.push(`入口·${branch.kind}`)

  let sealedBriefKeys: string[] = []
  let sealedItems: Array<{
    key: string
    brief: string
    briefKey: string
    bondId?: string
  }> = []
  let stepId = ''

  if (branch.kind === 'peek') {
    input.onProgress?.('自动流 · 冷启 peek（无 brief）…')
    const peek = await askDeepSeekWithA1({
      question: q,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
      peekMode: 'cold',
    })
    if (!peek.ok || !peek.items?.length) {
      return {
        ok: false,
        answer: peek.answer || '',
        note: peek.note || '冷启 peek 无门贴，自动流中止',
      }
    }
    const sealed = input.sealItems(
      peek.items.map((it) => {
        const chunk = input.bookIndex.chunks.find((c) => c.key === it.key)
        return {
          key: it.key,
          brief: it.brief,
          briefKey: it.briefKey || `brief:${it.key}`,
          bookText: chunk ? atomSearchText(chunk) : undefined,
        }
      }),
    )
    sealedItems = sealed
    sealedBriefKeys = sealed.map((s) => s.briefKey)
    stepId = useAttentionIo.getState().pushPeekStep({
      mode: 'cold',
      question: q,
      items: sealed,
    })
    useAttentionIo.getState().attachBondIds(
      stepId,
      sealed.map((s) => ({ bookKey: s.key, bondId: s.bondId })),
    )
    parts.push(`### 自动流 · 冷启 peek\n${sealed.length} 门贴`)
    notes.push(`冷启peek ${sealed.length}`)
  } else if (branch.kind === 'stageA_then_brief') {
    input.onProgress?.('自动流 · 阶段 A（有 brief∧有 queryKey）…')
    const a = await runStageA({
      question: q,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
    })
    parts.push(`### 自动流 · 阶段 A\nordered=${a.ordered.join(', ') || '∅'}`)
    notes.push(a.note)
    // 台递送：窗内展开的历史 queryKey ──► 本步递出的有序 queryKey
    {
      const historic = listSettledQueryEntries().map((e) => e.queryKey)
      for (const qk of a.ordered) {
        useAttentionIo.getState().recordDeskDelivery({
          job: 'query',
          fromKeys: historic,
          toKey: qk,
        })
      }
    }
    sealedBriefKeys = briefQueueAfterStageA(docId, a.ordered)
    if (sealedBriefKeys.length === 0) {
      sealedBriefKeys = listAllHeadBriefs(docId).map((h) => h.briefKey)
    }
  } else {
    // brief_skip_A
    input.onProgress?.('自动流 · 跳过 A（有 brief∧无 queryKey）…')
    sealedBriefKeys = listAllHeadBriefs(docId).map((h) => h.briefKey)
    notes.push(`跳过A · brief×${sealedBriefKeys.length}`)
    parts.push(`### 自动流 · 跳过阶段 A\nbrief×${sealedBriefKeys.length}`)
  }

  if (sealedBriefKeys.length === 0) {
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · 无 brief 可 decide · ${notes.join(' → ')}`,
    }
  }

  attachBriefsToQuestion(q, sealedBriefKeys)

  let decideOut: ReturnType<typeof parseDecideOutcome> | null = null
  let decideScope: string[] | undefined
  let hotPeekCount = 0

  for (let round = 0; round < MAX_DECIDE_ROUNDS; round++) {
    const scope =
      decideScope && decideScope.length > 0 ? decideScope : sealedBriefKeys
    const firstBrief = scope[0]!
    const firstBook =
      mapBriefToBook(docId, firstBrief)?.bookKey ||
      sealedItems.find((s) => s.briefKey === firstBrief)?.key ||
      ''

    input.onProgress?.(
      `自动流 · decide${round > 0 ? ` · 第${round + 1}轮` : ''}…`,
    )
    const decidePkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `${stepId || 'decide'}_${firstBrief}`,
      bookKey: firstBook,
      briefKey: firstBrief,
      question: q,
      job: 'decide',
      versionIndex: 0,
      createdAt: Date.now(),
      onlyBriefKeys: decideScope,
    }
    const decideRes = await askDeepSeekWithLetterDesk({
      question: q,
      packages: [decidePkg],
      bookIndex: input.bookIndex,
      docId,
      onProgress: input.onProgress,
    })
    parts.push(decideRes.answer || '### decide · （空）')
    notes.push(decideRes.note)

    decideOut = parseDecideOutcome(decideRes.answer)
    notes.push(decideOut.note)
    deskMonitorAttentionArrival({
      job: 'decide',
      llmText: decideRes.answer,
      coverageProxy: decideOut.coverage,
    })
    if (!decideOut.ok) {
      deskPromptSafety(
        `写信台 · decide 硬闸失败：${decideOut.note}。请检查本问材料或重试。`,
      )
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · ${decideOut.note} · ${notes.join(' → ')}`,
      }
    }

    if (decideOut.coverage === 'enough') {
      break
    }

    const remaining = briefsAfterCursor(
      sealedBriefKeys,
      decideOut.lastBriefKey,
    )

    // partial 且还有未滚 brief → 续滚（非 peek）
    if (
      decideOut.coverage === 'partial' &&
      remaining.length > 0 &&
      decideOut.stopReason !== 'peek'
    ) {
      decideScope = remaining
      notes.push(`续滚 · 余 brief×${remaining.length}`)
      parts.push(`### 自动流 · 续滚\n余 ${remaining.length} brief`)
      continue
    }

    if (!wantsHotPeek(decideOut.coverage ?? '', decideOut.stopReason, remaining)) {
      deskPromptSafety(
        `写信台 · 本问自动流暂停（coverage=${decideOut.coverage}` +
          (decideOut.stopReason ? ` · ${decideOut.stopReason}` : '') +
          '）。可钉住注意力窗续调度，或换问法重试。',
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · coverage=${decideOut.coverage}` +
          (decideOut.stopReason ? ` · stop=${decideOut.stopReason}` : '') +
          `（未进 reuse/mainInfer）· ${notes.join(' → ')}`,
      }
    }

    if (hotPeekCount >= MAX_HOT_PEEK) {
      deskPromptSafety(
        `写信台 · 本问热启 peek 已达安全阀（最多 ${MAX_HOT_PEEK} 次）。请人工扩搜/换 seedRange，或钉窗旁路调度；勿空转自动流。`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · 热启 peek 安全阀触顶（${MAX_HOT_PEEK}）· ${notes.join(' → ')}`,
      }
    }

    const seed =
      decideOut.seedRange ||
      fallbackSeedRange(
        [
          ...decideOut.briefKeys,
          decideOut.lastBriefKey,
          ...sealedBriefKeys,
        ].filter(Boolean) as string[],
        decideOut.lastBriefKey,
      )

    if (!seed) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 热启 peek 无 seedRange 可兜底 · ${notes.join(' → ')}`,
      }
    }

    const expanded = expandSeedRangeToBookKeys({
      docId,
      bookIndex: input.bookIndex,
      seed,
    })
    notes.push(expanded.note)
    if (expanded.bookKeys.length === 0) {
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · ${expanded.note} · ${notes.join(' → ')}`,
      }
    }

    // 优先铸未开；区间仅已开则仍投递（修订语义）
    const candidates =
      expanded.unopened.length > 0 ? expanded.unopened : expanded.bookKeys

    input.onProgress?.(
      `自动流 · 热启 peek（seedRange · N=${candidates.length}）…`,
    )
    const hotPeek = await askDeepSeekWithA1({
      question: q,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
      peekMode: 'hot',
      candidateKeys: candidates,
      openedKeys: expanded.opened,
    })
    hotPeekCount++

    if (!hotPeek.ok || !hotPeek.items?.length) {
      parts.push(
        `### 自动流 · 热启 peek\n${hotPeek.note || '区间无新贴'}`,
      )
      notes.push(hotPeek.note || '热启peek空')
      deskPromptSafety(
        `写信台 · 热启 peek 无新门贴（${hotPeek.note || '区间空'}）。可放宽 seedRange 或旁路选手选 peek。`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · 热启 peek 无新门贴 · ${notes.join(' → ')}`,
      }
    }

    const sealed = input.sealItems(
      hotPeek.items.map((it) => {
        const chunk = input.bookIndex.chunks.find((c) => c.key === it.key)
        return {
          key: it.key,
          brief: it.brief,
          briefKey: it.briefKey || `brief:${it.key}`,
          bookText: chunk ? atomSearchText(chunk) : undefined,
        }
      }),
    )
    sealedItems = [...sealedItems, ...sealed]
    const newBriefKeys = sealed.map((s) => s.briefKey)
    sealedBriefKeys = [...new Set([...sealedBriefKeys, ...newBriefKeys])]
    attachBriefsToQuestion(q, newBriefKeys)
    stepId = useAttentionIo.getState().pushPeekStep({
      mode: 'hot',
      question: q,
      items: sealed,
    })
    useAttentionIo.getState().attachBondIds(
      stepId,
      sealed.map((s) => ({ bookKey: s.key, bondId: s.bondId })),
    )
    parts.push(`### 自动流 · 热启 peek\n${sealed.length} 门贴 · ${expanded.note}`)
    notes.push(`热启peek ${sealed.length}`)
    // 新贴入队后再压滚：本轮 decide 只看新贴（+ 可选 keep）
    decideScope = [
      ...newBriefKeys,
      ...decideOut.briefKeys.filter((k) => sealedBriefKeys.includes(k)),
    ]
    if (decideScope.length === 0) decideScope = newBriefKeys
  }

  if (!decideOut || decideOut.coverage !== 'enough') {
    deskPromptSafety(
      `写信台 · 本问 decide 轮次触顶或仍未 enough。请钉窗人工调度或换问法。`,
    )
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note:
        `自动流暂停 · decide 轮次触顶或未 enough · ${notes.join(' → ')}`,
    }
  }

  const briefKeys =
    decideOut.briefKeys.length > 0 ? decideOut.briefKeys : sealedBriefKeys

  // 台递送：decide 窗内压滚的 brief ──► keep 递交给 reuse/mainInfer 的 briefKey
  for (const bk of briefKeys) {
    useAttentionIo.getState().recordDeskDelivery({
      job: 'decide',
      fromKeys: sealedBriefKeys,
      toKey: bk,
    })
  }

  // ——— mainInfer（内含 reuse；无 ι 则直开；排除空=冷启）———
  input.onProgress?.('自动流 · reuse/mainInfer…')
  const bookKeys: string[] = []
  for (const bk of briefKeys) {
    const hit = mapBriefToBook(docId, bk)
    const bookKey =
      hit?.bookKey ?? sealedItems.find((s) => s.briefKey === bk)?.key
    if (bookKey && !bookKeys.includes(bookKey)) bookKeys.push(bookKey)
  }
  if (bookKeys.length === 0 && sealedItems.length) {
    bookKeys.push(...sealedItems.map((s) => s.key))
  }
  if (bookKeys.length === 0) {
    // keep 可能指向旧门：用当前 Q 上全部 brief 映射
    for (const bk of sealedBriefKeys) {
      const hit = mapBriefToBook(docId, bk)
      if (hit && !bookKeys.includes(hit.bookKey)) bookKeys.push(hit.bookKey)
    }
  }
  if (bookKeys.length === 0) {
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · keep 无法映射 bookKey · ${notes.join(' → ')}`,
    }
  }

  const mainPkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `${stepId || 'main'}_${bookKeys[0]}`,
    bookKey: bookKeys[0]!,
    briefKey: briefKeys[0] ?? `brief:${bookKeys[0]}`,
    question: q,
    job: 'mainInfer',
    versionIndex: 0,
    createdAt: Date.now(),
  }

  const mainRes = await askDeepSeekWithLetterDesk({
    question: q,
    packages: [mainPkg],
    bookIndex: input.bookIndex,
    docId,
    onProgress: input.onProgress,
  })
  parts.push(mainRes.answer || '### mainInfer · （空）')
  notes.push(mainRes.note)

  const mainFailed =
    !mainRes.ok ||
    /空内容|失败|HTTP|无 choices|请求失败/.test(mainRes.note)
  if (mainFailed) {
    deskPromptSafety(
      `写信台 · 主推理未写出内容（${mainRes.note}）。前序 decide 已 enough；可钉住材料窗重跑 mainInfer。`,
    )
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流 · 主推理失败 · ${notes.join(' → ')}`,
    }
  }

  deskMonitorAttentionArrival({
    job: 'mainInfer',
    llmText: mainRes.answer,
  })

  // 落账完成：写信台把整条有向路径的增量原文回填调度台
  const pathReturn = formatDirectedPathIncrementReturn({
    question: q,
    hopOutputs: hopsFromAnswerParts(parts),
    mode: 'auto',
  })

  useAttentionIo
    .getState()
    .setLastStatus(`自动流完成 · ${notes.join(' → ')}`)
  useAttentionIo.getState().clearDeskPrompt()

  return {
    ok: true,
    answer: pathReturn,
    note: `自动流 · ${notes.join(' → ')}`,
  }
}
