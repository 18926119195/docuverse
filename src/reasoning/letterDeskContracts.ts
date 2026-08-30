/**
 * 写信台契约表：job → allow/forbid + in/out 协议（正文不变，仅调度）。
 * 对齐 docs/前置决策链 §1.0.8
 */

import type { DeskJob } from './attentionIoStore'

export type ContractKeyKind = 'briefKey' | 'bookKey' | 'queryKey' | 'inferKey'

export interface DeskContract {
  job: DeskJob
  /** 本窗允许出现的门牌型（expand 只准产出这些） */
  allow: ContractKeyKind[]
  forbid: ContractKeyKind[]
  inNote: string
  outNote: string
}

export const DESK_CONTRACTS: Record<DeskJob, DeskContract> = {
  peek: {
    job: 'peek',
    allow: ['bookKey'],
    forbid: [],
    inNote: 'bookKey + T（模型不直接出 briefKey）',
    outNote: '同一 bookKey + brief 正文；台铸 briefKey',
  },
  query: {
    job: 'query',
    allow: ['queryKey'],
    forbid: ['bookKey', 'briefKey'],
    inNote: '旧 queryKey + 历史 Q 文 + Q_now（阶段 A · 无 brief）',
    outNote: '有序 queryKey[]（收口）；不出 briefKey',
  },
  decide: {
    job: 'decide',
    allow: ['briefKey'],
    forbid: ['bookKey'],
    inNote: 'Q_now + {briefKey, brief}[]（无 bookKey/T）',
    outNote:
      'lastBriefKey + keep[{briefKey,rationale}] + coverage（必须）+ stopReason? + seedRange?（热启 peek）+ attentionArrived',
  },
  supervise: {
    job: 'supervise',
    allow: ['briefKey', 'bookKey'],
    forbid: [],
    inNote: '同场 T∥brief（briefKey↔bookKey 成对）',
    outNote: 'Δ 评；不接管 keep/revoke；默认关',
  },
  mainInfer: {
    job: 'mainInfer',
    allow: ['bookKey'],
    forbid: [],
    inNote:
      '材料 bookKey(+T) + Q_now + 排除：玩法A=失败ι→旧queryKey+Q原文；玩法B=inferKey+ι原文',
    outNote:
      'paths[] 穷举能回 Q 的走法；每步 bookKeys≥1（单门独自｜二元互撑｜多门并肩）+ rationale；台铸 inferKey',
  },
}

export function lookupContract(job: DeskJob): DeskContract {
  return DESK_CONTRACTS[job]
}
