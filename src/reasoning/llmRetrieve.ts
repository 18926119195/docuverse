/**
 * LLM closed-set retrieval: L0 pick sections, L1 pick keys.
 * Falls back to BM25 when reason API unavailable or parse fails.
 */

import { demoAuthHeaders } from './demoAuth'
import {
  loadDualModelConfig,
  reasonEndpointReady,
} from './modelRuntimeConfig'
import type { BookIndex } from './pipelineA'
import { atomSearchText, bm25Rank } from './hybridRetrieve'
import type { BookSemanticIndex } from './semanticIndex'

const MAX_TOC_LINES = 80
const MAX_KEY_ROWS = 55
const EXCERPT_MAX = 180

export interface LlmSectionPick {
  sectionIds: string[]
  usedApi: boolean
  note: string
  rationale?: string
}

export interface LlmKeyPick {
  keys: string[]
  usedApi: boolean
  note: string
  rationale?: string
}

function parseJsonBody(raw: string): unknown {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? trimmed).trim()
  return JSON.parse(body)
}

async function reasonChatJson(input: {
  system: string
  user: string
  temperature?: number
}): Promise<{ ok: true; content: string } | { ok: false; note: string }> {
  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    return { ok: false, note: '推理槽未配置' }
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
        model: reason.model,
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
        note: `LLM HTTP ${res.status}: ${errText.slice(0, 120)}`,
      }
    }
    const data: unknown = await res.json()
    if (
      typeof data !== 'object' ||
      data === null ||
      !('choices' in data) ||
      !Array.isArray((data as { choices: unknown }).choices)
    ) {
      return { ok: false, note: 'LLM 响应格式异常' }
    }
    const content =
      (
        data as { choices: Array<{ message?: { content?: string } }> }
      ).choices[0]?.message?.content ?? ''
    return { ok: true, content }
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : String(e),
    }
  }
}

export async function pickSectionsViaLlm(
  question: string,
  semantic: BookSemanticIndex,
): Promise<LlmSectionPick> {
  const q = question.trim()
  if (!q || semantic.sections.length === 0) {
    return { sectionIds: [], usedApi: false, note: '无目录' }
  }

  const tocLines = semantic.sections.slice(0, MAX_TOC_LINES).map((s) => {
    const range = s.pageRange
      ? `p${s.pageRange.startPage + 1}-${s.pageRange.endPage + 1}`
      : `p${s.page + 1}`
    return `${s.nodeId} | ${s.title.trim().slice(0, 80)} | ${range}`
  })

  const system = [
    '你是文献目录路由器。根据用户问句，从下列章/节目录（closed list）选出最可能包含答案的 1～3 个 nodeId。',
    '只输出 JSON：{"sectionIds":["..."],"confidence":"high|low","rationale":"..."}',
    'sectionIds 必须全部来自下列目录，禁止编造。无匹配则 sectionIds 为空。',
    '不要输出 markdown。',
  ].join('')

  const user = `用户问句：${q}\n\n目录（nodeId | 标题 | 页范围）：\n${tocLines.join('\n')}`

  const chat = await reasonChatJson({ system, user })
  if (!chat.ok) {
    return { sectionIds: [], usedApi: false, note: chat.note }
  }

  try {
    const parsed = parseJsonBody(chat.content) as {
      sectionIds?: unknown
      rationale?: unknown
    }
    const allowed = new Set(semantic.sections.map((s) => s.nodeId))
    const sectionIds = Array.isArray(parsed.sectionIds)
      ? parsed.sectionIds
          .filter((id): id is string => typeof id === 'string')
          .filter((id) => allowed.has(id))
          .slice(0, 4)
      : []
    const rationale =
      typeof parsed.rationale === 'string' ? parsed.rationale.trim() : undefined
    return {
      sectionIds,
      usedApi: true,
      note: sectionIds.length
        ? `LLM选廊 ${sectionIds.join(',')}`
        : 'LLM选廊·空',
      rationale,
    }
  } catch {
    return { sectionIds: [], usedApi: true, note: 'LLM选廊·JSON解析失败' }
  }
}

export async function pickKeysViaLlm(input: {
  question: string
  bookIndex: BookIndex
  allowedKeys: ReadonlySet<string>
  topK: number
}): Promise<LlmKeyPick> {
  const q = input.question.trim()
  if (!q || input.allowedKeys.size === 0) {
    return { keys: [], usedApi: false, note: '域内无 key' }
  }

  const rows: Array<{ key: string; excerpt: string; page: number }> = []
  for (const chunk of input.bookIndex.chunks) {
    if (!input.allowedKeys.has(chunk.key)) continue
    const excerpt = atomSearchText(chunk).slice(0, EXCERPT_MAX)
    if (excerpt.length < 4) continue
    rows.push({ key: chunk.key, excerpt, page: chunk.page })
  }

  if (rows.length === 0) {
    return { keys: [], usedApi: false, note: '域内无可检索 excerpt' }
  }

  let pool = rows
  if (pool.length > MAX_KEY_ROWS) {
    const ranked = bm25Rank(
      q,
      pool.map((r) => r.excerpt),
      MAX_KEY_ROWS,
    )
    pool = ranked.map((h) => pool[h.index])
  }

  const lines = pool.map(
    (r, i) =>
      `${i + 1}. key=${r.key} | strand ${r.page + 1} | ${r.excerpt.replace(/\s+/g, ' ').slice(0, EXCERPT_MAX)}`,
  )

  const system = [
    '你是文献检索器。根据问句，从下列门牌（key*）闭集中选出最相关的若干 key。',
    `最多选 ${input.topK} 个。只输出 JSON：{"keys":["..."],"confidence":"high|low","rationale":"..."}`,
    'keys 必须完全来自下列列表中的 key= 值，禁止编造。无相关则 keys 为空。',
    '不要输出 markdown。',
  ].join('')

  const user = `用户问句：${q}\n\n候选（闭集）：\n${lines.join('\n')}`

  const chat = await reasonChatJson({ system, user })
  if (!chat.ok) {
    return { keys: [], usedApi: false, note: chat.note }
  }

  try {
    const parsed = parseJsonBody(chat.content) as {
      keys?: unknown
      rationale?: unknown
    }
    const allowed = new Set(pool.map((r) => r.key))
    const keys = Array.isArray(parsed.keys)
      ? parsed.keys
          .filter((k): k is string => typeof k === 'string')
          .filter((k) => allowed.has(k))
          .slice(0, input.topK)
      : []
    const rationale =
      typeof parsed.rationale === 'string' ? parsed.rationale.trim() : undefined
    return {
      keys,
      usedApi: true,
      note: keys.length ? `LLM选门 ${keys.length}` : 'LLM选门·空',
      rationale,
    }
  } catch {
    return { keys: [], usedApi: true, note: 'LLM选门·JSON解析失败' }
  }
}
