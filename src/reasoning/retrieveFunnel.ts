/**
 * Retrieve funnel — LLM closed-set (L0 选廊 / L1 选门) + BM25 fallback.
 * No embedding / vBook on the retrieval path.
 */

import {
  atomToCandidate,
  type BookIndex,
  type CircleCandidate,
} from './pipelineA'
import { facesToReadout } from './intrinsicKey'
import type { BookSemanticIndex, SectionNode } from './semanticIndex'
import {
  keysInSections,
  rankSections,
  sectionHitNote,
} from './semanticIndex'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'
import type { ActionRecord } from './types'
import { pickKeysViaLlm, pickSectionsViaLlm } from './llmRetrieve'
import { recallCandidatesByBm25 } from './retrieveBm25'

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export type FunnelStage =
  | 'directory_shrink'
  | 'in_domain'
  | 'whole_book_upgrade'
  | 'fallback_whole_book'

export interface RetrieveFunnelResult {
  action: ActionRecord
  candidates: CircleCandidate[]
  searchQuery: string
  poolSize: number
  autoLockOk: boolean
  expandNote: string
  stage: FunnelStage
  sectionIds: string[]
  draftKeys: string[]
  lockCorridorHint?: string
}

async function candidatesFromKeys(
  bookIndex: BookIndex,
  keys: string[],
  topK: number,
): Promise<CircleCandidate[]> {
  const out: CircleCandidate[] = []
  for (const key of keys) {
    if (out.length >= topK) break
    const chunk = bookIndex.chunks.find((c) => c.key === key)
    if (!chunk) continue
    const c = await atomToCandidate(
      bookIndex.docId,
      [{ ...chunk, score: 0.85 }],
      'llm_pick',
    )
    c.excerpt = facesToReadout(c.R.faces)
    out.push(c)
  }
  return out
}

