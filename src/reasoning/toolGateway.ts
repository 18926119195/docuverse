/**
 * Tool gateway — sole execution exit.
 * Draft retrieves candidates; letter writer selects member_keys; gateway injects + stamps.
 */

import type { FanoutInferUnit } from './fanoutCompose'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'
import { demoAuthHeaders } from './demoAuth'
import type { AbBlock } from './formalPath'
import { gateReturnSubset } from './hardGates'
import type { BookIndex, CircleCandidate } from './pipelineA'
import type {
  ActionRecord,
  DirectionRecord,
  FanoutPath,
} from './types'
import type { BookSemanticIndex } from './semanticIndex'
import { runRetrieveFunnel } from './retrieveFunnel'
import { executeInstructionCompose } from './instructionCompose'
import { proposeComposeBags } from './motionBrain'

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export interface GatewayRetrieveResult {
  action: ActionRecord
  candidates: CircleCandidate[]
  searchQuery: string
  poolSize: number
  autoLockOk: boolean
  expandNote: string
}

export interface GatewayComposeResult {
  action: ActionRecord
  units: FanoutInferUnit[]
  ok: boolean
  error?: string
}

export interface GatewayInferResult {
  action: ActionRecord
  direction: DirectionRecord | null
  ok: boolean
  error?: string
}

/**
 * 草稿检索：premiseKeys 故意为空 — 草稿不是注入；注入由写信配方 + 网关 infer 登记。
 * 主路径走检索漏斗（确认 TOC 时目录缩域 → 域内召回）；无 TOC → 全书 BM25。
 */
export async function executeRetrieve(input: {
  bookIndex: BookIndex
  question: string
  topK?: number
  semanticIndex?: BookSemanticIndex | null
  forceWholeBook?: boolean
  preferredSectionIds?: ReadonlyArray<string>
}): Promise<GatewayRetrieveResult & {
  stage?: string
  sectionIds?: string[]
  lockCorridorHint?: string
}> {
  const semantic =
    input.semanticIndex?.tocConfirmed === true ? input.semanticIndex : null
  const funnel = await runRetrieveFunnel({
    bookIndex: input.bookIndex,
    question: input.question,
    topK: input.topK,
    semanticIndex: semantic,
    forceWholeBook: input.forceWholeBook,
    preferredSectionIds: input.preferredSectionIds,
  })
  return {
    action: funnel.action,
    candidates: funnel.candidates,
    searchQuery: funnel.searchQuery,
    poolSize: funnel.poolSize,
    autoLockOk: funnel.autoLockOk,
    expandNote: funnel.expandNote,
    stage: funnel.stage,
    sectionIds: funnel.sectionIds,
    lockCorridorHint: funnel.lockCorridorHint,
  }
}

/**
 * 写信组合：运动脑提议袋 → 指令组袋（几何穷举已删除）。
 */
export async function executeCompose(input: {
  bookIndex: BookIndex
  fineCandidates: CircleCandidate[]
  question?: string
}): Promise<GatewayComposeResult> {
  const draftKeys = input.fineCandidates.map((c) => c.R.key)
  const bags = proposeComposeBags({
    draftKeys,
    bookIndex: input.bookIndex,
    semantic: null,
    maxBags: Math.min(5, Math.max(1, draftKeys.length)),
  })
  const composed = await executeInstructionCompose({
    bookIndex: input.bookIndex,
    fineCandidates: input.fineCandidates,
    draftKeys,
    question: input.question,
    spec: {
      mode: 'custom',
      customBags: bags.bags,
      maxBags: Math.max(1, bags.bags.length),
    },
  })
  return {
    action: composed.action,
    units: composed.units,
    ok: composed.ok,
    error: composed.error,
  }
}

interface InferOpsWireResponse {
  ok?: boolean
  usedMock?: boolean
  conclusion?: string
  path?: string
  usedKeys?: string[]
  ops?: unknown[]
  error?: string
}

/**
 * 网关 infer：编译器 blocks → /api/protocol/infer-ops → 结论 + usedKeys。
 * 正确性中心 = 监督 loop + 硬闸 G*（手册 Loop-I）；不再跑 formal Validator / ops 剧场。
 */
