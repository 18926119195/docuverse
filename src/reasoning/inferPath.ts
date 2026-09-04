/**
 * 主推理路径：能回 Q 的走法穷举。
 * 每步 bookKeys ≥1：单门独自→Q｜二元互撑｜多门并肩；
 * inferKey / queryKey 由写信台落账微动作铸（方案 B），正文指纹仅副索引。
 */

import {
  contentFingerprint,
  expandIncrementSlots,
  mintInstanceKey,
  newSettleActionId,
} from './settleMint'

export interface InferStepRaw {
  /** ≥1；单门=[bk]；互撑=[a,b]；并肩=[a,b,…] —— 与本条 infer 一一对应 */
  bookKeys: string[]
  /** 增量正文 infer（归档用语）；一槽一条，禁止把多条 infer 塞进同一字段 */
  infer: string
}

export interface InferPathRaw {
  steps: InferStepRaw[]
}

/** @deprecated 正文副索引；勿当门牌。新代码用 contentFingerprint / settleOnce。 */
export function contentKey(prefix: string, raw: string): string {
  const fp = contentFingerprint(raw || 'empty')
  return `${prefix}_${fp.slice(3)}`
}

/** 落账铸 inferKey（方案 B · 一槽一 key） */
export function mintInferKey(settleActionId?: string): {
  settleActionId: string
  inferKey: string
} {
  const sid = settleActionId || newSettleActionId('infer')
  return { settleActionId: sid, inferKey: mintInstanceKey('infer', sid) }
}

/** 落账铸 queryKey（方案 B） */
export function mintQueryKey(settleActionId?: string): {
  settleActionId: string
  queryKey: string
} {
  const sid = settleActionId || newSettleActionId('query')
  return { settleActionId: sid, queryKey: mintInstanceKey('query', sid) }
}

/**
 * @deprecated 曾用正文哈希当 inferKey → 同文会合并成一枚 key（禁止）。
 * 落账必须用 mintInferKey()。
 */
export function inferKeyOf(_inferText: string): string {
  throw new Error(
    'inferKeyOf 已废除：禁止用正文哈希铸 inferKey（会合并本应分开的槽）。请用 mintInferKey()。',
  )
}

/**
 * @deprecated 曾用问句哈希当 queryKey。落账请用 mintQueryKey / ensureQueryKey。
 */
export function queryKeyOfQuestion(question: string): string {
  return contentKey('qk', question)
}

export function fingerprintOfInfer(inferText: string): string {
  return contentFingerprint(inferText || 'empty')
}

export function fingerprintOfQuestion(question: string): string {
  return contentFingerprint(question.trim() || 'empty')
}

/** 从 LLM 正文抠 JSON（允许围栏/前后废话） */
export function extractJsonObject(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced?.[1] ?? text).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

/**
 * 规范化一步的 bookKeys：≥1、去空；连续重复压成一元（禁自环伪装二元）。
 */
