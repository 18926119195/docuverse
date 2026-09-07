/**
 * 写信台契约表：job → allow/forbid + in/out 协议（正文不变，仅调度）。
 * 对齐：对称 key 出入 + 增量落账（方案 B settle）；正文指纹不当门牌。
 * 各工种 out 必须带输入 key 的增量三态：unread | sufficient | insufficient。
 */

import type { DeskJob } from '../reasoning/attentionIoStore'
import { keyStatusContractHint } from './keyIncrementStatus'

export type ContractKeyKind =
  | 'briefKey'
  | 'bookKey'
  | 'queryKey'
  | 'inferKey'
  | 'prospectKey'
  | 'pathKey'

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
    outNote:
      'briefs[{key, brief|briefs[], status}] + keyStatuses；' +
      '同 bookKey 多 brief = 多槽（多条或 briefs:["A","B"] 展开），台各 settle 铸 briefKey；' +
      '仅 sufficient 铸键；items[]/keep[] 已废除；' +
      keyStatusContractHint('bookKey'),
  },
  query: {
    job: 'query',
    allow: ['queryKey'],
    forbid: ['bookKey', 'briefKey'],
    inNote: '旧 queryKey + 历史 Q 文 + Q_now（阶段 A · 无 brief）',
    outNote:
      'neighbours[{queryKey, degree}]（对称子集 + 相关度增量）；' +
      '台为每条 settle neighbourKey 挂在该 historic queryKey 上；' +
      keyStatusContractHint('queryKey'),
  },
  decide: {
    job: 'decide',
    allow: ['briefKey'],
    forbid: ['bookKey'],
    inNote: 'Q_now + {briefKey, brief}[]（无 bookKey/T）',
    outNote:
      'prospects[{briefKey, prospect|prospects[], status}] + keyStatuses；' +
      'briefKey 须字符级回传窗内门牌；多种可能=多槽各 settle；' +
      '仅 sufficient 铸 prospectKey；unread/insufficient 只记状态；' +
      '整窗 coverage 已废；可选 stopReason/seedRange 提示热启 peek；' +
      keyStatusContractHint('briefKey'),
  },
  supervise: {
    job: 'supervise',
    allow: ['briefKey', 'bookKey', 'inferKey', 'prospectKey'],
    forbid: [],
    inNote: 'infer∥prospect（待匹配）；用户未高亮时才进本工种',
    outNote:
      'matches[{inferKey,prospectKey,status?}] → 台 settle pathKey；' +
      keyStatusContractHint('inferKey/prospectKey'),
  },
  infer: {
    job: 'infer',
    allow: ['bookKey'],
    forbid: [],
    inNote:
      '材料 bookKey(+T) + Q_now；可选玩法B排除：inferKey+ι原文（钉ι换方向）；' +
      'reuse失败不向infer塞旧问法——只在decide前剔path用过的briefKey',
    outNote:
      'paths[] + materialStatus/keyStatuses；台每步/每槽 settle 铸 inferKey（一槽一 key）；' +
      '增量字段名=infer（可用 infers[]）；禁止正文哈希合并；' +
      '不自动铸 path——beginPendingPathMatch 等人手；用户跳过后再监督 LLM；' +
      '一条 query 可多条 path；监督可一对多；用户调取多少看多少；' +
      keyStatusContractHint('bookKey'),
  },
}

export function lookupContract(job: DeskJob): DeskContract {
  return DESK_CONTRACTS[job]
}
