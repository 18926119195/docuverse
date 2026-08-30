/**
 * 写信台调度：lookup(job) → 契约导向 expand → fetch → 组窗 → LLM。
 * 薄指令只含门牌；正文仅在 fetch 时从 MasterTable/A1 展开。
 */

import type { BookIndex } from './pipelineA'
import { atomSearchText } from './hybridRetrieve'
import type { DeskJob, LetterDeskPackage } from './attentionIoStore'
import { useAttentionIo } from './attentionIoStore'
import { lookupContract } from './letterDeskContracts'
import {
  doorHasBrief,
  listBriefVersionsOnDoor,
  mapBookToHeadBrief,
  mapBriefToBook,
} from './masterTableMap'
import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
} from './modelRuntimeConfig'
import {
  fallbackInferPaths,
  parseInferPaths,
  parseReuseJudgments,
} from './inferPath'
import type { InferEdge } from './attentionIoStore'
import { LOCKED_LLM } from './modelRuntimeConfig'
import { listSettledQueryEntries } from './deskEntryGate'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
  notesIndicatePathSettled,
} from './pathIncrementReturn'

export interface ThinSeed {
  bookKey?: string
  briefKey?: string
  question: string
  job: DeskJob
  versionIndex?: number
  /** decide 续滚：只展这些 briefKey */
  onlyBriefKeys?: string[]
}

export interface ExpandedKey {
  kind: 'briefKey' | 'bookKey' | 'queryKey'
  key: string
  /** peek 已开：对照贴 */
  parentBriefKey?: string
  parentBrief?: string
  opened?: boolean
  /** query 窗：历史 Q 文 */
  qText?: string
}

export interface AssembledWindow {
  job: DeskJob
  contractIn: string
  contractOut: string
  /** 给 LLM 的用户包（已按契约组好） */
  userPayload: string
  systemPayload: string
  note: string
}

function flashChat(input: {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  retryOnEmpty?: boolean
}): Promise<{ ok: true; content: string } | { ok: false; note: string }> {
  // deferred — use shared helper via dynamic path to avoid circular import weight
  return flashChatImpl(input)
}

async function flashChatImpl(input: {
  system: string
  user: string
  temperature?: number
  maxTokens?: number
  /** 空内容时再打一次（主推理偶发） */
  retryOnEmpty?: boolean
}): Promise<{ ok: true; content: string } | { ok: false; note: string }> {
  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    return { ok: false, note: '推理槽未配置（/api/llm）' }
  }
  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  const url = `${base}/chat/completions`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...demoAuthHeaders(),
  }
  if (reason.apiKey.trim() && !base.startsWith('/api/')) {
    headers.Authorization = `Bearer ${reason.apiKey.trim()}`
  }

  const once = async (): Promise<
    { ok: true; content: string } | { ok: false; note: string }
  > => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: reason.model || LOCKED_LLM.chatModel,
          temperature: input.temperature ?? 0.15,
          max_tokens: input.maxTokens ?? 4096,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
        }),
      })
      if (!res.ok) {
        const errText = await res.text()
        return {
          ok: false,
          note: `LLM HTTP ${res.status}: ${errText.slice(0, 160)}`,
        }
      }
      const data: unknown = await res.json()
      if (
        typeof data !== 'object' ||
        data === null ||
        !('choices' in data) ||
        !Array.isArray((data as { choices: unknown }).choices)
      ) {
        return { ok: false, note: 'LLM 响应无 choices' }
      }
      const choice = (
        data as {
          choices: Array<{
            finish_reason?: string
            message?: {
              content?: string | null
              reasoning_content?: string | null
              refusal?: string | null
            }
          }>
        }
      ).choices[0]
      const msg = choice?.message
      const raw =
        (typeof msg?.content === 'string' && msg.content.trim()
          ? msg.content
          : null) ||
        (typeof msg?.reasoning_content === 'string' &&
        msg.reasoning_content.trim()
          ? msg.reasoning_content
          : null) ||
        (typeof msg?.refusal === 'string' && msg.refusal.trim()
          ? msg.refusal
          : null)
      if (!raw || !raw.trim()) {
        const fr = choice?.finish_reason ?? '?'
        return {
          ok: false,
          note: `LLM 空内容 · finish_reason=${fr} · 请重试主推理或缩小材料窗`,
        }
      }
      return { ok: true, content: raw }
    } catch (e) {
      return {
        ok: false,
        note: e instanceof Error ? e.message : 'LLM 请求失败',
      }
    }
  }

  const first = await once()
  if (first.ok || !input.retryOnEmpty) return first
  if (!first.note.includes('空内容')) return first
  const second = await once()
  if (second.ok) return second
  return {
    ok: false,
    note: `${first.note} → 重试仍失败：${second.note}`,
  }
}

