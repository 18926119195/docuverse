/**
 * Optional query rewrite for document-language terms (legacy).
 * Main retrieve funnel uses user question directly — LLM closed-set + BM25.
 */

import { demoAuthHeaders } from './demoAuth'
import { loadDualModelConfig, reasonEndpointReady } from './modelRuntimeConfig'

export interface QueryExpandResult {
  /** Original user question */
  original: string
  /** Query string used for BM25 retrieval */
  searchQuery: string
  terms: string[]
  usedApi: boolean
  skipped: boolean
  note: string
}

function countCjk(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/g) ?? []).length
}

function countLatinTokens(text: string): number {
  return (text.match(/[a-zA-ZÀ-ÿ]{3,}/g) ?? []).length
}

/** Expand when CJK intent or too few document-language tokens. */
export function shouldExpandQuery(question: string): boolean {
  const q = question.trim()
  if (q.length < 2) return false
  if (countCjk(q) >= 2) return true
  return countLatinTokens(q) < 2
}

function parseTermsPayload(raw: string): string[] {
  const trimmed = raw.trim()
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fence?.[1] ?? trimmed).trim()
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed === 'object' && parsed !== null && 'terms' in parsed) {
      const terms = (parsed as { terms: unknown }).terms
      if (Array.isArray(terms)) {
        return terms
          .filter((t): t is string => typeof t === 'string')
          .map((t) => t.trim())
          .filter((t) => t.length >= 2)
          .slice(0, 12)
      }
    }
  } catch {
    // fall through: line / comma split
  }
  return body
    .split(/[\n,;|]+/)
    .map((t) => t.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((t) => t.length >= 2 && !t.startsWith('{'))
    .slice(0, 12)
}

/**
 * Call reason Chat to propose document-language search terms.
 * On failure / no config → return original unchanged (safe fallback).
 */
export async function expandQueryForRetrieval(
  question: string,
): Promise<QueryExpandResult> {
  const original = question.trim()
  if (!original) {
    return {
      original,
      searchQuery: original,
      terms: [],
      usedApi: false,
      skipped: true,
      note: '空问句',
    }
  }

  if (!shouldExpandQuery(original)) {
    return {
      original,
      searchQuery: original,
      terms: [],
      usedApi: false,
      skipped: true,
      note: '已有足够拉丁词，跳过改写',
    }
  }

  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    return {
      original,
      searchQuery: original,
      terms: [],
      usedApi: false,
      skipped: true,
      note: '推理槽未配置，跳过改写',
    }
  }

  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  const url = `${base}/chat/completions`
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...demoAuthHeaders(),
    }
    if (reason.apiKey.trim() && !base.startsWith('/api/')) {
      headers.Authorization = `Bearer ${reason.apiKey.trim()}`
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: reason.model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: [
              '你是文档检索查询改写器。用户问题可能是中文或其他语言，目标文档常为法文/英文理论文本。',
              '只输出 JSON：{"terms":["..."]}。',
              'terms：3～8 个短检索词或小节标题短语，使用文档可能出现的原文语言（优先法文），含专名、同义与标题形态。',
              '禁止长句、禁止解释、禁止编造页码。不要输出 markdown。',
            ].join(''),
          },
          {
            role: 'user',
            content: `用户问题：${original}`,
          },
        ],
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      return {
        original,
        searchQuery: original,
        terms: [],
        usedApi: false,
        skipped: true,
        note: `改写失败 HTTP ${res.status}: ${errText.slice(0, 120)}`,
      }
    }
    const data: unknown = await res.json()
    if (
      typeof data !== 'object' ||
      data === null ||
      !('choices' in data) ||
      !Array.isArray((data as { choices: unknown }).choices)
    ) {
      return {
        original,
        searchQuery: original,
        terms: [],
        usedApi: false,
        skipped: true,
        note: '改写响应格式异常',
      }
    }
    const choices = (
      data as { choices: Array<{ message?: { content?: string } }> }
    ).choices
    const content = choices[0]?.message?.content ?? ''
    const terms = parseTermsPayload(content)
    if (terms.length === 0) {
      return {
        original,
        searchQuery: original,
        terms: [],
        usedApi: true,
        skipped: true,
        note: '改写无有效 terms',
      }
    }
    const searchQuery = `${terms.join(' ')} ${original}`.trim()
    return {
      original,
      searchQuery,
      terms,
      usedApi: true,
      skipped: false,
      note: `改写 terms=[${terms.join(' | ')}]`,
    }
  } catch (e) {
    return {
      original,
      searchQuery: original,
      terms: [],
      usedApi: false,
      skipped: true,
      note: e instanceof Error ? e.message : String(e),
    }
  }
}