export async function runRetrieveFunnel(input: {
  bookIndex: BookIndex
  question: string
  topK?: number
  semanticIndex?: BookSemanticIndex | null
  /** Force whole-book BM25 (gap / user upgrade) */
  forceWholeBook?: boolean
  /** Prefer these corridor nodeIds as shrink set */
  preferredSectionIds?: ReadonlyArray<string>
}): Promise<RetrieveFunnelResult> {
  const question = input.question.trim()
  const topK = input.topK ?? 5
  const semantic = input.semanticIndex ?? null
  const bookIndex = input.bookIndex

  const retrievalQ = question

  let candidates: CircleCandidate[] = []
  let poolSize = 0
  let autoLockOk = false
  let expandNote = ''
  let stage: FunnelStage = 'fallback_whole_book'
  let sectionIds: string[] = []
  let lockCorridorHint: string | undefined

  const joinNote = (parts: string[]) =>
    parts.filter(Boolean).join(' · ')

  if (input.forceWholeBook) {
    const bm = await recallCandidatesByBm25({
      bookIndex,
      query: retrievalQ,
      topK,
      allowedKeys: null,
    })
    candidates = bm.candidates
    poolSize = bm.poolSize
    autoLockOk = bm.autoLockOk
    stage = 'whole_book_upgrade'
    expandNote = joinNote([expandNote, '升档·全书BM25'])
  } else if (semantic && semantic.sections.length > 0) {
    const preferred = input.preferredSectionIds?.filter(Boolean) ?? []
    let sectionHits: Array<{ node: SectionNode; score: number }> = []

    if (preferred.length > 0) {
      sectionHits = preferred
        .map((id) => semantic.sections.find((s) => s.nodeId === id))
        .filter(Boolean)
        .map((node) => ({ node: node!, score: 1 }))
    } else {
      const llmSec = await pickSectionsViaLlm(retrievalQ, semantic)
      if (llmSec.sectionIds.length > 0) {
        sectionHits = llmSec.sectionIds
          .map((id) => semantic.sections.find((s) => s.nodeId === id))
          .filter(Boolean)
          .map((node) => ({ node: node!, score: 1 }))
        expandNote = joinNote([expandNote, llmSec.note])
      } else {
        sectionHits = rankSections(semantic, retrievalQ, 4)
        expandNote = joinNote([
          expandNote,
          llmSec.usedApi ? `${llmSec.note}·BM25节级` : 'BM25节级',
        ])
      }
    }

    if (sectionHits.length > 0) {
      sectionIds = sectionHits.map((h) => h.node.nodeId)
      lockCorridorHint = sectionIds[0]
      const allowed = keysInSections(semantic, new Set(sectionIds))

      const llmKeys = await pickKeysViaLlm({
        question: retrievalQ,
        bookIndex,
        allowedKeys: allowed,
        topK: topK * 2,
      })

      if (llmKeys.keys.length > 0) {
        candidates = await candidatesFromKeys(bookIndex, llmKeys.keys, topK)
        poolSize = allowed.size
        autoLockOk = llmKeys.keys.length === 1
        stage = preferred.length > 0 ? 'directory_shrink' : 'in_domain'
        expandNote = joinNote([
          expandNote,
          llmKeys.note,
          stage === 'directory_shrink' ? '目录锁廊缩域' : '域内召回',
          `节级: ${sectionHitNote(sectionHits)}`,
        ])
      } else {
        const bm = await recallCandidatesByBm25({
          bookIndex,
          query: retrievalQ,
          topK,
          allowedKeys: allowed,
        })
        candidates = bm.candidates
        poolSize = bm.poolSize
        autoLockOk = bm.autoLockOk

        if (candidates.length > 0) {
          stage = preferred.length > 0 ? 'directory_shrink' : 'in_domain'
          expandNote = joinNote([
            expandNote,
            llmKeys.note,
            'BM25域内',
            `节级: ${sectionHitNote(sectionHits)}`,
          ])
        } else {
          stage = 'whole_book_upgrade'
          const up = await recallCandidatesByBm25({
            bookIndex,
            query: retrievalQ,
            topK,
            allowedKeys: null,
          })
          candidates = up.candidates
          poolSize = up.poolSize
          autoLockOk = up.autoLockOk
          expandNote = joinNote([
            expandNote,
            '域内空·升档全书BM25',
            `节级曾命中: ${sectionHitNote(sectionHits)}`,
          ])
        }
      }
    } else {
      const bm = await recallCandidatesByBm25({
        bookIndex,
        query: retrievalQ,
        topK,
        allowedKeys: null,
      })
      candidates = bm.candidates
      poolSize = bm.poolSize
      autoLockOk = bm.autoLockOk
      stage = 'fallback_whole_book'
      expandNote = joinNote([expandNote, '无节命中·全书BM25'])
    }
  } else {
    const bm = await recallCandidatesByBm25({
      bookIndex,
      query: retrievalQ,
      topK,
      allowedKeys: null,
    })
    candidates = bm.candidates
    poolSize = bm.poolSize
    autoLockOk = bm.autoLockOk
    expandNote = joinNote([expandNote, '全书BM25'])
  }

  const draftKeys = candidates.map((c) => c.R.key)
  const action: ActionRecord = {
    actionId: newActionId('retrieve'),
    actionKind: 'retrieve',
    premiseKeys: [],
    inputsRef: {
      question,
      role: 'draft',
      funnelStage: stage,
      sectionIds,
    },
    outputsRef: {
      candidateKeys: draftKeys,
      draftKeys,
      roleNote: [
        FANOUT_ROLE_NOTE.draft,
        `漏斗=${stage}`,
        expandNote || '',
      ]
        .filter(Boolean)
        .join(' · '),
    },
    createdAt: Date.now(),
  }

  return {
    action,
    candidates,
    searchQuery: retrievalQ,
    poolSize,
    autoLockOk,
    expandNote,
    stage,
    sectionIds,
    draftKeys,
    lockCorridorHint,
  }
}