/**
 * 契约导向 expand：先 allow/forbid，再只走准许的 map 边。
 */
export function expandSeedsForJob(input: {
  docId: string
  job: DeskJob
  seeds: ThinSeed[]
}): { keys: ExpandedKey[]; note: string } {
  const contract = lookupContract(input.job)
  const keys: ExpandedKey[] = []
  const seen = new Set<string>()

  const push = (k: ExpandedKey) => {
    const id = `${k.kind}:${k.key}`
    if (seen.has(id)) return
    if (k.kind === 'briefKey' && !contract.allow.includes('briefKey')) return
    if (k.kind === 'bookKey' && !contract.allow.includes('bookKey')) return
    if (k.kind === 'queryKey' && !contract.allow.includes('queryKey')) return
    seen.add(id)
    keys.push(k)
  }

  for (const seed of input.seeds) {
    if (input.job === 'peek') {
      // 门况局部：briefKey → map book → 已开；bookKey → 查是否有贴
      let bookKey = seed.bookKey
      let parentBrief: string | undefined
      let parentBriefKey: string | undefined
      if (seed.briefKey) {
        const hit = mapBriefToBook(input.docId, seed.briefKey)
        if (hit) {
          bookKey = hit.bookKey
          parentBrief = hit.brief
          parentBriefKey = seed.briefKey
        }
      }
      if (!bookKey) continue
      if (parentBriefKey || doorHasBrief(input.docId, bookKey)) {
        const head = mapBookToHeadBrief(input.docId, bookKey)
        const versions = listBriefVersionsOnDoor(input.docId, bookKey)
        const ver =
          typeof seed.versionIndex === 'number'
            ? versions[seed.versionIndex]
            : undefined
        push({
          kind: 'bookKey',
          key: bookKey,
          opened: true,
          parentBriefKey:
            parentBriefKey || ver?.briefKey || head?.briefKey,
          parentBrief: parentBrief || ver?.brief || head?.brief,
        })
      } else {
        push({ kind: 'bookKey', key: bookKey, opened: false })
      }
      continue
    }

    if (input.job === 'query') {
      for (const e of listSettledQueryEntries()) {
        push({ kind: 'queryKey', key: e.queryKey, qText: e.qText })
      }
      continue
    }

    if (input.job === 'decide') {
      // 只要 briefKey：有则收；仅有 book → headBrief
      if (seed.onlyBriefKeys && seed.onlyBriefKeys.length > 0) {
        for (const bk of seed.onlyBriefKeys) {
          push({ kind: 'briefKey', key: bk })
        }
        continue
      }
      if (seed.briefKey) {
        push({ kind: 'briefKey', key: seed.briefKey })
      } else if (seed.bookKey) {
        const head = mapBookToHeadBrief(input.docId, seed.bookKey)
        if (head) push({ kind: 'briefKey', key: head.briefKey })
      }
      // 任务级复用：同 Q 下历史 briefKey
      const hist = useAttentionIo
        .getState()
        .listBriefKeysForQuestion(seed.question)
      for (const bk of hist) push({ kind: 'briefKey', key: bk })
      continue
    }

    if (input.job === 'supervise') {
      let bookKey = seed.bookKey
      let briefKey = seed.briefKey
      if (briefKey && !bookKey) {
        bookKey = mapBriefToBook(input.docId, briefKey)?.bookKey
      }
      if (bookKey && !briefKey) {
        briefKey = mapBookToHeadBrief(input.docId, bookKey)?.briefKey
      }
      if (bookKey && briefKey) {
        push({ kind: 'bookKey', key: bookKey })
        push({ kind: 'briefKey', key: briefKey })
      }
      continue
    }

    if (input.job === 'mainInfer') {
      let bookKey = seed.bookKey
      if (!bookKey && seed.briefKey) {
        bookKey = mapBriefToBook(input.docId, seed.briefKey)?.bookKey
      }
      if (bookKey) push({ kind: 'bookKey', key: bookKey })
      // 任务级：同任务历史 bookKey（材料）
      const histBooks = useAttentionIo
        .getState()
        .listBookKeysForQuestion(seed.question)
      for (const b of histBooks) push({ kind: 'bookKey', key: b })
    }
  }

  return {
    keys,
    note: `expand ${input.job} · ${keys.length} keys · allow=${contract.allow.join(',')}`,
  }
}

