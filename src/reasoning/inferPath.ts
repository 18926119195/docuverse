/**
 * 主推理路径：能回 Q 的走法穷举。
 * 每步 bookKeys ≥1：单门独自→Q｜二元互撑｜多门并肩；每步 rationale → inferKey。
 */

export interface InferStepRaw {
  /** ≥1；单门=[bk]；互撑=[a,b]；并肩=[a,b,…] */
  bookKeys: string[]
  rationale: string
}

export interface InferPathRaw {
  steps: InferStepRaw[]
}

/** 内容哈希 → inferKey / queryKey 共用 */
export function contentKey(prefix: string, raw: string): string {
  const t = raw.trim()
  let h = 2166136261
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${prefix}_${(h >>> 0).toString(36)}`
}

export function inferKeyOf(rationale: string): string {
  return contentKey('ik', rationale || 'empty')
}

export function queryKeyOfQuestion(question: string): string {
  return contentKey('qk', question)
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
 * 解析主推理 out → 步链。
 * 接受 { paths:[{ steps:[{bookKeys,rationale}] }] } 或 { steps:[...] }。
 * bookKeys 长度 ≥1（单门 / 二元 / 并肩）。
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
      const row = s as { bookKeys?: unknown; rationale?: unknown }
      const bookKeys = asBookKeys(row.bookKeys)
      const rationale = String(row.rationale ?? '').trim()
      if (!bookKeys || !rationale) continue
      steps.push({ bookKeys, rationale })
    }
    if (steps.length > 0) out.push({ steps })
  }
  return out
}

/**
 * 解析失败兜底：穷举单门独自→Q；≥2 时再加相邻互撑链。
 */
export function fallbackInferPaths(
  bookKeys: string[],
  llmText: string,
): InferPathRaw[] {
  const uniq = [...new Set(bookKeys.map((k) => k.trim()).filter(Boolean))]
  if (uniq.length === 0) return []
  const body = llmText.trim().slice(0, 800)
  const paths: InferPathRaw[] = []

  // 每门一条「独自走向 Q」
  for (const bk of uniq) {
    paths.push({
      steps: [
        {
          bookKeys: [bk],
          rationale:
            body ||
            `单门 \`${bk.slice(0, 12)}…\` 如何独自撑住 / 走回 Q_now`,
        },
      ],
    })
  }

  // ≥2：再加一条相邻互撑链
  if (uniq.length >= 2) {
    const chunk = Math.max(80, Math.floor(llmText.length / (uniq.length - 1)))
    const steps: InferStepRaw[] = []
    for (let i = 0; i < uniq.length - 1; i++) {
      steps.push({
        bookKeys: [uniq[i]!, uniq[i + 1]!],
        rationale:
          llmText.trim().slice(i * chunk, (i + 1) * chunk) ||
          `从 ${uniq[i]} 到 ${uniq[i + 1]} 如何互撑走向 Q`,
      })
    }
    paths.push({ steps })
  }

  return paths
}

export interface ReuseJudgment {
  /** 复用闸 LLM 主坐标（§1.0.8） */
  inferKey: string
  canSolve: boolean
  rationale: string
}

/** 复用闸 out：{ judgments:[{inferKey,canSolve,rationale}] }；兼容旧 queryKey 字段 */
export function parseReuseJudgments(llmText: string): ReuseJudgment[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const rows: unknown[] = Array.isArray(root.judgments)
    ? root.judgments
    : root.inferKey != null || root.queryKey != null
      ? [root]
      : []
  const out: ReuseJudgment[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const inferKey = String(row.inferKey ?? row.queryKey ?? '').trim()
    if (!inferKey) continue
    const canSolve =
      row.canSolve === true ||
      row.canSolve === 'true' ||
      row.reuse === true ||
      String(row.canSolve).toLowerCase() === 'yes'
    out.push({
      inferKey,
      canSolve,
      rationale: String(row.rationale ?? row.依据 ?? '').trim(),
    })
  }
  return out
}

/** 阶段 A 收口：orderedQueryKeys */
export function parseOrderedQueryKeys(llmText: string): string[] {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') return []
  const root = obj as Record<string, unknown>
  const raw =
    root.orderedQueryKeys ?? root.queryKeys ?? root.ordered ?? null
  if (!Array.isArray(raw)) return []
  return [
    ...new Set(
      raw.map((x) => String(x ?? '').trim()).filter(Boolean),
    ),
  ]
}
