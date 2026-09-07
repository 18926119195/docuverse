/**
 * 自动流：
 * 第一步 = 未引入 LLM I/O（纯问）。
 * 台：无 brief→冷启 peek；有 brief∧有 queryKey→阶段A→B；有 brief∧无 qk→跳过A。
 * decide：按 key 三态驱动——充分才铸 prospect；未读续滚；不充分且无充分→热启 peek。
 * 整窗 coverage 已废，不作调度闸。
 */

import type { BookIndex } from './pipelineA'
import { askDeepSeekWithA1, askDeepSeekWithLetterDesk } from './a1DsChat'
import { atomSearchText } from './hybridRetrieve'
import { useAttentionIo, type LetterDeskPackage } from './attentionIoStore'
import { mapBriefToBook, listAllSettledBriefs } from './masterTableMap'
import { expandIncrementSlots, statusAllowsMint } from './settleMint'
import { extractJsonObject, parseQueryNeighbours } from './inferPath'
import { resolveFirstStepBranch, listSettledQueryEntries } from './deskEntryGate'
import {
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
import {
  normalizeIncrementStatus,
  type IncrementReadStatus,
} from './keyIncrementStatus'

const MAX_HOT_PEEK = 2
const MAX_DECIDE_ROUNDS = 6

function sid(): string {
  return `auto_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** @deprecated 整窗 coverage 已废；仅兼容旧 JSON，勿作调度闸 */
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
  return lower.slice(0, 48) || 'unknown'
}

export function parseDecideOutcome(llmText: string): {
  briefKeys: string[]
  keeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
  }>
  lastBriefKey: string | null
  /** @deprecated 勿作闸；仅日志 */
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
      keeps: [],
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

  const briefKeys: string[] = []
  const keeps: Array<{
    briefKey: string
    prospect: string
    status: IncrementReadStatus | null
  }> = []

  const pushKeep = (
    briefKey: string,
    prospect: string,
    status: IncrementReadStatus | null,
  ) => {
    const bk = briefKey.trim()
    const text = prospect.trim()
    if (!bk) return
    briefKeys.push(bk)
    if (!text) return
    keeps.push({ briefKey: bk, prospect: text, status })
  }

  const ingestDecideRow = (r: Record<string, unknown>) => {
    const bk = String(r.briefKey ?? r.key ?? '').trim()
    if (!bk) return
    const rowStatus = normalizeIncrementStatus(r.status ?? r.readStatus)
    const slots = expandIncrementSlots(r.prospect, r.prospects)
    if (slots.length === 0) {
      briefKeys.push(bk)
      return
    }
    for (const slot of slots) {
      const slotStatus =
        normalizeIncrementStatus(slot.statusRaw) ?? rowStatus
      pushKeep(bk, slot.text, slotStatus)
    }
  }

  // 主协议 prospects[]（keep[] 已废除）
  if (Array.isArray(root.prospects)) {
    for (const row of root.prospects) {
      if (!row || typeof row !== 'object') continue
      ingestDecideRow(row as Record<string, unknown>)
    }
  }

  const mintable = keeps.filter((k) => statusAllowsMint(k.status))
  const hasAny =
    mintable.length > 0 ||
    briefKeys.length > 0 ||
    Array.isArray(root.keyStatuses) ||
    Array.isArray(root.keyStatus) ||
    Array.isArray(root.statuses)

  if (!hasAny) {
    return {
      briefKeys: [],
      keeps: [],
      lastBriefKey,
      coverage,
      stopReason,
      seedRange,
      ok: false,
      note: 'decide 硬闸：无 prospects/keyStatuses',
    }
  }

  return {
    briefKeys: [...new Set(briefKeys)],
    keeps,
    lastBriefKey,
    coverage,
    stopReason,
    seedRange,
    ok: true,
    note:
      `decide · 三态驱动` +
      (coverage ? ` · (旧coverage=${coverage}忽略调度)` : '') +
      (stopReason ? ` · stop=${stopReason}` : '') +
      (seedRange ? ` · seedRange` : '') +
      ` · prospect槽×${keeps.length} · 可铸×${mintable.length}`,
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
}): Promise<{
  neighbours: Array<{ queryKey: string; degree: string }>
  raw: string
  note: string
}> {
  const entries = listSettledQueryEntries()
  if (entries.length === 0) {
    return { neighbours: [], raw: '', note: '阶段A跳过·无 queryKey' }
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
  let neighbours = parseQueryNeighbours(res.answer)
  if (neighbours.length === 0) {
    neighbours = entries.map((e) => ({ queryKey: e.queryKey, degree: '' }))
  }
  return {
    neighbours,
    raw: res.answer,
    note: res.note || `阶段A · neighbour×${neighbours.length}`,
  }
}

/** 按有 neighbour 的 historic queryKey 展 brief，再接其余 settled brief */
function briefQueueAfterStageA(
  docId: string,
  neighbourQueryKeys: string[],
): string[] {
  const heads = listAllSettledBriefs(docId)
  const settled = useAttentionIo.getState().settledQueries
  const qkBriefs = useAttentionIo.getState().queryKeyToBriefKeys
  const qBriefs = useAttentionIo.getState().questionToBriefKeys
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const qk of neighbourQueryKeys) {
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

function attachBriefsToQuestion(
  q: string,
  briefKeys: string[],
  queryKey?: string,
) {
  useAttentionIo.setState((s) => {
    const questionToBriefKeys = {
      ...s.questionToBriefKeys,
      [q]: [...new Set([...(s.questionToBriefKeys[q] ?? []), ...briefKeys])],
    }
    const queryKeyToBriefKeys = { ...s.queryKeyToBriefKeys }
    if (queryKey?.trim()) {
      const qk = queryKey.trim()
      queryKeyToBriefKeys[qk] = [
        ...new Set([...(queryKeyToBriefKeys[qk] ?? []), ...briefKeys]),
      ]
    }
    return { questionToBriefKeys, queryKeyToBriefKeys }
  })
}

/** 三态调度：充分可往下；未读续滚；仅不充分→热启 peek */
function decideRoundAction(input: {
  scope: string[]
  stopReason: string | null
  mintableCount: number
}): 'done' | 'continue_unread' | 'hot_peek' | 'pause' {
  const st = useAttentionIo.getState()
  const scopeSet = new Set(input.scope)
  const unread = st
    .listKeysUnread('decide')
    .filter((k) => scopeSet.has(k))
  const weak = st
    .listKeysNeedingMore('decide')
    .filter((k) => scopeSet.has(k))

  if (input.mintableCount > 0) return 'done'
  if (unread.length > 0) return 'continue_unread'
  if (input.stopReason === 'peek' || weak.length > 0) return 'hot_peek'
  return 'pause'
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
  // 本轮唯一 queryKey（方案 B settle）；贯穿 decide/prospect/infer/path/reuse
  const turnQueryKey = useAttentionIo.getState().ensureQueryKey(q)

  // 自动流入口 = 第一步（composer 纯问，未引入 LLM I/O）
  const branch = resolveFirstStepBranch(docId)
  notes.push(`入口·${branch.kind}·qk=${turnQueryKey}`)

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
      peek.items
        .filter((it) => Boolean(it.briefKey))
        .map((it) => {
          const chunk = input.bookIndex.chunks.find((c) => c.key === it.key)
          return {
            key: it.key,
            brief: it.brief,
            briefKey: it.briefKey!,
            bookText: chunk ? atomSearchText(chunk) : undefined,
          }
        }),
    )
    if (sealed.length === 0) {
      return {
        ok: false,
        answer: parts.join('\n\n'),
        note: `自动流中止 · 冷启 peek 无 settle briefKey · ${notes.join(' → ')}`,
      }
    }
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
    parts.push(
      `### 自动流 · 阶段 A\nneighbours=${a.neighbours.map((n) => `${n.queryKey}(${n.degree || '·'})`).join(', ') || '∅'}`,
    )
    notes.push(a.note)
    {
      const { ingestKeyIncrementStatuses } = await import('./attentionArrival')
      const historic = listSettledQueryEntries().map((e) => e.queryKey)
      ingestKeyIncrementStatuses({
        job: 'query',
        llmText: a.raw,
        windowKeys: historic,
      })
    }
    {
      const nb = useAttentionIo.getState().settleNeighbours({
        nowQuestion: q,
        nowQueryKey: turnQueryKey,
        neighbours: a.neighbours.map((n) => ({
          historicQueryKey: n.queryKey,
          degree: n.degree,
        })),
      })
      notes.push(`neighbour×${nb.neighbourKeys.length}`)
    }
    sealedBriefKeys = briefQueueAfterStageA(
      docId,
      a.neighbours.map((n) => n.queryKey),
    )
    if (sealedBriefKeys.length === 0) {
      sealedBriefKeys = listAllSettledBriefs(docId).map((h) => h.briefKey)
    }

    // 有历史：先 path 复用（neighbour→path）；能则停；不能则剔除再 decide
    {
      input.onProgress?.('自动流 · 先 reuse（neighbour→path）…')
      const { runReuseGate } = await import('./letterDeskDispatch')
      const gate = await runReuseGate({
        qNow: q,
        docId,
        queryKey: turnQueryKey,
        onProgress: input.onProgress,
      })
      notes.push(gate.note)
      parts.push(
        gate.adopted
          ? `### 自动流 · 复用采纳 ×${gate.pathKeys?.length ?? 1}\npaths=${(gate.pathKeys ?? [gate.pathKey]).join(', ')}`
          : `### 自动流 · 复用未采纳\n${gate.note}`,
      )
      if (gate.adopted) {
        const pathReturn = formatDirectedPathIncrementReturn({
          question: q,
          hopOutputs: hopsFromAnswerParts(parts),
          mode: 'reuse',
          queryKey: turnQueryKey,
        })
        useAttentionIo.getState().setLastStatus(`自动流 · 复用完成 · ${notes.join(' → ')}`)
        useAttentionIo.getState().clearDeskPrompt()
        return {
          ok: true,
          answer: pathReturn,
          note: `自动流 · ${notes.join(' → ')}`,
        }
      }
      const st = useAttentionIo.getState()
      // 只剔失败 path 用过的 brief；同门其余 brief 保留
      const excludeBriefs = new Set<string>(gate.excludeBriefKeys ?? [])
      for (const k of st.listKeysNeedingMore('decide')) excludeBriefs.add(k)
      if (excludeBriefs.size > 0) {
        const before = sealedBriefKeys.length
        sealedBriefKeys = sealedBriefKeys.filter((b) => !excludeBriefs.has(b))
        const unread = st.listKeysUnread('decide')
        sealedBriefKeys = [...new Set([...sealedBriefKeys, ...unread])]
        notes.push(
          `精细剔除 path 用过 brief×${excludeBriefs.size} · 余 ${sealedBriefKeys.length}（同门其余保留）`,
        )
        parts.push(
          `### 自动流 · 复用失败后精细剔除\n只剔 path 用过的 brief×${excludeBriefs.size} · 余 ${sealedBriefKeys.length}`,
        )
        void before
      }
    }
  } else {
    // brief_skip_A
    input.onProgress?.('自动流 · 跳过 A（有 brief∧无 queryKey）…')
    sealedBriefKeys = listAllSettledBriefs(docId).map((h) => h.briefKey)
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

  attachBriefsToQuestion(q, sealedBriefKeys, turnQueryKey)

  // 三态：decide 优先 sufficient ∪ unread；无状态则全量
  {
    const st = useAttentionIo.getState()
    if (st.keyIncrementStatuses.length > 0) {
      const ready = new Set(st.listKeysReadyToDeliver('decide'))
      const unread = new Set(st.listKeysUnread('decide'))
      const filtered = sealedBriefKeys.filter(
        (k) => ready.has(k) || unread.has(k) || (!ready.size && !unread.size),
      )
      if (filtered.length > 0) {
        sealedBriefKeys = filtered
        notes.push(`三态过滤 brief×${sealedBriefKeys.length}`)
      }
    }
  }

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
      windowKeys: scope,
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

    const mintable = decideOut.keeps.filter((k) => statusAllowsMint(k.status))
    const action = decideRoundAction({
      scope,
      stopReason: decideOut.stopReason,
      mintableCount: mintable.length,
    })

    if (action === 'done') {
      break
    }

    if (action === 'continue_unread') {
      const unread = useAttentionIo
        .getState()
        .listKeysUnread('decide')
        .filter((k) => scope.includes(k))
      decideScope = unread.length > 0 ? unread : scope
      notes.push(`续滚·未读 brief×${decideScope.length}`)
      parts.push(`### 自动流 · 续滚未读\n余 ${decideScope.length} brief`)
      continue
    }

    if (action === 'pause') {
      deskPromptSafety(
        `写信台 · 本问自动流暂停（三态无可铸 prospect）。可钉住注意力窗续调度，或换问法重试。`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note:
          `自动流暂停 · 三态无可铸（未进 reuse/infer）· ${notes.join(' → ')}`,
      }
    }

    // hot_peek
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

    const weakKeys = useAttentionIo
      .getState()
      .listKeysNeedingMore('decide')
      .filter((k) => scope.includes(k))
    const seed =
      decideOut.seedRange ||
      fallbackSeedRange(
        [
          ...weakKeys,
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
      hotPeek.items
        .filter((it) => Boolean(it.briefKey))
        .map((it) => {
          const chunk = input.bookIndex.chunks.find((c) => c.key === it.key)
          return {
            key: it.key,
            brief: it.brief,
            briefKey: it.briefKey!,
            bookText: chunk ? atomSearchText(chunk) : undefined,
          }
        }),
    )
    if (sealed.length === 0) {
      deskPromptSafety('写信台 · 热启 peek 未铸出 settle briefKey（仅充分才铸）。')
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `自动流暂停 · 热启无 briefKey · ${notes.join(' → ')}`,
      }
    }
    sealedItems = [...sealedItems, ...sealed]
    const newBriefKeys = sealed.map((s) => s.briefKey)
    sealedBriefKeys = [...new Set([...sealedBriefKeys, ...newBriefKeys])]
    attachBriefsToQuestion(q, newBriefKeys, turnQueryKey)
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
    // 新贴入队后再压滚：本轮 decide 只看新贴（+ 已充分 brief）
    decideScope = [
      ...newBriefKeys,
      ...decideOut.briefKeys.filter((k) => sealedBriefKeys.includes(k)),
    ]
    if (decideScope.length === 0) decideScope = newBriefKeys
  }

  const finalMintable =
    decideOut?.keeps.filter((k) => statusAllowsMint(k.status)) ?? []
  if (!decideOut || finalMintable.length === 0) {
    deskPromptSafety(
      `写信台 · 本问 decide 轮次触顶或无可铸充分 prospect。请钉窗人工调度或换问法。`,
    )
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note:
        `自动流暂停 · decide 无可铸充分 prospect · ${notes.join(' → ')}`,
    }
  }

  // 递送下游用充分 brief；铸键只走 finalMintable（settle 内再闸一次）
  const briefKeys = [
    ...new Set(finalMintable.map((k) => k.briefKey)),
  ]
  if (briefKeys.length === 0) {
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note: `自动流暂停 · 充分槽无 briefKey · ${notes.join(' → ')}`,
    }
  }

  const settledProspects = useAttentionIo.getState().settleProspects({
    question: q,
    queryKey: turnQueryKey,
    keeps: finalMintable,
    allowedBriefKeys: sealedBriefKeys,
  })
  notes.push(`prospect×${settledProspects.prospectKeys.length}`)
  if (settledProspects.rejected.length > 0) {
    notes.push(`prospect拒×${settledProspects.rejected.length}`)
  }
  if (settledProspects.prospectKeys.length === 0) {
    deskPromptSafety('写信台 · 充分 prospect 均未落账（窗门牌校验失败？）。')
    return {
      ok: true,
      answer: parts.join('\n\n'),
      note: `自动流暂停 · prospect 落账为空 · ${notes.join(' → ')}`,
    }
  }

  // 台递送：充分 briefKey → 下游（prospect 另有 brief→pk 边）
  for (const bk of briefKeys) {
    useAttentionIo.getState().recordDeskDelivery({
      job: 'decide',
      fromKeys: sealedBriefKeys,
      toKey: bk,
    })
  }

  // ——— infer（复用已在有历史时先做；此处直开 infer）———
  input.onProgress?.('自动流 · infer…')
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
    // prospects 可能指向旧门：用当前 Q 上全部 brief 映射
    for (const bk of sealedBriefKeys) {
      const hit = mapBriefToBook(docId, bk)
      if (hit && !bookKeys.includes(hit.bookKey)) bookKeys.push(hit.bookKey)
    }
  }
  if (bookKeys.length === 0) {
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流中止 · 充分 brief 无法映射 bookKey · ${notes.join(' → ')}`,
    }
  }

  const mainPkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `${stepId || 'infer'}_${bookKeys[0]}`,
    bookKey: bookKeys[0]!,
    briefKey: briefKeys[0] || '',
    question: q,
    job: 'infer',
    versionIndex: 0,
    createdAt: Date.now(),
  }

  const mainRes = await askDeepSeekWithLetterDesk({
    question: q,
    packages: [mainPkg],
    bookIndex: input.bookIndex,
    docId,
    onProgress: input.onProgress,
    turnQueryKey,
  })
  parts.push(mainRes.answer || '### infer · （空）')
  notes.push(mainRes.note)

  const mainFailed =
    !mainRes.ok ||
    /空内容|失败|HTTP|无 choices|请求失败/.test(mainRes.note)
  if (mainFailed) {
    deskPromptSafety(
      `写信台 · infer 未写出内容（${mainRes.note}）。前序 decide 已有充分 prospect；可钉住材料窗重跑 infer。`,
    )
    return {
      ok: false,
      answer: parts.join('\n\n'),
      note: `自动流 · infer 失败 · ${notes.join(' → ')}`,
    }
  }

  deskMonitorAttentionArrival({
    job: 'infer',
    llmText: mainRes.answer,
    windowKeys: bookKeys,
  })

  // path：等人手匹配；未匹配则挂起返回（禁止自动监督）
  const pending = useAttentionIo.getState().pendingPathMatch
  const userPaths = useAttentionIo
    .getState()
    .listPathsForQueryKey(turnQueryKey)
    .filter((p) => p.matchMode === 'user')
  if (userPaths.length === 0 && pending) {
    useAttentionIo.getState().setDeskPrompt(
      `写信台 · 请匹配 path：将 infer 与 prospect 高亮关联后确认；或说「跳过匹配」触发监督 LLM。` +
        ` qk=${pending.queryKey} · ι×${pending.inferKeys.length} · prospect×${pending.prospectKeys.length}`,
    )
    notes.push('等待用户 path 匹配')
    return {
      ok: true,
      answer:
        parts.join('\n\n') +
        `\n\n### 等待用户匹配 path\n` +
        `queryKey=\`${pending.queryKey}\`\n` +
        `inferKeys: ${pending.inferKeys.map((k) => `\`${k}\``).join(', ')}\n` +
        `prospectKeys: ${pending.prospectKeys.map((k) => `\`${k}\``).join(', ')}\n` +
        `请 settleUserPathMatches，或 skipPendingPathMatchToSupervise。`,
      note: `自动流 · ${notes.join(' → ')}`,
    }
  }

  const pathReturn = formatDirectedPathIncrementReturn({
    question: q,
    hopOutputs: hopsFromAnswerParts(parts),
    mode: 'auto',
    queryKey: turnQueryKey,
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