function fetchBookT(bookIndex: BookIndex, bookKey: string): string {
  const chunk = bookIndex.chunks.find((c) => c.key === bookKey)
  return chunk ? atomSearchText(chunk) : ''
}

function fetchBriefText(docId: string, briefKey: string): string {
  const hit = mapBriefToBook(docId, briefKey)
  return hit?.brief ?? ''
}

/**
 * bookKey 已定 → 倒查历史问法 queryKey/Q原文 → 排除槽（展开原文）
 */
export function reverseLookupExcludeQuestions(bookKeys: string[]): Array<{
  queryKey: string
  qText: string
}> {
  return useAttentionIo.getState().listQuestionsForBookKeys(bookKeys)
}

export function assembleWindow(input: {
  docId: string
  bookIndex: BookIndex
  job: DeskJob
  qNow: string
  seeds: ThinSeed[]
  keys: ExpandedKey[]
  /** 玩法 A：失败 ι 映射的排除问法；缺省则空（冷启） */
  excludeQuestions?: Array<{ queryKey: string; qText: string }>
  /** 玩法 B：要避开的 inferKey 原文 */
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
}): AssembledWindow {
  const contract = lookupContract(input.job)
  const lines: string[] = [`Q_now：${input.qNow}`, `契约 in：${contract.inNote}`, '']

  if (input.job === 'query') {
    lines.push('【阶段 A · query 窗 · 仅 queryKey+历史Q · 无 brief】')
    for (const k of input.keys.filter((x) => x.kind === 'queryKey')) {
      lines.push(
        `queryKey=\`${k.key}\`\n历史Q：${k.qText || '（无原文）'}\n`,
      )
    }
    lines.push(
      '扫完后只输出 JSON：\n' +
        '{ "orderedQueryKeys": ["qk_…", …] }\n' +
        '规则：只排序「先用哪些历史问袋子」；不出 briefKey；不得渗透 bookKey/T。',
    )
  } else if (input.job === 'decide') {
    lines.push('【brief 窗 · 仅 briefKey+brief】')
    for (const k of input.keys.filter((x) => x.kind === 'briefKey')) {
      const brief = fetchBriefText(input.docId, k.key)
      lines.push(`briefKey=\`${k.key}\`\nbrief:\n${brief}\n`)
    }
    lines.push(
      '请只输出 JSON（可围栏），字段必须齐全：\n' +
        '{\n' +
        '  "lastBriefKey": "bh_…",\n' +
        '  "keep": [{ "briefKey": "bh_…", "rationale": "为何 keep" }],\n' +
        '  "coverage": "enough" | "partial" | "insufficient",\n' +
        '  "stopReason": null | "enough" | "peek" | "token_full" | "off_book",\n' +
        '  "seedRange": null | { "from": "bh_…", "to": "bh_…" },\n' +
        '  "attentionArrived": true | false\n' +
        '}\n' +
        '硬规则：\n' +
        '- coverage 只能是上面三个英文枚举之一，禁止写成中文说明句。\n' +
        '- 就 Q_now 材料已够、可进复用/主推理 → 必须 coverage:"enough"。\n' +
        '- 还要继续滚 brief → "partial"（勿 peek；台从 lastBriefKey 下一行续）。\n' +
        '- 已有 brief 全扫完仍不够 → coverage:"insufficient" + stopReason:"peek" + seedRange（两端 briefKey，定书序扩搜区间）。\n' +
        '- 冷启无 brief 时由台进 peek，不必你出 seedRange。\n' +
        '- attentionArrived：本窗材料是否已让你注意力到位（能判断够不够）；不能判断则 false；禁止省略。\n' +
        '- rationale 里可以写中文理由；coverage 字段本身禁止散文。',
    )
  } else if (input.job === 'peek') {
    lines.push('【peek 铸贴窗】')
    for (const k of input.keys.filter((x) => x.kind === 'bookKey')) {
      const T = fetchBookT(input.bookIndex, k.key).slice(0, 800)
      if (k.opened && k.parentBrief) {
        lines.push(
          `bookKey=\`${k.key}\` opened=true\n` +
            `对照贴 briefKey=\`${k.parentBriefKey}\`:\n${k.parentBrief}\n` +
            `T:\n${T}\n` +
            `请判 noop|add|condense，输出同一 bookKey + brief 正文（台铸 briefKey）。\n`,
        )
      } else {
        lines.push(
          `bookKey=\`${k.key}\` opened=false\nT:\n${T}\n请 create：同一 bookKey + brief 正文。\n`,
        )
      }
    }
  } else if (input.job === 'supervise') {
    lines.push('【监督 · T∥brief 同场】')
    const books = input.keys.filter((x) => x.kind === 'bookKey')
    const briefs = input.keys.filter((x) => x.kind === 'briefKey')
    for (let i = 0; i < Math.max(books.length, briefs.length); i++) {
      const b = books[i]
      const f = briefs[i]
      const T = b ? fetchBookT(input.bookIndex, b.key).slice(0, 800) : ''
      const brief = f ? fetchBriefText(input.docId, f.key) : ''
      lines.push(
        `bookKey=\`${b?.key ?? '?'}\` briefKey=\`${f?.key ?? '?'}\`\n` +
          `T:\n${T}\nbrief:\n${brief}\n请评 Δ：brief 是否由 T 撑住。\n`,
      )
    }
  } else {
    // mainInfer
    lines.push('【主推理 · 材料 bookKey】')
    const bookKeys = input.keys
      .filter((x) => x.kind === 'bookKey')
      .map((x) => x.key)
    for (const bk of bookKeys) {
      const T = fetchBookT(input.bookIndex, bk).slice(0, 600)
      lines.push(`bookKey=\`${bk}\`\nT:\n${T}\n`)
    }
    const excludesQ =
      input.excludeQuestions ??
      [] /* 冷启默认空；玩法 A 由 reuse 失败侧传入 */
    const excludesI = input.excludeInfers ?? []
    if (excludesI.length > 0) {
      lines.push('【排除 · 玩法 B · inferKey / ι 原文 · 勿沿此方向再推】')
      for (const e of excludesI) {
        lines.push(`inferKey=\`${e.inferKey}\`\nι原文：${e.rationale}\n`)
      }
    } else {
      lines.push('【排除 · 玩法 A · 历史问法 Q 原文 · 勿沿此问法再推】')
      if (excludesQ.length === 0) {
        lines.push('（排除集空）')
      } else {
        for (const e of excludesQ) {
          lines.push(`queryKey=\`${e.queryKey}\`\nQ原文：${e.qText}\n`)
        }
      }
    }
    lines.push(
      '请只输出 JSON（可围栏），结构：\n' +
        '{\n' +
        '  "attentionArrived": true | false,\n' +
        '  "paths": [\n' +
        '    {\n' +
        '      "steps": [\n' +
        '        { "bookKeys": ["bk_solo"], "rationale": "这一门如何独自撑住 / 走回 Q…" },\n' +
        '        { "bookKeys": ["bk_a","bk_b"], "rationale": "a 与 b 如何互撑走向 Q…" },\n' +
        '        { "bookKeys": ["bk_a","bk_b","bk_c"], "rationale": "多门并肩如何一起走向 Q…" }\n' +
        '      ]\n' +
        '    }\n' +
        '  ]\n' +
        '}\n' +
        '规则：穷举「能回到 Q_now」的走法，能则各落一条 path/step；' +
        '每步 bookKeys≥1（须来自上方材料）：单门独自｜二元互撑｜多门并肩均可；' +
        '禁止 [同一key,同一key] 自环（单门只写一个 key）；' +
        'attentionArrived=本窗材料是否已让你注意力到位（能穷举回 Q）；不能则 false；' +
        'rationale 只解释本步如何回 Q；可多条 paths；勿散文结论；勿把排除项当材料。',
    )
  }

  return {
    job: input.job,
    contractIn: contract.inNote,
    contractOut: contract.outNote,
    userPayload: lines.join('\n'),
    systemPayload: [
      `你执行写信台契约「${input.job}」。`,
      `in：${contract.inNote}`,
      `out：${contract.outNote}`,
      '禁止改契约；禁止把排除项当材料；禁止闲聊。',
    ].join('\n'),
    note: `组窗 ${input.job} · keys=${input.keys.length}`,
  }
}