export function asBookKeys(keys: unknown): string[] | null {
  if (!Array.isArray(keys) || keys.length < 1) return null
  const raw = keys
    .map((k) => String(k ?? '').trim())
    .filter(Boolean)
  if (raw.length < 1) return null
  // [a,a] → [a]（单门独自走向 Q，不是自环）
  if (raw.length === 2 && raw[0] === raw[1]) return [raw[0]!]
  // 保序去重，保留并肩多门
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of raw) {
    if (seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out.length > 0 ? out : null
}

/**
 * 解析 infer out → 步链。
 * 接受 { paths:[{ steps:[{bookKeys, infer|infers[]|rationale}] }] }。
 * 一槽一 infer：infers[] → 多枚 inferKey；禁止正文哈希合并。
 */
export function parseInferPaths(llmText: string): InferPathRaw[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []

  const root = obj as Record<string, unknown>
  const pathNodes: unknown[] = Array.isArray(root.paths)
    ? root.paths
    : Array.isArray(root.steps)
      ? [{ steps: root.steps }]
      : []

  const out: InferPathRaw[] = []
  for (const p of pathNodes) {
    if (!p || typeof p !== 'object') continue
    const stepsRaw = (p as { steps?: unknown }).steps
    if (!Array.isArray(stepsRaw)) continue
    const steps: InferStepRaw[] = []
    for (const s of stepsRaw) {
      if (!s || typeof s !== 'object') continue
      const row = s as {
        bookKeys?: unknown
        infer?: unknown
        infers?: unknown
        rationale?: unknown
      }
      const bookKeys = asBookKeys(row.bookKeys)
      if (!bookKeys) continue
      const slots = expandIncrementSlots(
        row.infer ?? row.rationale,
        row.infers,
      )
      for (const slot of slots) {
        steps.push({ bookKeys: [...bookKeys], infer: slot.text })
      }
    }
    if (steps.length > 0) out.push({ steps })
  }
  return out
}

/**
 * 解析失败时不造伪槽（共用一段正文会把多义内容并进错误 key）。
 */
export function fallbackInferPaths(
  _bookKeys: string[],
  _llmText: string,
): InferPathRaw[] {
  return []
}

export interface ReuseJudgment {
  /** 复用闸主坐标：pathKey（infer×prospect 匹配后） */
  pathKey: string
  /** 兼容旧闸：无 path 时曾用 inferKey */
  inferKey?: string
  canSolve: boolean
  rationale: string
}

/** 复用闸 out：{ judgments:[{pathKey,canSolve,rationale}] }；兼容旧 inferKey/queryKey */
export function parseReuseJudgments(llmText: string): ReuseJudgment[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const rows: unknown[] = Array.isArray(root.judgments)
    ? root.judgments
    : root.pathKey != null || root.inferKey != null || root.queryKey != null
      ? [root]
      : []
  const out: ReuseJudgment[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const pathKey = String(row.pathKey ?? '').trim()
    const inferKey = String(row.inferKey ?? row.queryKey ?? '').trim()
    if (!pathKey && !inferKey) continue
    const canSolve =
      row.canSolve === true ||
      row.canSolve === 'true' ||
      row.reuse === true ||
      String(row.canSolve).toLowerCase() === 'yes'
    out.push({
      pathKey: pathKey || inferKey,
      inferKey: inferKey || undefined,
      canSolve,
      rationale: String(row.rationale ?? row.依据 ?? '').trim(),
    })
  }
  return out
}

/** decide prospect 槽：briefKey ↔ prospect 正文（台再 settle 铸 prospectKey） */
export interface DecideProspectRow {
  briefKey: string
  /** prospect 增量：该 brief 解 Q_now 的一种可能/预测 */
  prospect: string
}

/** @deprecated 用 DecideProspectRow */
export type DecideKeepRow = DecideProspectRow

/** 监督 LLM：infer × prospect 匹配对 */
export interface PathMatchRow {
  inferKey: string
  prospectKey: string
}

/** { matches:[{inferKey,prospectKey}] } */
export function parsePathMatches(llmText: string): PathMatchRow[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const rows: unknown[] = Array.isArray(root.matches)
    ? root.matches
    : Array.isArray(root.pairs)
      ? root.pairs
      : []
  const out: PathMatchRow[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const inferKey = String(row.inferKey ?? '').trim()
    const prospectKey = String(row.prospectKey ?? '').trim()
    if (!inferKey || !prospectKey) continue
    out.push({ inferKey, prospectKey })
  }
  return out
}

/** queryLLM 出：对称子集 historic queryKey + 增量 neighbour（相关度） */
export interface QueryNeighbourRow {
  queryKey: string
  /** 相关度（归档：neighbour） */
  degree: string
}

/**
 * 解析 queryLLM out。
 * 架构：输出 queryKey（子集）+ neighbour（相关度）；挂在对应 historic queryKey 上。
 * 兼容旧字段 orderedQueryKeys（无 degree 时 degree 为空串）。
 */
export function parseQueryNeighbours(llmText: string): QueryNeighbourRow[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const out: QueryNeighbourRow[] = []
  const seen = new Set<string>()

  const push = (qk: string, degree: string) => {
    const key = qk.trim()
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push({ queryKey: key, degree: degree.trim() })
  }

  const neighbours = root.neighbours ?? root.neighbor ?? root.neighbour
  if (Array.isArray(neighbours)) {
    for (const row of neighbours) {
      if (typeof row === 'string') {
        push(row, '')
        continue
      }
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      push(
        String(r.queryKey ?? r.key ?? ''),
        String(r.degree ?? r.neighbour ?? r.relatedness ?? r.score ?? ''),
      )
    }
  }

  // 兼容旧：orderedQueryKeys 仅表示被选中的对称子集，相关度缺失
  if (out.length === 0) {
    const raw =
      root.orderedQueryKeys ?? root.queryKeys ?? root.ordered ?? null
    if (Array.isArray(raw)) {
      raw.forEach((x, i) => {
        if (typeof x === 'string') push(x, '')
        else if (x && typeof x === 'object') {
          const r = x as Record<string, unknown>
          push(
            String(r.queryKey ?? r.key ?? ''),
            String(r.degree ?? r.neighbour ?? '') || `rank=${i + 1}`,
          )
        }
      })
    }
  }

  return out
}

/** @deprecated 用 parseQueryNeighbours；仅返回被选中的 historic queryKey */
export function parseOrderedQueryKeys(llmText: string): string[] {
  return parseQueryNeighbours(llmText).map((r) => r.queryKey)
}
