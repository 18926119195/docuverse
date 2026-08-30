/**
 * KeyDecisionState — door-level briefs (小抄) keyed by A1 key*.
 * Handbook: brief is task fill on the door; NOT written into BookIndex.
 * History may append; WM only rolls the hot tip.
 */

export type SuggestAction = 'open' | 'defer' | 'reuse' | 'need_more_peek'

export interface BriefVersion {
  brief: string
  suggestAction: SuggestAction
  contentHash: string
  actionId?: string
  taskId?: string
  at: number
  excerptPreviewHash?: string
}

export interface KeyDecisionEntry {
  key: string
  /** Hot tip for next open-door decision (rolled) */
  decisionBrief: string
  suggestAction: SuggestAction
  briefContentHash: string
  updatedAt: number
  lastActionId?: string
  lastTaskId?: string
  /** Append-only audit (not default WM input) */
  history: BriefVersion[]
}

export interface KeyDecisionStore {
  docId: string
  byKey: Record<string, KeyDecisionEntry>
  updatedAt: number
}

const storeByDoc = new Map<string, KeyDecisionStore>()

/** Browser-safe short hash for brief content identity. */
export function briefContentHash(brief: string, suggestAction: SuggestAction): string {
  const raw = `${suggestAction}\0${brief.trim()}`
  let h = 2166136261
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `bh_${(h >>> 0).toString(36)}`
}

export function emptyKeyDecisionStore(docId: string): KeyDecisionStore {
  return { docId, byKey: {}, updatedAt: Date.now() }
}

export function getKeyDecisionStore(docId: string): KeyDecisionStore {
  let s = storeByDoc.get(docId)
  if (!s) {
    s = emptyKeyDecisionStore(docId)
    storeByDoc.set(docId, s)
  }
  return s
}

export function saveKeyDecisionStore(store: KeyDecisionStore): void {
  store.updatedAt = Date.now()
  storeByDoc.set(store.docId, store)
}

export function getDoorEntry(
  docId: string,
  key: string,
): KeyDecisionEntry | null {
  return getKeyDecisionStore(docId).byKey[key] ?? null
}

/** Roll hot tip; append previous hot tip into history. */
export function rollDoorBrief(input: {
  docId: string
  key: string
  decisionBrief: string
  suggestAction: SuggestAction
  actionId?: string
  taskId?: string
  excerptPreviewHash?: string
  maxHistory?: number
}): KeyDecisionEntry {
  const store = getKeyDecisionStore(input.docId)
  const prev = store.byKey[input.key]
  const hash = briefContentHash(input.decisionBrief, input.suggestAction)
  const now = Date.now()
  const history = [...(prev?.history ?? [])]
  if (prev && prev.decisionBrief.trim()) {
    history.push({
      brief: prev.decisionBrief,
      suggestAction: prev.suggestAction,
      contentHash: prev.briefContentHash,
      actionId: prev.lastActionId,
      taskId: prev.lastTaskId,
      at: prev.updatedAt,
    })
  }
  const maxH = input.maxHistory ?? 12
  const trimmed = history.slice(-maxH)
  const entry: KeyDecisionEntry = {
    key: input.key,
    decisionBrief: input.decisionBrief.trim(),
    suggestAction: input.suggestAction,
    briefContentHash: hash,
    updatedAt: now,
    lastActionId: input.actionId,
    lastTaskId: input.taskId,
    history: trimmed,
  }
  store.byKey[input.key] = entry
  saveKeyDecisionStore(store)
  return entry
}

export function doorsForKeys(
  docId: string,
  keys: ReadonlyArray<string>,
): KeyDecisionEntry[] {
  const store = getKeyDecisionStore(docId)
  return keys
    .map((k) => store.byKey[k])
    .filter((e): e is KeyDecisionEntry => Boolean(e))
}