/** 候选 ι：材料门上的已落账 inferKey 边（复用闸 in 主坐标） */
export function listCandidateInferEdges(bookKeys: string[]): InferEdge[] {
  return useAttentionIo.getState().listInferEdgesForBookKeys(bookKeys)
}

/**
 * 复用闸：LLM 主坐标 = inferKey + 展开；能则 ι→旧 queryKey 挂边。
 */
export async function runReuseGate(input: {
  qNow: string
  priorEdges: InferEdge[]
  onProgress?: (msg: string) => void
}): Promise<{
  adopted: boolean
  queryKey?: string
  oldQueryKey?: string
  inferKeys?: string[]
  judgments: ReturnType<typeof parseReuseJudgments>
  /** 玩法 A 排除：失败 ι → 旧 qk + Q 原文 */
  excludeQuestions: Array<{ queryKey: string; qText: string }>
  raw: string
  note: string
}> {
  const edges = input.priorEdges
  if (edges.length === 0) {
    return {
      adopted: false,
      judgments: [],
      excludeQuestions: [],
      raw: '',
      note: '复用闸：无候选 inferKey',
    }
  }

  const settled = useAttentionIo.getState().settledQueries
  const lines: string[] = [
    `Q_now：${input.qNow}`,
    '',
    '【候选 ι · 每条以 inferKey 为主坐标】',
  ]
  for (const e of edges) {
    lines.push(`\ninferKey=\`${e.inferKey}\``)
    const bks = e.bookKeys?.length ? e.bookKeys : [e.fromBookKey, e.toBookKey]
    if (bks.length <= 1 || e.fromBookKey === e.toBookKey) {
      lines.push(`形态：单门独自 → Q · book=\`${e.fromBookKey}\``)
    } else if (bks.length === 2) {
      lines.push(`形态：二元互撑 · ${e.fromBookKey} ──(${e.inferKey})── ${e.toBookKey}`)
    } else {
      lines.push(`形态：${bks.length} 门并肩 · ${bks.map((k) => `\`${k}\``).join(' ∥ ')}`)
    }
    lines.push(`挂靠旧 queryKey=\`${e.queryKey}\``)
    lines.push(`旧 Q：${settled[e.queryKey] ?? e.question ?? '（无原文）'}`)
    lines.push(`ι 展开（rationale）：${e.rationale}`)
  }
  lines.push(
    '\n请判断：哪条（哪些）ι 路径能否解决 Q_now。\n' +
      '只输出 JSON：\n' +
      '{\n' +
      '  "judgments": [\n' +
      '    { "inferKey": "ι_…", "canSolve": true|false, "rationale": "依据…" }\n' +
      '  ]\n' +
      '}\n' +
      '规则：每个候选 inferKey 一条；禁止以旧 queryKey 为 LLM 主坐标；canSolve=true 表示可复用、不必新开主推理。',
  )

  input.onProgress?.('写信台 · 复用闸 · LLM…')
  const chat = await flashChat({
    system: [
      '你是复用闸：只评「已有 inferKey 边链能否返回 / 撑住 Q_now」。',
      '主坐标是 inferKey；不写新路径；不改契约；不翻库。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
  })
  if (!chat.ok) {
    return {
      adopted: false,
      judgments: [],
      excludeQuestions: [],
      raw: '',
      note: `复用闸失败：${chat.note}`,
    }
  }

  let judgments = parseReuseJudgments(chat.content)
  if (judgments.length === 0 && /true|canSolve|能|不能|复用/i.test(chat.content)) {
    const hitTrue = /canSolve\s*[:=]\s*true|能解决|可以复用|足以回/i.test(
      chat.content,
    )
    judgments = edges.map((e, i) => ({
      inferKey: e.inferKey,
      canSolve: hitTrue && i === 0,
      rationale: chat.content.trim().slice(0, 400),
    }))
  }

  const byInfer = new Map(edges.map((e) => [e.inferKey, e]))
  const failedQs = new Map<string, string>()
  for (const j of judgments) {
    if (j.canSolve) continue
    const edge = byInfer.get(j.inferKey)
    if (!edge) continue
    const qText = settled[edge.queryKey] ?? edge.question ?? ''
    if (qText.trim()) failedQs.set(edge.queryKey, qText)
  }
  // 未出现在 judgments 里的候选也视作不能
  for (const e of edges) {
    if (judgments.some((j) => j.inferKey === e.inferKey)) continue
    const qText = settled[e.queryKey] ?? e.question ?? ''
    if (qText.trim()) failedQs.set(e.queryKey, qText)
  }
  const excludeQuestions = [...failedQs.entries()].map(([queryKey, qText]) => ({
    queryKey,
    qText,
  }))

  const win = judgments.find((j) => j.canSolve)
  if (!win) {
    return {
      adopted: false,
      judgments,
      excludeQuestions,
      raw: chat.content,
      note: `复用闸：全部不够 · ${judgments.length} 条审过 → mainInfer 玩法 A`,
    }
  }

  const winEdge = byInfer.get(win.inferKey)
  if (!winEdge) {
    return {
      adopted: false,
      judgments,
      excludeQuestions,
      raw: chat.content,
      note: `复用闸：inferKey=${win.inferKey} 不在候选集`,
    }
  }

  const adopted = useAttentionIo.getState().adoptReusePath({
    question: input.qNow,
    oldQueryKey: winEdge.queryKey,
    rationale: win.rationale,
  })
  if (!adopted) {
    return {
      adopted: false,
      judgments,
      excludeQuestions,
      raw: chat.content,
      note: `复用闸判可复用但落账失败 · ι=${win.inferKey}`,
    }
  }

  return {
    adopted: true,
    queryKey: adopted.queryKey,
    oldQueryKey: adopted.oldQueryKey,
    inferKeys: adopted.inferKeys,
    judgments,
    excludeQuestions: [],
    raw: chat.content,
    note: `复用采纳 · ι=${win.inferKey} · ${adopted.queryKey} → ${adopted.oldQueryKey}`,
  }
}

