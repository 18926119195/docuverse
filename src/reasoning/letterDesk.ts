/**
 * Letter desk: global review before gateway runs.
 * Unit decisions: reuse | expand | deferred (尚未展开, archived for later).
 */

import type { FanoutInferUnit, FanoutUnitKind } from './fanoutCompose'
import type { FanoutPath } from './types'
import { findReusablePath, type ReuseHit } from './toolArchive'
import type { MotionPlan } from './harnessTypes'
import { motionActionToLetterDecision } from './motionBrain'

/** Per-unit gate decided on the letter desk (not by the runner). */
export type LetterUnitDecision = 'reuse' | 'expand' | 'deferred'

/** How to propose which units run this round. */
export type LetterRunStrategy =
  /** Reuse hits → reuse; everything else → expand */
  | 'reuse_prefer'
  /** Reuse hits → reuse; expand up to budget; rest → deferred */
  | 'budget'
  /** Only reuse this round; all new work → deferred */
  | 'reuse_only'
  /** Force every unit to expand (ignore reuse archive) */
  | 'force_expand'

export interface LetterUnitRow {
  index: number
  kind: FanoutUnitKind
  label: string
  memberKeys: string[]
  unitKey: string
  /** Proposed / user-edited decision */
  decision: LetterUnitDecision
  /** Why this decision was proposed */
  rationale: string
  /** Accepted path id when decision is reuse */
  reuseFromPathId?: string
}

export interface DeferredUnitArchive {
  id: string
  question: string
  kind: FanoutUnitKind
  label: string
  memberKeys: string[]
  unitKey: string
  createdAt: number
  rationale: string
}

export type LetterDeskStatus = 'empty' | 'review' | 'executing' | 'done'

export interface LetterDeskSnapshot {
  status: LetterDeskStatus
  question: string
  /** Combinations enumerated under current compose policy */
  comboCount: number
  strategy: LetterRunStrategy
  /** Max expand slots when strategy === 'budget' */
  expandBudget: number
  rows: LetterUnitRow[]
  counts: {
    reuse: number
    expand: number
    deferred: number
  }
}

export function unitMemberKeysOf(unit: FanoutInferUnit): string[] {
  if (unit.candidate.R.memberKeys?.length) return unit.candidate.R.memberKeys
  return [unit.candidate.R.key]
}

export function findAcceptedForCombo(
  unit: FanoutInferUnit,
  accepted: FanoutPath[],
  currentQuestion: string,
): FanoutPath | null {
  const hit = findReusableForCombo({
    unit,
    question: currentQuestion,
    accepted,
    inferred: [],
    modelId: '',
  })
  return hit?.path ?? null
}

export function findReusableForCombo(input: {
  unit: FanoutInferUnit
  question: string
  accepted: FanoutPath[]
  inferred: FanoutPath[]
  modelId: string
}): ReuseHit | null {
  return findReusablePath({
    memberKeys: unitMemberKeysOf(input.unit),
    question: input.question,
    stepOrder: input.unit.kind,
    modelId: input.modelId,
    accepted: input.accepted,
    inferred: input.inferred,
  })
}

const KIND_PRIORITY: Record<FanoutUnitKind, number> = {
  fine: 0,
  cluster: 1,
}

export function proposeLetterRows(input: {
  units: FanoutInferUnit[]
  question: string
  acceptedPaths: FanoutPath[]
  inferredPaths?: FanoutPath[]
  modelId?: string
  strategy: LetterRunStrategy
  expandBudget: number
  allowReuse: boolean
}): LetterUnitRow[] {
  const {
    units,
    question,
    acceptedPaths,
    strategy,
    expandBudget,
    allowReuse,
  } = input
  const inferredPaths = input.inferredPaths ?? []
  const modelId = input.modelId ?? ''

  type Tentative = {
    index: number
    unit: FanoutInferUnit
    hit: ReuseHit | null
  }
  const tentatives: Tentative[] = units.map((unit, index) => ({
    index,
    unit,
    hit:
      allowReuse && strategy !== 'force_expand'
        ? findReusableForCombo({
            unit,
            question,
            accepted: acceptedPaths,
            inferred: inferredPaths,
            modelId,
          })
        : null,
  }))

  const fresh = tentatives
    .filter((t) => !t.hit)
    .sort(
      (a, b) =>
        KIND_PRIORITY[a.unit.kind] - KIND_PRIORITY[b.unit.kind] ||
        a.index - b.index,
    )

  let expandQuota: number
  if (strategy === 'reuse_only') expandQuota = 0
  else if (strategy === 'budget') expandQuota = Math.max(0, expandBudget)
  else expandQuota = fresh.length

  const expandSet = new Set(fresh.slice(0, expandQuota).map((t) => t.index))

  return tentatives.map(({ index, unit, hit }) => {
    const memberKeys = unitMemberKeysOf(unit)
    const unitKey = unit.candidate.R.key
    if (hit) {
      const tierNote =
        hit.tier === 'accepted' ? '已采纳资产' : '已推断缓存'
      return {
        index,
        kind: unit.kind,
        label: unit.label,
        memberKeys,
        unitKey,
        decision: 'reuse' as const,
        rationale: `${tierNote}+问句近 → 复用 ${hit.path.pathId}`,
        reuseFromPathId: hit.path.pathId,
      }
    }
    if (expandSet.has(index)) {
      return {
        index,
        kind: unit.kind,
        label: unit.label,
        memberKeys,
        unitKey,
        decision: 'expand' as const,
        rationale:
          strategy === 'force_expand'
            ? '策略：强制新推'
            : strategy === 'budget'
              ? `策略：本轮预算内新推（≤${expandBudget}）`
              : '策略：本轮新推',
      }
    }
    return {
      index,
      kind: unit.kind,
      label: unit.label,
      memberKeys,
      unitKey,
      decision: 'deferred' as const,
      rationale: '尚未展开 · 已入待推存档，以后有空再推',
    }
  })
}

