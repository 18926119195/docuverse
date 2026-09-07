import type { DiffToken } from './hashDiff'
import { alignTextDiff } from './hashDiff'
import { shortHandle } from '../reasoning/ocrSlot'
import type { InferEdge } from '../reasoning/attentionIoStore'

export type InferPair = {
  leftKey: string
  rightKey: string
  leftText: string
  rightText: string
  tokens: { left: DiffToken[]; right: DiffToken[] } | null
}

/**
 * inferKey 注意力窗 = 这一步推理的 I/O：
 * in  = bookKey(s) 展开原文（+ Q）——单门 / 二元 / 并肩
 * out = 如何独自或互撑 / 并肩走向 Q 的依据
 */
export function pairForInferEdge(edge: InferEdge): InferPair {
  const leftText = edge.leftText
  const rightText = edge.rightText
  const n = edge.bookKeys?.length ?? 2
  return {
    leftKey: n <= 1 ? 'in·单门' : n === 2 ? 'in·两bookKey' : `in·${n}门并肩`,
    rightKey: edge.inferKey,
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
 * inferKey I/O 窗：与「门在哪一页」无关；可选按钮只是跳到 PDF 上那两块原文。
 */
export function InferAttentionCard({
  edge,
  pair,
  expanded,
  onToggle,
  onFocusFrom,
  onFocusTo,
  onOpenQuery,
  onSwitchAttention,
  attentionPinned = false,
}: {
  edge: InferEdge
  pair: InferPair
  expanded: boolean
  onToggle: () => void
  onFocusFrom?: () => void
  onFocusTo?: () => void
  onOpenQuery?: () => void
  onSwitchAttention?: () => void
  attentionPinned?: boolean
}) {
  const n = edge.bookKeys?.length ?? 2
  const unary = n <= 1 || edge.fromBookKey === edge.toBookKey
  const inLabel =
    unary ? '输入 · 单门展开' : n === 2 ? '输入 · 两 bookKey 展开' : `输入 · ${n} 门并肩展开`
  const outLabel = unary
    ? '输出 · 独自走向 Q'
    : n === 2
      ? '输出 · 互撑 / 走向 Q'
      : '输出 · 并肩走向 Q'

  if (!expanded) {
    return (
      <button
        type="button"
        className="hash-delta-chip infer-chip"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        title={`ι ${edge.inferKey} · ${unary ? '单门' : n === 2 ? '二元' : '并肩'}推理 I/O`}
      >
        <span className="hash-delta-chip-k">ι</span>
        <span className="hash-delta-chip-id">
          {shortHandle(edge.inferKey)}
        </span>
      </button>
    )
  }

  return (
    <div
      className="comment-at-c-panel hash-delta-expand hash-delta-expand-wide infer-face-panel"
      role="dialog"
      aria-label="inferKey · 推理 I/O"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="comment-at-c-head">
        <span>ι · 推理步 I/O</span>
        <div className="comment-at-c-actions">
          {onFocusFrom && (
            <button
              type="button"
              className="comment-at-c-stealth"
              onClick={onFocusFrom}
              title={edge.fromBookKey}
            >
              {unary ? '看原文' : '看原文A'}
            </button>
          )}
          {onFocusTo && !unary && (
            <button
              type="button"
              className="comment-at-c-stealth"
              onClick={onFocusTo}
              title={edge.toBookKey}
            >
              看原文B
            </button>
          )}
          {onOpenQuery && (
            <button
              type="button"
              className="comment-at-c-stealth"
              onClick={onOpenQuery}
              title={edge.queryKey}
            >
              qk · {shortHandle(edge.queryKey)}
            </button>
          )}
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
              title="钉住本窗 LLM I/O（打开≠钉住）"
            >
              {attentionPinned ? '已钉住' : '切换注意力'}
            </button>
          )}
          <button
            type="button"
            className="comment-at-c-stealth"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            隐身
          </button>
        </div>
      </div>
      <div className="hash-delta-expand-row flush">
        <div className="hash-delta-expand-cell left">
          <div className="io-attn-label">{inLabel}</div>
          <div className="io-attn-body">
            <Toks tokens={pair.tokens?.left} plain={pair.leftText} />
          </div>
        </div>
        <div className="hash-delta-expand-cell right">
          <div className="io-attn-label">{outLabel}</div>
          <div className="io-attn-body">
            <Toks tokens={pair.tokens?.right} plain={pair.rightText} />
          </div>
        </div>
      </div>
    </div>
  )
}