async function runMainInferAndSettle(input: {
  pkg: LetterDeskPackage
  bookIndex: BookIndex
  docId: string
  keys: ExpandedKey[]
  seeds: ThinSeed[]
  excludeQuestions?: Array<{ queryKey: string; qText: string }>
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  onProgress?: (msg: string) => void
}): Promise<{ part: string; note: string }> {
  const bookKeys = input.keys
    .filter((k) => k.kind === 'bookKey')
    .map((k) => k.key)

  const win = assembleWindow({
    docId: input.docId,
    bookIndex: input.bookIndex,
    job: 'mainInfer',
    qNow: input.pkg.question,
    seeds: input.seeds,
    keys: input.keys,
    excludeQuestions: input.excludeQuestions,
    excludeInfers: input.excludeInfers,
  })
  input.onProgress?.('写信台 · mainInfer · LLM…')
  const chat = await flashChat({
    system: win.systemPayload,
    user: win.userPayload,
    temperature: 0.15,
    maxTokens: 8192,
    retryOnEmpty: true,
  })
  if (!chat.ok) {
    return { part: `### mainInfer 失败\n${chat.note}`, note: chat.note }
  }

  let paths = parseInferPaths(chat.content)
  const usedFallback = paths.length === 0
  if (usedFallback) {
    paths = fallbackInferPaths(bookKeys, chat.content)
  }
  const bookTexts: Record<string, string> = {}
  for (const bk of bookKeys) {
    bookTexts[bk] = fetchBookT(input.bookIndex, bk)
  }
  const settled = useAttentionIo.getState().settleInferPaths({
    question: input.pkg.question,
    paths,
    bookTexts,
  })
  return {
    part:
      `### mainInfer · 落账\n` +
      `queryKey=\`${settled.queryKey}\`\n` +
      `inferKeys: ${settled.inferKeys.map((k) => `\`${k}\``).join(', ')}\n` +
      `${usedFallback ? '（JSON 解析失败 → 按材料顺序兜底成边）\n' : ''}` +
      `--- raw ---\n${chat.content.trim()}`,
    note: `settle infer · ${settled.inferKeys.length} edges · qk=${settled.queryKey}`,
  }
}

/** 薄包 → 台调度 → LLM（正文仅此处 fetch） */
export async function dispatchLetterDesk(input: {
  docId: string
  bookIndex: BookIndex
  packages: LetterDeskPackage[]
  /** 调度条上的补充说明；默认用各包 question */
  dispatcherNote?: string
  onProgress?: (msg: string) => void
}): Promise<{ ok: boolean; answer: string; note: string }> {
  if (input.packages.length === 0) {
    return { ok: false, answer: '', note: '写信台无薄指令包' }
  }

  const parts: string[] = []
  const notes: string[] = []

  for (const pkg of input.packages) {
    input.onProgress?.(`写信台 · ${pkg.job} · expand…`)
    const seeds: ThinSeed[] = [
      {
        bookKey: pkg.bookKey || undefined,
        briefKey: pkg.briefKey || undefined,
        question: pkg.question,
        job: pkg.job,
        versionIndex: pkg.versionIndex,
        onlyBriefKeys: pkg.onlyBriefKeys,
      },
    ]
    const { keys, note: expNote } = expandSeedsForJob({
      docId: input.docId,
      job: pkg.job,
      seeds,
    })
    notes.push(expNote)
    if (keys.length === 0) {
      parts.push(
        `### ${pkg.job} · 无法组窗（expand 空）\nseed book=${pkg.bookKey} brief=${pkg.briefKey}`,
      )
      continue
    }

    if (pkg.job === 'mainInfer') {
      const bookKeys = keys
        .filter((k) => k.kind === 'bookKey')
        .map((k) => k.key)
      const prior = listCandidateInferEdges(bookKeys)

      let excludeQuestions: Array<{ queryKey: string; qText: string }> = []
      let excludeInfers: Array<{ inferKey: string; rationale: string }> | undefined

      if (pkg.excludeMode === 'B' && (pkg.excludeInferKeys?.length ?? 0) > 0) {
        const want = new Set(pkg.excludeInferKeys)
        const all = useAttentionIo.getState().inferEdges
        excludeInfers = all
          .filter((e) => want.has(e.inferKey))
          .map((e) => ({ inferKey: e.inferKey, rationale: e.rationale }))
        notes.push(`mainInfer 玩法 B · 排除 ι×${excludeInfers.length}`)
        const main = await runMainInferAndSettle({
          pkg,
          bookIndex: input.bookIndex,
          docId: input.docId,
          keys,
          seeds,
          excludeInfers,
          onProgress: input.onProgress,
        })
        parts.push(main.part)
        notes.push(main.note)
        continue
      }

      if (prior.length > 0) {
        const gate = await runReuseGate({
          qNow: pkg.question,
          priorEdges: prior,
          onProgress: input.onProgress,
        })
        notes.push(gate.note)
        if (gate.adopted) {
          parts.push(
            `### 复用闸 · 采纳旧路径（未开新主推理）\n` +
              `现 queryKey=\`${gate.queryKey}\`\n` +
              `旧 queryKey=\`${gate.oldQueryKey}\`（增量边）\n` +
              `显影 inferKeys: ${(gate.inferKeys ?? []).map((k) => `\`${k}\``).join(', ')}\n` +
              `依据：${gate.judgments.find((j) => j.canSolve)?.rationale ?? ''}\n` +
              `--- gate raw ---\n${gate.raw.trim()}`,
          )
          continue
        }
        excludeQuestions = gate.excludeQuestions
        parts.push(
          `### 复用闸 · 未采纳 → mainInfer 玩法 A\n` +
            `${gate.note}\n` +
            (gate.raw
              ? `--- gate raw ---\n${gate.raw.trim()}\n`
              : ''),
        )
      } else {
        notes.push('复用闸：无候选 ι → 直开主推理（排除空）')
      }

      const main = await runMainInferAndSettle({
        pkg,
        bookIndex: input.bookIndex,
        docId: input.docId,
        keys,
        seeds,
        excludeQuestions,
        onProgress: input.onProgress,
      })
      parts.push(main.part)
      notes.push(main.note)
      continue
    }

    const win = assembleWindow({
      docId: input.docId,
      bookIndex: input.bookIndex,
      job: pkg.job,
      qNow: pkg.question,
      seeds,
      keys,
    })
    notes.push(win.note)
    input.onProgress?.(`写信台 · ${pkg.job} · LLM…`)
    const chat = await flashChat({
      system: win.systemPayload,
      user: win.userPayload,
      temperature: 0.15,
    })
    if (!chat.ok) {
      parts.push(`### ${pkg.job} 失败\n${chat.note}`)
    } else {
      parts.push(`### ${pkg.job} · out\n${chat.content.trim()}`)
    }
  }

  const joined = parts.join('\n\n')
  const q =
    input.packages.map((p) => p.question.trim()).find(Boolean) ||
    input.dispatcherNote?.trim() ||
    ''
  // 整条路径落账（新铸 qk 或复用旧 qk）后：有向增量原文回填调度台
  const answer =
    q && notesIndicatePathSettled(notes)
      ? formatDirectedPathIncrementReturn({
          question: q,
          hopOutputs: hopsFromAnswerParts(parts),
          mode: 'auto',
        })
      : joined

  return {
    ok: parts.length > 0,
    answer,
    note: notes.join(' · '),
  }
}
