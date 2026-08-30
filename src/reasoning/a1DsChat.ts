/**
 * A1 KEY+T → DeepSeek-V4-Flash — select doors and cast brief tags.
 * Successful briefs are hung on bookKey via KeyDecisionState (briefKey = content hash).
 */

import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import type { BookIndex } from './pipelineA'
import { a1DsPromptRules, collectA1DsRows, normalizeBriefTag, type A1DsRow } from './a1DsExport'
import { rollDoorBrief } from './keyDecisionState'

const MAX_ITEMS = 12

export type A1DsItem = {
  /** bookKey（A1 门牌） */
  key: string
  /** 门贴正文 */
  brief: string
  /** 为何与 Q 相关 */
  rationale: string
  /** 落账后的 brief 指纹（= briefContentHash） */
  briefKey?: string
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? trimmed).trim()
  const objStart = body.indexOf('{')
  if (objStart < 0) return body
  const objEnd = body.lastIndexOf('}')
  if (objEnd > objStart) return body.slice(objStart, objEnd + 1)
  return body.slice(objStart)
}

function parseJsonBody(raw: string): unknown {
  return JSON.parse(extractJsonText(raw))
}

/** 尾巴缺引号 / 截断时：截到最后一个完整的 `}` 再补 `]}` 或 `}` */
function tryParseRepaired(raw: string): unknown | null {
  const text = extractJsonText(raw)
  try {
    return JSON.parse(text)
  } catch {
    /* continue */
  }
  // 在 items 数组里，保留到最后一个完整对象
  const itemsKey = text.indexOf('"items"')
  if (itemsKey < 0) return null
  const arrStart = text.indexOf('[', itemsKey)
  if (arrStart < 0) return null
  let depth = 0
  let lastComplete = -1
  let inStr = false
  let esc = false
  for (let i = arrStart; i < text.length; i++) {
    const c = text[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) lastComplete = i
    } else if (c === ']' && depth === 0) {
      break
    }
  }
  if (lastComplete < 0) return null
  const head = text.slice(0, arrStart + 1)
  const objs = text.slice(arrStart + 1, lastComplete + 1)
  const repaired = `${head}${objs}]}`
  try {
    return JSON.parse(repaired)
  } catch {
    try {
      return JSON.parse(`${repaired.slice(0, -1)},"answer":""}`)
    } catch {
      return null
    }
  }
}

