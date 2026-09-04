import type { DiffToken } from './hashDiff'
import { alignTextDiff } from './hashDiff'
import { shortHandle } from '../reasoning/ocrSlot'
import type {
  AttentionEdge,
  AttentionStep,
} from '../reasoning/attentionIoStore'

export type EdgePair = {
  leftKey: string
  rightKey: string
  leftText: string
  rightText: string
  tokens: { left: DiffToken[]; right: DiffToken[] } | null
}

export function pairForEdge(
  step: AttentionStep,
  edge: AttentionEdge,
): EdgePair | null {
  const left = step.input.find(
    (r) => r.kind === 'book' && r.key === edge.fromKey,
  )
  const right = step.output.find(
    (r) =>
      (r.kind === 'brief' || r.kind === 'delta') && r.key === edge.toKey,
  )
  if (!left && !right) return null
  const leftText = left?.text ?? ''
  const rightText = right?.text ?? ''
  return {
    leftKey: left?.key ?? edge.fromKey,
    rightKey: right?.key ?? edge.toKey,
    leftText,
    rightText,
    tokens:
      leftText || rightText ? alignTextDiff(leftText, rightText) : null,
  }
}

function Toks({
  tokens,
  plain,
}: {
  tokens?: DiffToken[]
  plain: string
}) {
  if (tokens && tokens.length > 0) {
    return (
      <>
        {tokens.map((t, i) => (
          <span key={i} className={`hash-tok tone-${t.tone}`}>
            {t.text}
          </span>
        ))}
      </>
    )
  }
  return <span className="hash-tok tone-only">{plain}</span>
}

/**
 * 评论层 = 注意力窗。
 * 工种由意图 LLM 路由；本窗只负责查看 I/O +「切换注意力」钉住。
 */
export function DeltaAttentionCard({
  briefKey,
  bookKey,
  pair,
  expanded,
  wmOn = false,
  onToggle,
  onSwitchAttention,
  attentionPinned = false,
  onFocusBook,
}: {
  briefKey: string
  bookKey: string
  pair: EdgePair | null
  expanded: boolean
  /** 仍在写信台包里时高亮 chip（非选手选工种） */
  wmOn?: boolean
  onToggle: () => void
  onSwitchAttention?: () => void
  attentionPinned?: boolean
  onFocusBook?: () => void
}) {
  if (!expanded) {
    return (
      <button
        type="button"
        className={wmOn ? 'hash-delta-chip wm' : 'hash-delta-chip'}
        title={`右侧面 brief · ${bookKey} → ${briefKey}`}
        onClick={(ev) => {
          ev.stopPropagation()
          onToggle()
        }}
      >
        {wmOn ? '◆' : 'Δ'} {shortHandle(briefKey)}
      </button>
    )
  }

  return (
    <div
      className="comment-at-c-panel hash-delta-expand hash-delta-expand-wide"
      role="dialog"
      aria-label="决策层 · 注意力"
      onClick={(ev) => ev.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="comment-at-c-head">
        <span>决策层 · 平行于 bookKey</span>
        <div className="comment-at-c-actions">
          {onSwitchAttention && (
            <button
              type="button"
              className={
                attentionPinned
                  ? 'comment-at-c-stealth wm-active'
                  : 'comment-at-c-stealth'
              }
              onClick={(e) => {
                e.stopPropagation()
                onSwitchAttention()
              }}
              title="钉住本窗 LLM I/O（打开≠钉住）；工种由意图 LLM 决定"
            >
              {attentionPinned ? '已钉住' : '切换注意力'}
            </button>
          )}
          <button
            type="button"
            className="comment-at-c-stealth"
            onClick={(ev) => {
              ev.stopPropagation()
              onToggle()
            }}
          >
            隐身
          </button>
        </div>
      </div>

      {pair && (
        <div className="hash-delta-expand-row">
          <div className="hash-delta-expand-cell left">
            <button
              type="button"
              className="io-attn-key"
              title={pair.leftKey}
              onClick={(ev) => {
                ev.stopPropagation()
                onFocusBook?.()
              }}
            >
              输入 · {shortHandle(pair.leftKey)}
            </button>
            <div className="io-attn-body">
              <Toks tokens={pair.tokens?.left} plain={pair.leftText} />
            </div>
          </div>
          <div className="hash-delta-expand-cell right">
            <span className="io-attn-key delta" title={pair.rightKey}>
              评论 · {shortHandle(pair.rightKey)}
            </span>
            <div className="io-attn-body">
              <Toks tokens={pair.tokens?.right} plain={pair.rightText} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
