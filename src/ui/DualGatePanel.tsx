/**
 * Dual-gate panel: probe results → human approve/reject → gateway execute.
 */

import type { PendingGatewayPlan } from '../reasoning/harnessGateway'
import { shortHandle } from '../reasoning/ocrSlot'

export interface DualGatePanelProps {
  pending: ReadonlyArray<PendingGatewayPlan>
  onApprove: (planId: string) => void
  onReject: (planId: string) => void
}

export function DualGatePanel({
  pending,
  onApprove,
  onReject,
}: DualGatePanelProps) {
  if (pending.length === 0) {
    return (
      <div className="dual-gate">
        <div className="fanout-k">双闸 · probe→人批→网关</div>
        <p className="fanout-hint">本轮无 scopeRequest / faultIn / partial expand 需人批</p>
      </div>
    )
  }

  const allApproved = pending.every((p) => p.status === 'approved')
  const anyRejected = pending.some((p) => p.status === 'rejected')

  return (
    <div className="dual-gate">
      <div className="fanout-k">
        双闸 · probe→人批→网关 · {pending.length} 条
        {allApproved ? ' · 已全部批准' : anyRejected ? ' · 含拒绝项' : ' · 待人批'}
      </div>
      <ul className="fanout-letter-rows">
        {pending.map((item) => (
          <li key={item.planId} className="fanout-letter-row dual-gate-row">
            <div className="fanout-v">
              {item.plan.action}
              {item.unitKey ? ` · ${shortHandle(item.unitKey)}` : ''}
              <span className="fanout-v muted"> · {item.status}</span>
            </div>
            <div className="fanout-hint">{item.plan.rationale}</div>
            {item.probeResult ? (
              <div className="fanout-hint">{item.probeResult.note}</div>
            ) : null}
            {item.probeResult && item.probeResult.candidateKeys.length > 0 ? (
              <div className="fanout-chips">
                {item.probeResult.candidateKeys.map((k) => (
                  <span key={k} className="fanout-chip" title={k}>
                    {shortHandle(k)}
                  </span>
                ))}
              </div>
            ) : null}
            <div className="fanout-actions">
              <button
                type="button"
                className={
                  item.status === 'approved' ? 'fanout-btn primary' : 'fanout-btn'
                }
                onClick={() => onApprove(item.planId)}
              >
                批准进网关
              </button>
              <button
                type="button"
                className={
                  item.status === 'rejected' ? 'fanout-btn danger' : 'fanout-btn'
                }
                onClick={() => onReject(item.planId)}
              >
                拒绝
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