export async function executeInferOps(input: {
  question: string
  blocks: AbBlock[]
  unitLabel?: string
  premiseKeys: string[]
}): Promise<GatewayInferResult & { usedKeys?: string[] }> {
  const question = input.question.trim()
  const premiseKeys = input.premiseKeys.filter(Boolean)
  const blocks = input.blocks.filter((b) => b.key && b.text.trim())

  if (blocks.length === 0) {
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: { question, role: 'gateway' },
      outputsRef: {
        error: '编译后 blocks 为空',
        roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer`,
      },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: '编译后 blocks 为空' }
  }

  let data: InferOpsWireResponse | null = null
  let fetchError: string | undefined

  try {
    const res = await fetch('/api/protocol/infer-ops', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...demoAuthHeaders(),
      },
      body: JSON.stringify({
        question,
        blocks,
        unitLabel: input.unitLabel,
      }),
    })
    data = (await res.json().catch(() => null)) as InferOpsWireResponse | null
    if (!res.ok) {
      fetchError =
        data && typeof data.error === 'string'
          ? data.error
          : `HTTP ${res.status}`
    }
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e)
  }

  if (fetchError || !data || data.ok === false) {
    const err = fetchError ?? data?.error ?? 'infer 失败'
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: {
        question,
        excerpt: blocks.map((b) => b.key).join(', '),
        role: 'gateway',
      },
      outputsRef: { error: err, roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer` },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: err }
  }

  const conclusion = (data.conclusion ?? '').trim()
  const pathText = (data.path ?? '').trim()
  const usedKeys = (data.usedKeys ?? []).filter(
    (k): k is string => typeof k === 'string' && Boolean(k),
  )

  if (!conclusion && !pathText) {
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: { question, role: 'gateway' },
      outputsRef: {
        error: 'infer 无结论',
        roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer`,
      },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: 'infer 无结论' }
  }

  const returned = usedKeys.length > 0 ? usedKeys : premiseKeys
  const g2 = gateReturnSubset(premiseKeys, returned)
  if (!g2.ok) {
    const msg = g2.fails[0]?.message ?? 'G2 回引不在递交集'
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: {
        question,
        excerpt: blocks.map((b) => `${b.key}:${b.text.slice(0, 48)}`).join(' | '),
        role: 'gateway',
      },
      outputsRef: {
        error: msg,
        path: pathText,
        conclusion,
        roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer · ${msg}`,
      },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: msg, usedKeys: returned }
  }

  const action: ActionRecord = {
    actionId: newActionId('infer'),
    actionKind: 'infer',
    premiseKeys,
    inputsRef: {
      question,
      excerpt: blocks.map((b) => `${b.key}:${b.text.slice(0, 48)}`).join(' | '),
      role: 'gateway',
    },
    outputsRef: {
      path: pathText,
      conclusion,
      roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer · G2 ok`,
    },
    createdAt: Date.now(),
  }

  const direction: DirectionRecord = {
    directionId: `dir_${action.actionId}`,
    questionText: question,
    probe: [],
    path: pathText,
    conclusion,
    createdAt: Date.now(),
    variants: [],
    premiseKeys,
    actionIds: [action.actionId],
    accepted: undefined,
  }

  return {
    action,
    direction,
    ok: true,
    usedKeys: returned,
  }
}

/** Sorted member_keys fingerprint — same combo ⇒ same identity for reuse. */
export function memberKeysSignature(keys: string[]): string {
  return [...keys].filter(Boolean).sort().join('\0')
}

/**
 * 网关复用：同一 member_keys 已有采纳资产 → 短路，不调主模型。
 * 仍盖 ActionRecord，保证可追溯。
 */
export function executeReuse(input: {
  candidate: CircleCandidate
  question: string
  fromPath: FanoutPath
}): GatewayInferResult {
  const question = input.question.trim()
  const premiseKeys =
    input.candidate.R.memberKeys && input.candidate.R.memberKeys.length > 0
      ? input.candidate.R.memberKeys
      : [input.candidate.R.key]

  const prev = input.fromPath.direction
  const action: ActionRecord = {
    actionId: newActionId('reuse'),
    actionKind: 'reuse',
    premiseKeys,
    inputsRef: {
      question,
      excerpt: input.candidate.excerpt,
      lockKey: input.candidate.R.key,
      role: 'reuse',
      reusedFromPathId: input.fromPath.pathId,
    },
    outputsRef: {
      path: prev.path,
      conclusion: prev.conclusion,
      assetId: prev.directionId,
      reused: true,
      roleNote: FANOUT_ROLE_NOTE.reuse,
    },
    createdAt: Date.now(),
  }

  const variants = [...(prev.variants ?? [])]
  if (
    question &&
    question !== prev.questionText &&
    !variants.includes(question)
  ) {
    variants.push(question)
  }

  const direction: DirectionRecord = {
    directionId: prev.directionId,
    questionText: prev.questionText,
    probe: prev.probe,
    path: `【复用 · 跳过主模型 · 自 ${input.fromPath.pathId}】\n${prev.path}`,
    conclusion: prev.conclusion,
    createdAt: Date.now(),
    variants,
    premiseKeys,
    actionIds: [action.actionId],
    referencedPathIds: [
      input.fromPath.pathId,
      ...(prev.referencedPathIds ?? []),
    ],
    pathMarker: prev.pathMarker,
    fingerprint: prev.fingerprint,
    accepted: undefined,
  }

  return { action, direction, ok: true }
}