/** 正则捞完整的 key+brief 对（坏 JSON 时的兜底） */
function salvageItemsFromText(
  raw: string,
  allowed: ReadonlySet<string>,
): A1DsItem[] {
  const items: A1DsItem[] = []
  const re =
    /"key"\s*:\s*"(h1\.[^"]+)"\s*,\s*"brief"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"rationale"\s*:\s*"((?:[^"\\]|\\.)*)")?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const key = m[1]!
    if (!allowed.has(key)) continue
    const brief = normalizeBriefTag(
      m[2]!.replace(/\\"/g, '"').replace(/\\n/g, '\n'),
    )
    if (!brief) continue
    if (items.some((x) => x.key === key)) continue
    items.push({
      key,
      brief,
      rationale: (m[3] ?? '').replace(/\\"/g, '"').trim(),
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

function collectItemsFromParsed(
  parsed: { items?: unknown; answer?: unknown; rationale?: unknown },
  allowed: ReadonlySet<string>,
): { items: A1DsItem[]; answer: string } {
  const items: A1DsItem[] = []
  if (Array.isArray(parsed.items)) {
    for (const row of parsed.items) {
      if (!row || typeof row !== 'object') continue
      const r = row as { key?: unknown; brief?: unknown; rationale?: unknown }
      if (typeof r.key !== 'string' || !allowed.has(r.key)) continue
      const brief =
        typeof r.brief === 'string' ? normalizeBriefTag(r.brief) : ''
      if (!brief) continue
      if (items.some((x) => x.key === r.key)) continue
      items.push({
        key: r.key,
        brief,
        rationale: typeof r.rationale === 'string' ? r.rationale.trim() : '',
      })
      if (items.length >= MAX_ITEMS) break
    }
  }
  const answer =
    typeof parsed.answer === 'string'
      ? parsed.answer.trim()
      : typeof parsed.rationale === 'string'
        ? parsed.rationale.trim()
        : ''
  return { items, answer }
}

function parseFlashResponse(
  raw: string,
  allowed: ReadonlySet<string>,
): { items: A1DsItem[]; answer: string; recovered: boolean } {
  try {
    const parsed = parseJsonBody(raw) as {
      items?: unknown
      answer?: unknown
      rationale?: unknown
    }
    const got = collectItemsFromParsed(parsed, allowed)
    if (got.items.length > 0) {
      return { ...got, recovered: false }
    }
  } catch {
    /* fall through */
  }

  const repaired = tryParseRepaired(raw)
  if (repaired && typeof repaired === 'object') {
    const got = collectItemsFromParsed(
      repaired as { items?: unknown; answer?: unknown; rationale?: unknown },
      allowed,
    )
    if (got.items.length > 0) {
      return {
        items: got.items,
        answer: got.answer || '（JSON 已修复截断后解析）',
        recovered: true,
      }
    }
  }

  const salvaged = salvageItemsFromText(raw, allowed)
  if (salvaged.length > 0) {
    return {
      items: salvaged,
      answer: '（从破损 JSON 中捞回完整 key+brief）',
      recovered: true,
    }
  }

  return { items: [], answer: raw.trim(), recovered: false }
}

async function flashChat(input: {
  system: string
  user: string
  temperature?: number
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
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: input.temperature ?? 0,
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
    const choices = (data as { choices: Array<{ message?: { content?: string } }> })
      .choices
    const content = choices[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, note: 'LLM 空内容' }
    }
    return { ok: true, content }
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : 'LLM 请求失败',
    }
  }
}

function compactTable(rows: A1DsRow[]): string {
  return rows
    .map((r) => `KEY: \`${r.key}\`\nT:\n${r.T}\n`)
    .join('\n')
}

export type A1DsAskResult = {
  ok: boolean
  keys: string[]
  items: A1DsItem[]
  answer: string
  note: string
  packsScanned: number
}

/** One Flash call: A1 KEY+T → items[{key, brief, rationale}]；brief 挂靠 bookKey。 */
export async function askDeepSeekWithA1(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  /** 缺省=冷启整表；热启传 seedRange 展开后的 bookKey */
  candidateKeys?: string[]
  /** cold=整表点名；hot=书序区间扩搜 */
  peekMode?: 'cold' | 'hot'
  /** 热启：已开门牌（有 head）— 禁止当处女 create，仅缺口才列入 */
  openedKeys?: string[]
}): Promise<A1DsAskResult> {
  const q = input.question.trim()
  if (!q) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: '空问题',
      packsScanned: 0,
    }
  }

  const peekMode = input.peekMode ?? (input.candidateKeys?.length ? 'hot' : 'cold')
  const onlyKeys =
    input.candidateKeys && input.candidateKeys.length > 0
      ? new Set(input.candidateKeys)
      : undefined
  const preferFirst =
    peekMode === 'hot' && input.candidateKeys?.length
      ? input.candidateKeys
      : undefined

  const rows = collectA1DsRows(input.bookIndex, {
    maxTextChars: 800,
    retrievableOnly: true,
    onlyKeys,
    preferKeysFirst: preferFirst,
  })
  if (rows.length === 0) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: onlyKeys
        ? '热启 peek：seedRange 区间无可铸门牌'
        : 'A1 为空（请先上传并建库）',
      packsScanned: 0,
    }
  }

  const allowedAll = new Set(rows.map((r) => r.key))
  const opened = new Set(input.openedKeys ?? [])
  input.onProgress?.(
    peekMode === 'hot'
      ? `DeepSeek Flash · 热启 peek（书序 N=${rows.length}）→ 铸门贴…`
      : `DeepSeek Flash 读取整表 A1（${rows.length} 行 KEY+T）→ 铸门贴…`,
  )

  const system = [
    a1DsPromptRules(),
    peekMode === 'hot'
      ? [
          '【热启扩搜】只从下方书序区间勾门铸贴；禁止编造区间外 KEY。',
          opened.size > 0
            ? `已开门牌（有 head）：${[...opened].slice(0, 12).join(', ')}${opened.size > 12 ? '…' : ''} —— 禁止当处女再 create；仅当 T 相对 Q 仍有缺口才输出该 KEY 的新 brief（add/condense 语义），否则不要列入 items。`
            : '区间内优先未开 T 的门；已开勿无故重铸。',
        ].join('\n')
      : '【冷启】从整表点名勾门铸贴。',
    '只输出 JSON（可包在 ```json 里），不要散文。',
    '再次强调：brief 只能是名词·动词｜关系电报体（贴 T 原词、尽量短），禁止整句。',
  ].join('\n')

  const user = [
    `用户问题：${q}`,
    '',
    peekMode === 'hot'
      ? `A1 书序区间（${rows.length} 行 · 仅 KEY+T · 未开优先）：`
      : `A1 整表（${rows.length} 行 · 仅 KEY+T）：`,
    compactTable(rows),
  ].join('\n')

  const chat = await flashChat({ system, user, temperature: 0.1 })
  if (!chat.ok) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: chat.note,
      packsScanned: 1,
    }
  }

  const parsed = parseFlashResponse(chat.content, allowedAll)
  const { deskMonitorAttentionArrival } = await import('./attentionArrival')
  deskMonitorAttentionArrival({
    job: peekMode === 'hot' ? 'peek_hot' : 'peek_cold',
    llmText: chat.content,
  })
  const hung: A1DsItem[] = []
  for (const it of parsed.items) {
    const entry = rollDoorBrief({
      docId: input.bookIndex.docId,
      key: it.key,
      decisionBrief: it.brief,
      suggestAction: 'open',
      taskId: `a1chat_${Date.now().toString(36)}`,
    })
    hung.push({
      ...it,
      briefKey: entry.briefContentHash,
    })
  }

  const keys = hung.map((h) => h.key)
  const note =
    hung.length > 0
      ? `${parsed.recovered ? '已从破损 JSON 捞回 · ' : ''}${peekMode === 'hot' ? '热启' : '冷启'}已铸 ${hung.length} 条门贴并挂靠 bookKey · ${rows.length} 行`
      : `未得到有效 brief · ${peekMode === 'hot' ? '热启区间' : '整表'} ${rows.length} 行`

  return {
    ok: true,
    keys,
    items: hung,
    answer:
      parsed.answer ||
      (hung.length
        ? hung.map((h) => `${h.key.slice(0, 24)}…：${h.brief}`).join('\n')
        : '（无门贴）'),
    note,
    packsScanned: 1,
  }
}

/**
 * 写信台投递：薄指令 → 台按 job 契约 expand/fetch 组窗 → LLM。
 * 正文不在确认包里预打包。
 */
export async function askDeepSeekWithLetterDesk(input: {
  question: string
  packages: import('./attentionIoStore').LetterDeskPackage[]
  bookIndex: BookIndex
  docId: string
  onProgress?: (msg: string) => void
}): Promise<{ ok: boolean; answer: string; note: string }> {
  if (!input.packages.length) {
    return {
      ok: false,
      answer: '',
      note: '写信台为空：请在 Δ 上「注意力切换」并确认递交',
    }
  }
  const { dispatchLetterDesk } = await import('./letterDeskDispatch')
  return dispatchLetterDesk({
    docId: input.docId,
    bookIndex: input.bookIndex,
    packages: input.packages,
    dispatcherNote: input.question,
    onProgress: input.onProgress,
  })
}