/**
 * Overlay motion-brain plans onto letter rows (match by unitKey).
 * Keeps manual overrides when no matching plan.
 */
export function applyMotionPlansToLetterRows(
  rows: LetterUnitRow[],
  plans: ReadonlyArray<MotionPlan>,
): LetterUnitRow[] {
  const byUnit = new Map<string, MotionPlan>()
  for (const p of plans) {
    if (p.unitKey && !byUnit.has(p.unitKey)) byUnit.set(p.unitKey, p)
  }
  return rows.map((row) => {
    const plan = byUnit.get(row.unitKey)
    if (!plan) return row
    const decision = motionActionToLetterDecision(plan.action)
    if (!decision) return row
    return {
      ...row,
      decision,
      rationale: `[运动脑#${plan.rank}] ${plan.rationale}`,
      reuseFromPathId:
        plan.action === 'reuse' ? plan.reuseFromPathId : undefined,
    }
  })
}

export function countDecisions(rows: LetterUnitRow[]): LetterDeskSnapshot['counts'] {
  return {
    reuse: rows.filter((r) => r.decision === 'reuse').length,
    expand: rows.filter((r) => r.decision === 'expand').length,
    deferred: rows.filter((r) => r.decision === 'deferred').length,
  }
}

export function snapshotFromRows(input: {
  question: string
  comboCount: number
  strategy: LetterRunStrategy
  expandBudget: number
  rows: LetterUnitRow[]
  status?: LetterDeskStatus
}): LetterDeskSnapshot {
  return {
    status: input.status ?? 'review',
    question: input.question,
    comboCount: input.comboCount,
    strategy: input.strategy,
    expandBudget: input.expandBudget,
    rows: input.rows,
    counts: countDecisions(input.rows),
  }
}

export function rowsToDeferredArchive(
  question: string,
  rows: LetterUnitRow[],
): DeferredUnitArchive[] {
  const now = Date.now()
  return rows
    .filter((r) => r.decision === 'deferred')
    .map((r) => ({
      id: `deferred_${now.toString(36)}_${r.index}_${Math.random().toString(36).slice(2, 6)}`,
      question,
      kind: r.kind,
      label: r.label,
      memberKeys: r.memberKeys,
      unitKey: r.unitKey,
      createdAt: now,
      rationale: r.rationale,
    }))
}

/**
 * Compact path marker for model reflux + human glance.
 * Prefer model-written path/conclusion compressed into a fixed schema
 * so later rounds can "秒懂" without stuffing full excerpts.
 */
export function buildPathMarker(input: {
  unitLabel: string
  memberKeys: string[]
  question: string
  conclusion: string
  path: string
  reused?: boolean
}): string {
  const keys = input.memberKeys.join('+')
  const q = input.question.replace(/\s+/g, ' ').trim().slice(0, 100)
  const c = input.conclusion.replace(/\s+/g, ' ').trim().slice(0, 180)
  const p = input.path
    .replace(/^【复用[^\n]*】\n?/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140)
  return [
    'PATH_MARK v1',
    `unit=${input.unitLabel}`,
    `keys=${keys}`,
    `mode=${input.reused ? 'reuse' : 'infer'}`,
    `Q=${q}`,
    `C=${c}`,
    `P=${p}`,
  ].join('\n')
}

export function strategyLabel(s: LetterRunStrategy): string {
  if (s === 'reuse_prefer') return '优先复用，其余本轮全推'
  if (s === 'budget') return '优先复用，新推有预算'
  if (s === 'reuse_only') return '本轮只复用，新工作全部尚未展开'
  return '强制全部新推（忽略复用）'
}
