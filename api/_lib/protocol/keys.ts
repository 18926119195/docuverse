/**
 * Intrinsic doorplate keys — server authority only.
 * Browser must treat lockId as opaque.
 */

export function stableShortHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export function makeSlotKey(docId: string, page: number, k: number): string {
  return `${docId}|slot|p${page}|k${k}`
}

export function makeComboKey(docId: string, memberKeys: string[]): string {
  const body = [...memberKeys].sort().join('\0')
  return `${docId}|combo|${stableShortHash(body)}`
}

export function makeFigKey(docId: string, figId: string): string {
  return `${docId}|fig|${figId}`
}
