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
  docHasAnyBrief,
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
  parseQueryNeighbours,
  parsePathMatches,
  parseReuseJudgments,
} from './inferPath'
import { settlePeekItemsFromLlm } from './a1DsChat'
import type { InferEdge } from './attentionIoStore'
import { LOCKED_LLM } from './modelRuntimeConfig'
import { listHistoricQueryEntriesForNeighbour } from './deskEntryGate'
import {
  formatDirectedPathIncrementReturn,
  hopsFromAnswerParts,
  notesIndicatePathSettled,
} from './pathIncrementReturn'
import { keyStatusContractHint } from './keyIncrementStatus'
import { ingestKeyIncrementStatuses } from './attentionArrival'
import { briefKeysUsedByPaths } from './pathBriefExclusion'

export interface ThinSeed {
  bookKey?: string
  briefKey?: string
  question: string
  job: DeskJob
  versionIndex?: number
  /** decide 续滚：只展这些 briefKey */
  onlyBriefKeys?: string[]
  /** 监督预测轨 → decide 策略提示 */
  decideCritiqueHint?: string
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
  /** query 窗：题族角色 */
  familyRole?: 'root' | 'deepen'
  parentQueryKey?: string
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
  const io = useAttentionIo.getState()

  const push = (k: ExpandedKey) => {
    const id = `${k.kind}:${k.key}`
    if (seen.has(id)) return
    if (k.kind === 'briefKey' && !contract.allow.includes('briefKey')) return
    if (k.kind === 'bookKey' && !contract.allow.includes('bookKey')) return
    if (k.kind === 'queryKey' && !contract.allow.includes('queryKey')) return
    seen.add(id)
    keys.push(k)
  }

