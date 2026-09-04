/**
 * A1 KEY+T → DeepSeek-V4-Flash — select doors and cast brief tags.
 * Successful briefs are hung on bookKey via KeyDecisionState（briefKey = settle 实例）.
 */

import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
  LOCKED_LLM,
} from './modelRuntimeConfig'
import type { BookIndex } from './pipelineA'
import { a1DsPromptRules, collectA1DsRows, normalizeBriefTag, type A1DsRow } from './a1DsExport'
import {
  PEEK_BRIEF_INSTRUCTION,
  PEEK_HOT_INSTRUCTION_SUFFIX,
  PEEK_USER_ASIDE_HINT,
} from './peekInstruction'
import { rollDoorBrief } from './keyDecisionState'
import {
  normalizeIncrementStatus,
  type IncrementReadStatus,
} from './keyIncrementStatus'
import { statusAllowsMint } from './settleMint'
import { docHasAnyBrief } from './masterTableMap'

const MAX_ITEMS = 12

export type A1DsItem = {
  /** bookKey（A1 门牌） */
  key: string
  /** 门贴正文 */
  brief: string
  /** 为何与 Q 相关 */
  rationale: string
  /** 落账后的 briefKey（settle 实例） */
  briefKey?: string
  /** 输入 key 三态；仅充分才铸 briefKey */
  status?: IncrementReadStatus | null
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
  // 在 briefs 数组里，保留到最后一个完整对象
  const arrKey = text.indexOf('"briefs"')
  if (arrKey < 0) return null
  const arrStart = text.indexOf('[', arrKey)
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
function salvageBriefSlotsFromText(
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
    items.push({
      key,
      brief,
      rationale: (m[3] ?? '').replace(/\\"/g, '"').trim(),
    })
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

function pushPeekSlots(
  items: A1DsItem[],
  input: {
    key: string
    brief: string
    rationale?: string
    status?: IncrementReadStatus | null
  },
) {
  if (!input.key || !input.brief.trim()) return
  if (items.length >= MAX_ITEMS) return
  items.push({
    key: input.key,
    brief: input.brief.trim(),
    rationale: input.rationale?.trim() || '',
    status: input.status ?? null,
  })
}

/**
 * peek 主协议：briefs[]。
 * - 一元素一槽：{ key, brief }
 * - 同门多贴：多条同 key，或一行 { key, briefs:["贴A","贴B"] } 展开成多槽
 * items[] 已废除，不再解析。
 */
function collectBriefSlotsFromParsed(
  parsed: {
    briefs?: unknown
    answer?: unknown
    rationale?: unknown
  },
  allowed: ReadonlySet<string>,
): { items: A1DsItem[]; answer: string } {
  const items: A1DsItem[] = []

  const ingestRow = (r: Record<string, unknown>) => {
    const key = String(r.key ?? r.bookKey ?? '').trim()
    if (!key || !allowed.has(key)) return
    const rowStatus = normalizeIncrementStatus(r.status ?? r.readStatus)
    const rationale =
      typeof r.rationale === 'string' ? r.rationale.trim() : ''

    // 同门多贴：briefs:["贴A","贴B"] → 每元素独立槽
    const many = Array.isArray(r.briefs) ? r.briefs : null
    if (many && many.length > 0) {
      for (const b of many) {
        if (typeof b === 'string') {
          pushPeekSlots(items, {
            key,
            brief: normalizeBriefTag(b),
            rationale,
            status: rowStatus,
          })
        } else if (b && typeof b === 'object') {
          const br = b as Record<string, unknown>
          pushPeekSlots(items, {
            key,
            brief: normalizeBriefTag(String(br.brief ?? br.text ?? '')),
            rationale:
              typeof br.rationale === 'string'
                ? br.rationale.trim()
                : rationale,
            status:
              normalizeIncrementStatus(br.status ?? br.readStatus) ??
              rowStatus,
          })
        }
        if (items.length >= MAX_ITEMS) break
      }
      return
    }

    const brief =
      typeof r.brief === 'string' ? normalizeBriefTag(r.brief) : ''
    if (!brief) return
    pushPeekSlots(items, {
      key,
      brief,
      rationale,
      status: rowStatus,
    })
  }

  if (Array.isArray(parsed.briefs)) {
    for (const row of parsed.briefs) {
      if (!row || typeof row !== 'object') continue
      ingestRow(row as Record<string, unknown>)
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
      briefs?: unknown
      answer?: unknown
      rationale?: unknown
    }
    const got = collectBriefSlotsFromParsed(parsed, allowed)
    if (got.items.length > 0) {
      return { ...got, recovered: false }
    }
  } catch {
    /* fall through */
  }

  const repaired = tryParseRepaired(raw)
  if (repaired && typeof repaired === 'object') {
    const got = collectBriefSlotsFromParsed(
      repaired as { briefs?: unknown; answer?: unknown; rationale?: unknown },
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

  const salvaged = salvageBriefSlotsFromText(raw, allowed)
  if (salvaged.length > 0) {
    return {
      items: salvaged,
      answer: '（从破损 JSON 中捞回完整 key+brief）',
      recovered: true,
    }
  }

  return { items: [], answer: raw.trim(), recovered: false }
}

/** 写信台 peek 落账：一槽一 briefKey；同 bookKey 多槽不合并；仅充分才铸 */
export function settlePeekItemsFromLlm(input: {
  docId: string
  llmText: string
  allowedBookKeys: ReadonlyArray<string>
}): { items: A1DsItem[]; note: string; skipped: number } {
  const allowed = new Set(input.allowedBookKeys)
  const parsed = parseFlashResponse(input.llmText, allowed)
  const hung: A1DsItem[] = []
  let skipped = 0
  for (const it of parsed.items) {
    if (!statusAllowsMint(it.status)) {
      skipped++
      continue
    }
    const entry = rollDoorBrief({
      docId: input.docId,
      key: it.key,
      decisionBrief: it.brief,
      suggestAction: 'open',
      taskId: `desk_peek_${Date.now().toString(36)}`,
    })
    hung.push({ ...it, briefKey: entry.briefKey })
  }
  return {
    items: hung,
    skipped,
    note:
      hung.length > 0
        ? `peek 落账 briefKey×${hung.length}` +
          (skipped ? ` · 非充分跳过×${skipped}` : '') +
          (parsed.recovered ? ' · 已修复JSON' : '')
        : skipped > 0
          ? `peek 无充分槽（跳过×${skipped}）`
          : 'peek 无有效输出槽',
  }
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

/** One Flash call: A1 KEY+T → briefs[{key, brief|briefs[]}]；一槽一 briefKey。 */
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
  /**
   * 是否附用户原话旁注。
   * 缺省：热启 / 已有 brief（第二次+ peek）→ true；纯冷启第一次 → false。
   */
  attachUserUtterance?: boolean
}): Promise<A1DsAskResult> {
  const peekInstruction = PEEK_BRIEF_INSTRUCTION
  const qSide = input.question.trim()
  if (!peekInstruction) {
    return {
      ok: false,
      keys: [],
      items: [],
      answer: '',
      note: 'peek 指令缺失',
      packsScanned: 0,
    }
  }

  const peekMode = input.peekMode ?? (input.candidateKeys?.length ? 'hot' : 'cold')
  // 第二次+ peek：热启、或库内已有 brief、或调用方显式要求
  const attachUser =
    input.attachUserUtterance ??
    (peekMode === 'hot' ||
      (input.openedKeys?.length ?? 0) > 0 ||
      docHasAnyBrief(input.bookIndex.docId))
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
    peekInstruction,
    peekMode === 'hot' ? PEEK_HOT_INSTRUCTION_SUFFIX : '【冷启】从整表点名勾门铸贴。',
    attachUser
      ? '【二次+ peek】可参考用户原话旁注理解修贴意图；brief 仍只从 T 提炼。'
      : '【第一次冷启】不要依赖用户问题；只按固定指令从 T 铸贴。',
    opened.size > 0 && peekMode === 'hot'
      ? `已开门牌（有 head）：${[...opened].slice(0, 12).join(', ')}${opened.size > 12 ? '…' : ''} —— 禁止当处女再 create；仅缺口才输出新 brief。`
      : '',
    '只输出 JSON（可包在 ```json 里），不要散文。',
  ]
    .filter(Boolean)
    .join('\n')

  const user = [
    `【peek 指令】\n${peekInstruction}`,
    attachUser && qSide
      ? `${PEEK_USER_ASIDE_HINT}\n${qSide}`
      : '',
    '',
    peekMode === 'hot'
      ? `【A1 书序区间 · ${rows.length} 行 · 仅 KEY+T】`
      : `【A1 整表 · ${rows.length} 行 · 仅 KEY+T】`,
    compactTable(rows),
  ]
    .filter(Boolean)
    .join('\n')

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
    job: 'peek',
    llmText: chat.content,
    windowKeys: [...allowedAll],
  })
  const hung: A1DsItem[] = []
  let skipped = 0
  for (const it of parsed.items) {
    // 一槽一 settle：同 bookKey 多槽 → 多次 roll → 多个 briefKey（旧头进 history，不合并）
    // 仅充分铸键；未读/不充分只靠 keyStatuses 记账
    if (!statusAllowsMint(it.status)) {
      skipped++
      continue
    }
    const entry = rollDoorBrief({
      docId: input.bookIndex.docId,
      key: it.key,
      decisionBrief: it.brief,
      suggestAction: 'open',
      taskId: `a1chat_${Date.now().toString(36)}`,
    })
    hung.push({
      ...it,
      briefKey: entry.briefKey,
    })
  }

  const keys = hung.map((h) => h.key)
  const note =
    hung.length > 0
      ? `${parsed.recovered ? '已从破损 JSON 捞回 · ' : ''}${peekMode === 'hot' ? '热启' : '冷启'}已铸 ${hung.length} 条门贴并挂靠 bookKey` +
        (skipped ? ` · 非充分跳过×${skipped}` : '') +
        ` · ${rows.length} 行`
      : `未得到充分 brief · ${peekMode === 'hot' ? '热启区间' : '整表'} ${rows.length} 行` +
        (skipped ? ` · 非充分跳过×${skipped}` : '')

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
  /** 本轮 queryKey（方案 B）；自动流传入以免重复铸 */
  turnQueryKey?: string
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
    turnQueryKey: input.turnQueryKey,
    onProgress: input.onProgress,
  })
}