  /** 三态驱动：优先 sufficient；unread 仍可进窗；insufficient 默认不递送（除非窗内尚无足够 key） */
  const preferByStatus = (kind: 'briefKey' | 'bookKey' | 'queryKey', raw: string[]) => {
    const ready = new Set(io.listKeysReadyToDeliver())
    const unread = new Set(io.listKeysUnread())
    const need = new Set(io.listKeysNeedingMore())
    const hasAnyStatus = io.keyIncrementStatuses.length > 0
    if (!hasAnyStatus) {
      for (const k of raw) push({ kind, key: k })
      return
    }
    const preferred = raw.filter((k) => ready.has(k) || unread.has(k))
    const use = preferred.length > 0 ? preferred : raw.filter((k) => !need.has(k))
    const final = use.length > 0 ? use : raw
    for (const k of final) push({ kind, key: k })
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
      // insufficient book → 优先热启补贴
      const needBooks = io.listKeysNeedingMore('peek')
      if (!bookKey && needBooks.length > 0) {
        bookKey = needBooks[0]
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
      const nowQk =
        useAttentionIo.getState().findQueryKeyForQuestion(input.seeds[0]?.question ?? '') ||
        ''
      // 优先用种子 question 对应 qk；多 seed 时仍排除所有当前问文匹配
      const nowKeys = new Set<string>()
      for (const s of input.seeds) {
        const qk = useAttentionIo.getState().findQueryKeyForQuestion(s.question)
        if (qk) nowKeys.add(qk)
      }
      const historic = listHistoricQueryEntriesForNeighbour(
        [...nowKeys][0] || nowQk || undefined,
      ).filter((e) => !nowKeys.has(e.queryKey))
      preferByStatus(
        'queryKey',
        historic.map((e) => e.queryKey),
      )
      for (const k of keys) {
        if (k.kind !== 'queryKey') continue
        const hit = historic.find((e) => e.queryKey === k.key)
        if (hit) {
          k.qText = hit.qText
          k.familyRole = hit.familyRole
          k.parentQueryKey = hit.parentQueryKey
        }
      }
      continue
    }

    if (input.job === 'decide') {
      const briefKeys: string[] = []
      if (seed.onlyBriefKeys && seed.onlyBriefKeys.length > 0) {
        briefKeys.push(...seed.onlyBriefKeys)
      } else {
        if (seed.briefKey) briefKeys.push(seed.briefKey)
        else if (seed.bookKey) {
          const head = mapBookToHeadBrief(input.docId, seed.bookKey)
          if (head) briefKeys.push(head.briefKey)
        }
        const hist = io.listBriefKeysForQuestion(seed.question)
        briefKeys.push(...hist)
        // unread / insufficient from prior decide → 必须再进窗
        briefKeys.push(...io.listKeysUnread('decide'))
        briefKeys.push(...io.listKeysNeedingMore('decide'))
      }
      preferByStatus('briefKey', [...new Set(briefKeys)])
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

    if (input.job === 'infer') {
      const books: string[] = []
      let bookKey = seed.bookKey
      if (!bookKey && seed.briefKey) {
        bookKey = mapBriefToBook(input.docId, seed.briefKey)?.bookKey
      }
      if (bookKey) books.push(bookKey)
      for (const bk of io.listKeysReadyToDeliver('decide')) {
        const hit = mapBriefToBook(input.docId, bk)
        if (hit) books.push(hit.bookKey)
      }
      const histBooks = io.listBookKeysForQuestion(seed.question)
      books.push(...histBooks)
      books.push(...io.listKeysUnread('infer'))
      preferByStatus('bookKey', [...new Set(books)])
    }
  }

  return {
    keys,
    note: `expand ${input.job} · ${keys.length} keys · allow=${contract.allow.join(',')} · 三态过滤`,
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
  /** 玩法 B：钉住 ι 换方向时要避开的 inferKey 原文 */
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  /** 监督预测轨：decide 策略尸检 */
  decideCritiqueHint?: string
}): AssembledWindow {
  const contract = lookupContract(input.job)
  const lines: string[] = [`Q_now：${input.qNow}`, `契约 in：${contract.inNote}`, '']

  if (input.job === 'query') {
    lines.push('【阶段 A · query 窗 · 历史问族（含根与深化）· 无 brief】')
    for (const k of input.keys.filter((x) => x.kind === 'queryKey')) {
      const role =
        k.familyRole === 'deepen'
          ? `深化←\`${k.parentQueryKey || '?'}\``
          : '根问'
      lines.push(
        `queryKey=\`${k.key}\` · ${role}\n历史Q：${k.qText || '（无原文）'}\n`,
      )
    }
    lines.push(
      '扫完后只输出 JSON：\n' +
        '{\n' +
        '  "neighbours": [{ "queryKey": "qk_…", "degree": "相关度说明或分数" }, …],\n' +
        '  "keyStatuses": [{ "key": "qk_…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "attentionArrived": true | false\n' +
        '}\n' +
        '规则：对称输出 ⊆ 输入 historic queryKey；增量 = neighbour（该历史 Q 与 Q_now 的相关度）；\n' +
        '历史池含「根问」与「深化子问」；深化问与其父/兄可比相关度（靠拢或拉开）；\n' +
        '台对每条 settle neighbourKey，挂在对应 historic queryKey 上；\n' +
        '不出 briefKey；不得渗透 bookKey/T。\n' +
        `- ${keyStatusContractHint('queryKey')}\n` +
        '- 窗内每个 historic queryKey 都要有 status（有 neighbour≈sufficient；未看=unread；看了但不相关=insufficient）。',
    )
  } else if (input.job === 'decide') {
    if (input.decideCritiqueHint?.trim()) {
      lines.push(input.decideCritiqueHint.trim(), '')
    }
    lines.push('【brief 窗 · 仅 briefKey+brief】')
    for (const k of input.keys.filter((x) => x.kind === 'briefKey')) {
      const brief = fetchBriefText(input.docId, k.key)
      lines.push(`briefKey=\`${k.key}\`\nbrief:\n${brief}\n`)
    }
    lines.push(
      '请只输出 JSON（可围栏）：\n' +
        '{\n' +
        '  "prospects": [{ "briefKey": "bh_…", "prospect": "该 brief 解 Q_now 的一种可能", "status": "sufficient" }],\n' +
        '  "keyStatuses": [{ "key": "bh_…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "stopReason": null | "peek" | "token_full" | "off_book",\n' +
        '  "seedRange": null | { "from": "bh_…", "to": "bh_…" }\n' +
        '}\n' +
        '硬规则：\n' +
        '- 调度只看 key 三态；不要输出整窗 coverage；不要输出 keep[]（已废除）。\n' +
        '- 仅 status=sufficient 的槽才会被台铸 prospectKey；unread/insufficient 只记状态，不铸键。\n' +
        '- 未处理完的 brief → status:unread（台续滚）；已读但不够 → insufficient（可 stopReason:"peek"+seedRange）。\n' +
        '- 一槽一 prospectKey：多种可能 = 多行 prospects，或同行内嵌数组；禁止合并成一条。\n' +
        '- briefKey 必须字符级回传窗内门牌。\n' +
        `- ${keyStatusContractHint('briefKey')}\n` +
        '- 窗内每个 briefKey 都必须出现在 prospects.status 或 keyStatuses 里。',
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
    const secondPeek =
      input.keys.some((k) => k.kind === 'bookKey' && k.opened) ||
      docHasAnyBrief(input.docId)
    lines.push(
      '请只输出 JSON：\n' +
        '{\n' +
        '  "briefs":[\n' +
        '    { "key":"bookKey", "brief":"贴A", "status":"sufficient" },\n' +
        '    { "key":"同一 bookKey", "briefs":["贴B","贴C"], "status":"sufficient" }\n' +
        '  ],\n' +
        '  "keyStatuses":[{ "key":"bookKey", "status":"unread|sufficient|insufficient" }]\n' +
        '}\n' +
        `- ${keyStatusContractHint('bookKey')}\n` +
        '- 主协议是 briefs[]（items[] 已废除）。\n' +
        '- 一槽一 briefKey：多条同 key，或一行 briefs:["贴A","贴B"] 展开；禁止多贴合成一条。\n' +
        '- 仅 status=sufficient（或有 brief 未报态）才铸 briefKey；unread/insufficient 不铸键。\n' +
        (secondPeek
          ? '- 二次+ peek：用户原话若出现在窗旁注，只作修贴意图，禁止抄进 brief。'
          : '- 第一次冷启：只按固定指令从 T 铸贴，不要依赖用户问题。'),
    )
  } else if (input.job === 'supervise') {
    lines.push('【监督 · infer∥prospect 匹配】')
    lines.push(
      '（若本窗仍是 T∥brief，亦可评 Δ；path 匹配优先。）\n' +
        '请输出 JSON：\n' +
        '{\n' +
        '  "matches":[{ "inferKey":"ik_…", "prospectKey":"pk_…", "status":"sufficient|insufficient" }],\n' +
        '  "keyStatuses":[{ "key":"ik_…|pk_…", "status":"unread|sufficient|insufficient" }]\n' +
        '}\n' +
        `- ${keyStatusContractHint('inferKey/prospectKey')}`,
    )
    const books = input.keys.filter((x) => x.kind === 'bookKey')
    const briefs = input.keys.filter((x) => x.kind === 'briefKey')
    for (let i = 0; i < Math.max(books.length, briefs.length); i++) {
      const b = books[i]
      const f = briefs[i]
      const T = b ? fetchBookT(input.bookIndex, b.key).slice(0, 800) : ''
      const brief = f ? fetchBriefText(input.docId, f.key) : ''
      lines.push(
        `bookKey=\`${b?.key ?? '?'}\` briefKey=\`${f?.key ?? '?'}\`\n` +
          `T:\n${T}\nbrief:\n${brief}\n`,
      )
    }
  } else {
    // infer
    lines.push('【infer · 材料 bookKey】')
    const bookKeys = input.keys
      .filter((x) => x.kind === 'bookKey')
      .map((x) => x.key)
    for (const bk of bookKeys) {
      const T = fetchBookT(input.bookIndex, bk).slice(0, 600)
      lines.push(`bookKey=\`${bk}\`\nT:\n${T}\n`)
    }
    const excludesI = input.excludeInfers ?? []
    if (excludesI.length > 0) {
      lines.push('【排除 · 玩法 B · inferKey / ι 原文 · 勿沿此方向再推】')
      for (const e of excludesI) {
        lines.push(`inferKey=\`${e.inferKey}\`\nι原文：${e.rationale}\n`)
      }
    }
    lines.push(
      '请只输出 JSON（可围栏），结构：\n' +
        '{\n' +
        '  "attentionArrived": true | false,\n' +
        '  "materialStatus": [{ "bookKey": "…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "keyStatuses": [{ "key": "…", "status": "unread|sufficient|insufficient" }],\n' +
        '  "paths": [\n' +
        '    {\n' +
        '      "steps": [\n' +
        '        { "bookKeys": ["bk_solo"], "infer": "这一门的 T 如何解 Q_now…" },\n' +
        '        { "bookKeys": ["bk_a","bk_b"], "infer": "a 与 b 如何互撑解 Q…" },\n' +
        '        { "bookKeys": ["bk_a","bk_b","bk_c"], "infers": ["可能一…", "可能二…"] }\n' +
        '      ]\n' +
        '    }\n' +
        '  ]\n' +
        '}\n' +
        '规则：穷举「能解决 Q_now」的走法；每条 infer 与 bookKeys 组合一一对应；' +
        '多种解法必须分槽（多步或 infers[]），禁止塞进同一 infer 字段；' +
        '台对每个槽各铸 inferKey（一槽一 key）；' +
        '每步 bookKeys≥1（须来自上方材料）：单门｜二元｜多门均可；' +
        '禁止 [同一key,同一key] 自环（单门只写一个 key）；' +
        'attentionArrived=本窗材料是否已让你注意力到位（能穷举）；不能则 false；' +
        'rationale 只解释本步如何回 Q；可多条 paths；勿散文结论' +
        (excludesI.length > 0 ? '；勿把排除项当材料' : '') +
        '。\n' +
        `- ${keyStatusContractHint('bookKey')}\n` +
        '- 进入 paths 的门 = sufficient；未用 = unread 或 insufficient。',
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

/** 候选 path：neighbour 挂靠的历史 qk + 本问祖先链（深化可直用父 path） */
export function listCandidatePathsViaNeighbours(nowQueryKey?: string) {
  const st = useAttentionIo.getState()
  const qk = nowQueryKey?.trim()
  if (!qk) return []
  const historic = new Set(
    st.neighbours
      .filter((n) => n.nowQueryKey === qk)
      .map((n) => n.historicQueryKey),
  )
  // 深化：父链 path 始终可进 reuse 候选（即使尚未落 neighbour）
  for (const a of st.listQuerySelfAndAncestors(qk)) {
    if (a !== qk) historic.add(a)
  }
  if (historic.size === 0) return []
  const out: ReturnType<typeof st.listPathsForQueryKey> = []
  const seen = new Set<string>()
  for (const hq of historic) {
    for (const p of st.listPathsForQueryKey(hq)) {
      if (seen.has(p.pathKey)) continue
      seen.add(p.pathKey)
      out.push(p)
    }
  }
  return out
}

/** @deprecated 用 listCandidatePathsViaNeighbours；book 邻近扫不符合 reuse 架构 */
export function listCandidatePaths(bookKeys: string[]) {
  return useAttentionIo.getState().listPathsForBookKeys(bookKeys)
}

/** @deprecated 用 listCandidatePaths；保留给玩法 B 排除 ι */
export function listCandidateInferEdges(bookKeys: string[]): InferEdge[] {
  return useAttentionIo.getState().listInferEdgesForBookKeys(bookKeys)
}

/**
 * 复用闸：主坐标 = pathKey + 展开(infer∥prospect)；能则现 qk ──reuse──► pathKey。
 */
export async function runReuseGate(input: {
  qNow: string
  /** 用于 brief↔book 精细剔除 */
  docId?: string
  /** @deprecated 架构以 neighbour→path 为准；保留兼容 */
  bookKeys?: string[]
  queryKey?: string
  onProgress?: (msg: string) => void
}): Promise<{
  adopted: boolean
  queryKey?: string
  reuseKey?: string
  pathKey?: string
  pathKeys?: string[]
  reuseKeys?: string[]
  oldQueryKey?: string
  inferKeys?: string[]
  prospectKeys?: string[]
  judgments: ReturnType<typeof parseReuseJudgments>
  /** 失败 path 实际用过的 brief（同门其余保留） */
  excludeBriefKeys: string[]
  raw: string
  note: string
}> {
  const paths = listCandidatePathsViaNeighbours(input.queryKey)
  if (paths.length === 0) {
    return {
      adopted: false,
      judgments: [],
      excludeBriefKeys: [],
      raw: '',
      note: '复用闸：无 neighbour→path 候选（须先 queryLLM 落 neighbour）',
    }
  }

  const st = useAttentionIo.getState()
  const settled = st.settledQueries
  const lines: string[] = [
    `Q_now：${input.qNow}`,
    '',
    '【候选 path · 每条以 pathKey 为主坐标；展开 = infer ∥ prospect】',
  ]
  for (const p of paths) {
    const edge = st.inferEdges.find((e) => e.inferKey === p.inferKey)
    const prospect = st.prospects.find((x) => x.prospectKey === p.prospectKey)
    lines.push(`\npathKey=\`${p.pathKey}\``)
    lines.push(`挂靠旧 queryKey=\`${p.queryKey}\``)
    lines.push(`旧 Q：${settled[p.queryKey] ?? edge?.question ?? '（无原文）'}`)
    lines.push(`inferKey=\`${p.inferKey}\``)
    lines.push(`ι 展开：${edge?.rationale ?? '（无）'}`)
    lines.push(`prospectKey=\`${p.prospectKey}\` · briefKey=\`${prospect?.briefKey ?? '?'}\``)
    lines.push(`prospect 展开：${prospect?.text ?? '（无）'}`)
  }
  lines.push(
    '\n请判断：哪条 path 能否解决 Q_now。\n' +
      '只输出 JSON：\n' +
      '{\n' +
      '  "judgments": [\n' +
      '    { "pathKey": "ph_…", "canSolve": true|false, "status": "unread|sufficient|insufficient", "rationale": "依据…" }\n' +
      '  ],\n' +
      '  "keyStatuses": [{ "key": "ph_…", "status": "unread|sufficient|insufficient" }]\n' +
      '}\n' +
      '规则：每个候选 pathKey 一条；主坐标是 pathKey（展开 infer∥prospect）；' +
      'canSolve=true 表示可复用、不必新开主推理；禁止以正文指纹当门牌；' +
      'status：能复用=sufficient；审过不够=insufficient；未审=unread。\n' +
      `- ${keyStatusContractHint('pathKey')}`,
  )

  input.onProgress?.('写信台 · 复用闸 · LLM…')
  const chat = await flashChat({
    system: [
      '你是复用闸：只评「已有 path（infer×prospect）能否返回 / 撑住 Q_now」。',
      '主坐标是 pathKey；不写新路径；不改契约；不翻库；不靠正文指纹撞车。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
  })
  if (!chat.ok) {
    return {
      adopted: false,
      judgments: [],
      excludeBriefKeys: [],
      raw: '',
      note: `复用闸失败：${chat.note}`,
    }
  }

  ingestKeyIncrementStatuses({
    job: 'reuse',
    llmText: chat.content,
    windowKeys: paths.map((p) => p.pathKey),
  })

  let judgments = parseReuseJudgments(chat.content)
  if (judgments.length === 0 && /true|canSolve|能|不能|复用/i.test(chat.content)) {
    const hitTrue = /canSolve\s*[:=]\s*true|能解决|可以复用|足以回/i.test(
      chat.content,
    )
    judgments = paths.map((p, i) => ({
      pathKey: p.pathKey,
      inferKey: p.inferKey,
      canSolve: hitTrue && i === 0,
      rationale: chat.content.trim().slice(0, 400),
    }))
  }

  const byPath = new Map(paths.map((p) => [p.pathKey, p]))

  const failedPaths = paths.filter((p) => {
    const j = judgments.find(
      (x) => x.pathKey === p.pathKey || x.inferKey === p.inferKey,
    )
    return !j || !j.canSolve
  })
  const excludeBriefKeys = input.docId
    ? briefKeysUsedByPaths({
        docId: input.docId,
        paths: failedPaths,
        prospects: st.prospects,
        inferEdges: st.inferEdges,
      })
    : [
        ...new Set(
          failedPaths.flatMap((path) => {
            const pr = st.prospects.find((p) => p.prospectKey === path.prospectKey)
            return pr?.briefKey ? [pr.briefKey] : []
          }),
        ),
      ]

  const wins = judgments.filter((j) => j.canSolve)
  if (wins.length === 0) {
    return {
      adopted: false,
      judgments,
      excludeBriefKeys,
      raw: chat.content,
      note: `复用闸：全部不够 · ${judgments.length} 条审过 → decide/infer`,
    }
  }

  // 可多条：所有 canSolve=true 都采纳
  const adoptedRows: Array<{
    queryKey: string
    reuseKey: string
    pathKey: string
    oldQueryKey: string
    inferKeys: string[]
    prospectKeys: string[]
  }> = []
  for (const win of wins) {
    const winPath =
      byPath.get(win.pathKey) ||
      paths.find((p) => p.inferKey === win.inferKey)
    if (!winPath) continue
    const adopted = useAttentionIo.getState().adoptReusePath({
      question: input.qNow,
      pathKey: winPath.pathKey,
      rationale: win.rationale,
      queryKey: input.queryKey,
    })
    if (adopted) adoptedRows.push(adopted)
  }
  if (adoptedRows.length === 0) {
    return {
      adopted: false,
      judgments,
      excludeBriefKeys,
      raw: chat.content,
      note: `复用闸判可复用但落账失败 · wins=${wins.length}`,
    }
  }

  const first = adoptedRows[0]!
  return {
    adopted: true,
    queryKey: first.queryKey,
    reuseKey: first.reuseKey,
    pathKey: first.pathKey,
    pathKeys: adoptedRows.map((r) => r.pathKey),
    reuseKeys: adoptedRows.map((r) => r.reuseKey),
    oldQueryKey: first.oldQueryKey,
    inferKeys: [...new Set(adoptedRows.flatMap((r) => r.inferKeys))],
    prospectKeys: [...new Set(adoptedRows.flatMap((r) => r.prospectKeys))],
    judgments,
    excludeBriefKeys: [],
    raw: chat.content,
    note: `复用采纳 ×${adoptedRows.length} · paths=${adoptedRows.map((r) => r.pathKey).join(',')}`,
  }
}

async function runMainInferAndSettle(input: {
  pkg: LetterDeskPackage
  bookIndex: BookIndex
  docId: string
  keys: ExpandedKey[]
  seeds: ThinSeed[]
  excludeInfers?: Array<{ inferKey: string; rationale: string }>
  queryKey?: string
  onProgress?: (msg: string) => void
}): Promise<{ part: string; note: string }> {
  const bookKeys = input.keys
    .filter((k) => k.kind === 'bookKey')
    .map((k) => k.key)

  const win = assembleWindow({
    docId: input.docId,
    bookIndex: input.bookIndex,
    job: 'infer',
    qNow: input.pkg.question,
    seeds: input.seeds,
    keys: input.keys,
    excludeInfers: input.excludeInfers,
  })
  input.onProgress?.('写信台 · infer · LLM…')
  const chat = await flashChat({
    system: win.systemPayload,
    user: win.userPayload,
    temperature: 0.15,
    maxTokens: 8192,
    retryOnEmpty: true,
  })
  if (!chat.ok) {
    return { part: `### infer 失败\n${chat.note}`, note: chat.note }
  }

  ingestKeyIncrementStatuses({
    job: 'infer',
    llmText: chat.content,
    windowKeys: bookKeys,
  })

  let paths = parseInferPaths(chat.content)
  if (paths.length === 0) {
    // 禁止 fallback 造伪槽（会把多段内容并进错误 key）
    void fallbackInferPaths
    return {
      part: `### infer · 未解析到输出槽\n禁止用兜底合并正文。请重跑。\n--- raw ---\n${chat.content.trim()}`,
      note: 'infer 无槽 · 未落账',
    }
  }
  const bookTexts: Record<string, string> = {}
  for (const bk of bookKeys) {
    bookTexts[bk] = fetchBookT(input.bookIndex, bk)
  }
  const settled = useAttentionIo.getState().settleInferPaths({
    question: input.pkg.question,
    paths,
    bookTexts,
    queryKey: input.queryKey,
  })

  // 不在此自动监督匹配：挂起等人手；显式 skip 才跑 supervise LLM
  const userPaths = useAttentionIo
    .getState()
    .listPathsForQueryKey(settled.queryKey)
    .filter((p) => p.matchMode === 'user')
  const pending = useAttentionIo.getState().pendingPathMatch
  const pathNote =
    userPaths.length > 0
      ? `已有用户匹配 path×${userPaths.length}`
      : pending
        ? `已挂起等待用户匹配 path（infer×${pending.inferKeys.length} · prospect×${pending.prospectKeys.length}）；跳过请调 skipPendingPathMatchToSupervise`
        : '无 path 挂起'

  return {
    part:
      `### infer · 落账\n` +
      `queryKey=\`${settled.queryKey}\`\n` +
      `inferKeys: ${settled.inferKeys.map((k) => `\`${k}\``).join(', ')}\n` +
      `pathKeys(user): ${userPaths.map((p) => `\`${p.pathKey}\``).join(', ') || '∅'}\n` +
      `${pathNote}\n` +
      `--- raw ---\n${chat.content.trim()}`,
    note: `settle infer · ${settled.inferKeys.length} · userPath×${userPaths.length} · pending=${pending ? 'yes' : 'no'} · qk=${settled.queryKey}`,
  }
}

/**
 * 用户明确跳过匹配后：才跑监督 LLM 做 infer×prospect → path。
 * 若已有用户 path 或无挂起，则不再跑。
 */
export async function skipPendingPathMatchToSupervise(input?: {
  onProgress?: (msg: string) => void
}): Promise<{ pathKeys: string[]; note: string; raw: string }> {
  const st = useAttentionIo.getState()
  const pending = st.pendingPathMatch
  if (!pending) {
    const anyUser = st.paths.filter((p) => p.matchMode === 'user')
    if (anyUser.length > 0) {
      return {
        pathKeys: anyUser.map((p) => p.pathKey),
        note: '无挂起 · 已有用户 path',
        raw: '',
      }
    }
    return { pathKeys: [], note: '无挂起的 path 匹配可跳过', raw: '' }
  }
  // 清除挂起再监督（表示用户选择不匹配）
  st.clearPendingPathMatch()
  return runPathMatchSuperviseIfNeeded({
    queryKey: pending.queryKey,
    onProgress: input?.onProgress,
    force: true,
  })
}

/**
 * 仅当本轮尚无用户落账的 path、且（force 或已无 pending）时，才跑监督 LLM。
 * 默认：若仍 pending（等人手），拒绝自动跑。
 */
export async function runPathMatchSuperviseIfNeeded(input: {
  queryKey: string
  onProgress?: (msg: string) => void
  /** true = 用户已显式跳过 */
  force?: boolean
}): Promise<{ pathKeys: string[]; note: string; raw: string }> {
  const st = useAttentionIo.getState()
  const qk = input.queryKey.trim()
  const existingUser = st
    .listPathsForQueryKey(qk)
    .filter((p) => p.matchMode === 'user')
  if (existingUser.length > 0) {
    return {
      pathKeys: existingUser.map((p) => p.pathKey),
      note: `用户已匹配 path×${existingUser.length} · 不触发监督 LLM`,
      raw: '',
    }
  }
  if (st.pendingPathMatch && !input.force) {
    return {
      pathKeys: [],
      note: '仍在等待用户匹配 path · 禁止自动监督（请 settleUserPathMatches 或 skipPendingPathMatchToSupervise）',
      raw: '',
    }
  }

  const inferEdges = st.inferEdges.filter((e) => e.queryKey === qk)
  const family = new Set(st.listQuerySelfAndAncestors(qk))
  const prospects = st.prospects.filter((p) => family.has(p.queryKey))
  if (inferEdges.length === 0 || prospects.length === 0) {
    return {
      pathKeys: [],
      note: `监督匹配跳过 · ι×${inferEdges.length} · prospect×${prospects.length}`,
      raw: '',
    }
  }

  const lines: string[] = [
    `queryKey=\`${qk}\``,
    `Q：${st.settledQueries[qk] ?? ''}`,
    '',
    '【候选 inferKey】',
  ]
  for (const e of inferEdges) {
    lines.push(
      `inferKey=\`${e.inferKey}\`\nbookKeys=${e.bookKeys.map((k) => `\`${k}\``).join(',')}\nι：${e.rationale}\n`,
    )
  }
  lines.push('【候选 prospectKey】')
  for (const p of prospects) {
    lines.push(
      `prospectKey=\`${p.prospectKey}\` · briefKey=\`${p.briefKey}\`\nprospect：${p.text}\n`,
    )
  }
  lines.push(
    '\n用户已明确跳过高亮匹配。请你作为监督：判断哪些 infer 能证实/完成哪些 prospect 的预测。\n' +
      '只输出 JSON：\n' +
      '{\n' +
      '  "matches": [{ "inferKey": "ik_…", "prospectKey": "pk_…" }],\n' +
      '  "keyStatuses": [{ "key": "…", "status": "unread|sufficient|insufficient" }]\n' +
      '}\n' +
      '规则：一对一优先，允许一对多（用户想看多少调多少）；勿编造未列出的 key；无把握则 matches 为空。',
  )

  input.onProgress?.('写信台 · 监督匹配 path（用户已跳过）…')
  const chat = await flashChat({
    system: [
      '你是 path 监督：仅在用户跳过匹配后，把 infer 与 prospect 配对。',
      '匹配标准：infer 能否证实或完成 prospect 对 Q 的预测可能。',
    ].join('\n'),
    user: lines.join('\n'),
    temperature: 0.1,
  })
  if (!chat.ok) {
    return { pathKeys: [], note: `监督匹配失败：${chat.note}`, raw: '' }
  }

  ingestKeyIncrementStatuses({
    job: 'supervise',
    llmText: chat.content,
    windowKeys: [
      ...inferEdges.map((e) => e.inferKey),
      ...prospects.map((p) => p.prospectKey),
    ],
  })

  const matches = parsePathMatches(chat.content)
  if (matches.length === 0) {
    return {
      pathKeys: [],
      note: '监督 LLM 未给出有效匹配',
      raw: chat.content,
    }
  }

  const allowedIk = new Set(inferEdges.map((e) => e.inferKey))
  const allowedPk = new Set(prospects.map((p) => p.prospectKey))
  const clean = matches.filter(
    (m) => allowedIk.has(m.inferKey) && allowedPk.has(m.prospectKey),
  )
  if (clean.length === 0) {
    return {
      pathKeys: [],
      note: '监督匹配键不在候选集',
      raw: chat.content,
    }
  }

  useAttentionIo.getState().clearPendingPathMatch()
  const settled = useAttentionIo.getState().settlePaths({
    queryKey: qk,
    matches: clean.map((m) => ({
      ...m,
      matchMode: 'supervise_llm' as const,
    })),
  })
  return {
    pathKeys: settled.pathKeys,
    note: `监督 LLM 匹配 path×${settled.pathKeys.length}`,
    raw: chat.content,
  }
}

/** 薄包 → 台调度 → LLM（正文仅此处 fetch） */
export async function dispatchLetterDesk(input: {
  docId: string
  bookIndex: BookIndex
  packages: LetterDeskPackage[]
  /** 调度条上的补充说明；默认用各包 question */
  dispatcherNote?: string
  /** 本轮已铸 queryKey（方案 B）；缺则各 settle 自铸 */
  turnQueryKey?: string
  onProgress?: (msg: string) => void
}): Promise<{ ok: boolean; answer: string; note: string }> {
  if (input.packages.length === 0) {
    return { ok: false, answer: '', note: '写信台无薄指令包' }
  }

  const parts: string[] = []
  const notes: string[] = []
  const turnQueryKey = input.turnQueryKey?.trim() || undefined

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
        decideCritiqueHint: pkg.decideCritiqueHint,
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

    if (pkg.job === 'infer') {
      // infer；reuse 在前；再开时必排本问族已有 ι（狭义推理记忆，≠ reuse）
      const { priorInferKeysForQuery } = await import('./superviseCritique')
      const qkForPrior =
        turnQueryKey ||
        useAttentionIo.getState().findQueryKeyForQuestion(pkg.question) ||
        ''
      const priorIk = qkForPrior ? priorInferKeysForQuery(qkForPrior) : []
      const wantExclude = [
        ...new Set([
          ...(pkg.excludeMode === 'B' ? pkg.excludeInferKeys ?? [] : []),
          ...priorIk,
        ]),
      ]

      // 显式玩法 B / 监督换推：跳过 reuse，直开带排除的 infer
      const forceExcludeInfer =
        pkg.excludeMode === 'B' && (pkg.excludeInferKeys?.length ?? 0) > 0

      if (!forceExcludeInfer) {
        const priorPaths = listCandidatePathsViaNeighbours(turnQueryKey)
        if (priorPaths.length > 0) {
          const gate = await runReuseGate({
            qNow: pkg.question,
            docId: input.docId,
            queryKey: turnQueryKey,
            onProgress: input.onProgress,
          })
          notes.push(gate.note)
          if (gate.adopted) {
            parts.push(
              `### 复用 · 采纳旧 path ×${gate.pathKeys?.length ?? 1}（未开新 infer）\n` +
                `现 queryKey=\`${gate.queryKey}\`\n` +
                `pathKeys: ${(gate.pathKeys ?? [gate.pathKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `reuseKeys: ${(gate.reuseKeys ?? [gate.reuseKey]).map((k) => `\`${k}\``).join(', ')}\n` +
                `依据：${gate.judgments.filter((j) => j.canSolve).map((j) => j.rationale).join('；')}\n` +
                `--- gate raw ---\n${gate.raw.trim()}`,
            )
            continue
          }
          parts.push(
            `### 复用未采纳 → infer\n` +
              `${gate.note}` +
              (gate.excludeBriefKeys.length
                ? ` · 已标剔 brief×${gate.excludeBriefKeys.length}（供 decide 前置，不进 infer 窗）`
                : '') +
              `\n` +
              (gate.raw ? `--- gate raw ---\n${gate.raw.trim()}\n` : ''),
          )
        } else {
          notes.push('复用跳过·无 neighbour→path')
        }
      }

      if (wantExclude.length > 0) {
        const want = new Set(wantExclude)
        const all = useAttentionIo.getState().inferEdges
        const excludeInfers = all
          .filter((e) => want.has(e.inferKey))
          .map((e) => ({
            inferKey: e.inferKey,
            rationale: e.infer || e.rationale,
          }))
        if (excludeInfers.length === 0 && forceExcludeInfer) {
          parts.push(
            `### infer · 拒绝无差分重跑\n排除键无法解析。请钉住 ι 或走监督归因。`,
          )
          notes.push('infer 拒绝 · 排除集空解析')
          continue
        }
        if (excludeInfers.length > 0) {
          notes.push(
            `infer 必排先验 ι×${excludeInfers.length}` +
              (forceExcludeInfer ? ' · 玩法B/监督' : ' · 自动'),
          )
          const main = await runMainInferAndSettle({
            pkg,
            bookIndex: input.bookIndex,
            docId: input.docId,
            keys,
            seeds,
            excludeInfers,
            queryKey: turnQueryKey,
            onProgress: input.onProgress,
          })
          parts.push(main.part)
          notes.push(main.note)
          continue
        }
      }

      // 首次 infer（无先验 ι）
      const main = await runMainInferAndSettle({
        pkg,
        bookIndex: input.bookIndex,
        docId: input.docId,
        keys,
        seeds,
        queryKey: turnQueryKey,
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
      decideCritiqueHint:
        pkg.job === 'decide'
          ? pkg.decideCritiqueHint || seeds[0]?.decideCritiqueHint
          : undefined,
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
      ingestKeyIncrementStatuses({
        job: pkg.job,
        llmText: chat.content,
        windowKeys: keys.map((k) => k.key),
      })
      // 一槽一 key：写信台路径也必须 settle，禁止只吐文本不落账
      if (pkg.job === 'decide') {
        const { parseDecideOutcome } = await import('./autoFlow')
        const decideOut = parseDecideOutcome(chat.content)
        const allowed = keys
          .filter((k) => k.kind === 'briefKey')
          .map((k) => k.key)
        const settled = useAttentionIo.getState().settleProspects({
          question: pkg.question,
          queryKey: turnQueryKey,
          keeps: decideOut.keeps,
          allowedBriefKeys: allowed,
        })
        notes.push(
          `prospect×${settled.prospectKeys.length}` +
            (settled.rejected.length ? ` · 拒${settled.rejected.length}` : ''),
        )
        parts.push(
          `### decide · 落账\nprospectKeys: ${settled.prospectKeys.map((k) => `\`${k}\``).join(', ') || '∅'}\n--- raw ---\n${chat.content.trim()}`,
        )
      } else if (pkg.job === 'query') {
        const rows = parseQueryNeighbours(chat.content)
        const nb = useAttentionIo.getState().settleNeighbours({
          nowQuestion: pkg.question,
          nowQueryKey: turnQueryKey,
          neighbours: rows.map((n) => ({
            historicQueryKey: n.queryKey,
            degree: n.degree,
          })),
        })
        notes.push(`neighbour×${nb.neighbourKeys.length}`)
        parts.push(
          `### query · 落账\nneighbourKeys: ${nb.neighbourKeys.map((k) => `\`${k}\``).join(', ') || '∅'}\n--- raw ---\n${chat.content.trim()}`,
        )
      } else if (pkg.job === 'peek') {
        const bookKeys = keys
          .filter((k) => k.kind === 'bookKey')
          .map((k) => k.key)
        const peekSettled = settlePeekItemsFromLlm({
          docId: input.docId,
          llmText: chat.content,
          allowedBookKeys: bookKeys,
        })
        notes.push(peekSettled.note)
        parts.push(
          `### peek · 落账\nbriefKeys: ${peekSettled.items.map((i) => `\`${i.briefKey}\``).join(', ') || '∅'}\n--- raw ---\n${chat.content.trim()}`,
        )
      } else {
        parts.push(`### ${pkg.job} · out\n${chat.content.trim()}`)
      }
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
