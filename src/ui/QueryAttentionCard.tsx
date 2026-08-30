import type { DiffToken } from './hashDiff'
import { alignTextDiff } from './hashDiff'
import { shortHandle } from '../reasoning/ocrSlot'
import type { InferEdge, QueryReuseLink } from '../reasoning/attentionIoStore'

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
 * 最外 queryKey：点开敞开（评论层气质半透明；L|R 贴紧）。
 * 左 = 问原文；右 = 路径边摘要 / 复用依据。
 */
export function QueryAttentionCard({
  queryKey,
  question,
  edges,
  reuse,
  expanded,
  pathLit = true,
  onToggle,
  onOpenInfer,
  onSwitchAttention,
  attentionPinned = false,
}: {
  queryKey: string
  question: string
  edges: InferEdge[]
  reuse?: QueryReuseLink | null
  expanded: boolean
  /** 路径高亮时 true；降亮时略灰 */
  pathLit?: boolean
  onToggle: () => void
  onOpenInfer?: (inferKey: string) => void
  onSwitchAttention?: () => void
  attentionPinned?: boolean
}) {
  const pathSummary = edges
    .map((e, i) => {
      const keys = e.bookKeys?.length
        ? e.bookKeys
        : [e.fromBookKey, e.toBookKey]
      const chain =
        keys.length <= 1
          ? `${shortHandle(keys[0] ?? e.fromBookKey)}→Q`
          : keys.map((k) => shortHandle(k)).join('─')
      return `${i + 1}. ${chain} · ι ${shortHandle(e.inferKey)}\n   ${e.rationale.slice(0, 120)}`
    })
    .join('\n')
  const rightText = reuse
    ? `复用 → ${reuse.toQueryKey}\n${reuse.rationale}\n\n${pathSummary}`
    : pathSummary || '（尚无 infer 边）'
  const tokens =
    question || rightText ? alignTextDiff(question, rightText) : null

  if (!expanded) {
    return (
      <button
        type="button"
        className={
          pathLit
            ? 'shell-layer-badge query is-clickable path-lit'
            : 'shell-layer-badge query is-clickable path-dim'
        }
        title={question || queryKey}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
      >
        query · {shortHandle(queryKey)}
        {reuse ? (
          <div className="shell-layer-key">──► {shortHandle(reuse.toQueryKey)}</div>
        ) : null}
      </button>
    )
  }

  return (
    <div
      className="comment-at-c-panel hash-delta-expand hash-delta-expand-wide query-face-panel"
      role="dialog"
      aria-label="queryKey · 最外层"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="comment-at-c-head">
        <span>query · {shortHandle(queryKey)}</span>
        <div className="comment-at-c-actions">
          {edges[0] && onOpenInfer && (
            <button
              type="button"
              className="comment-at-c-stealth"
              onClick={() => onOpenInfer(edges[0]!.inferKey)}
            >
              开 ι
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
          <div className="io-attn-label">问 · Q</div>
          <div className="io-attn-body">
            <Toks tokens={tokens?.left} plain={question} />
          </div>
        </div>
        <div className="hash-delta-expand-cell right">
          <div className="io-attn-label">路径 · ι</div>
          <div className="io-attn-body">
            <Toks tokens={tokens?.right} plain={rightText} />
          </div>
        </div>
      </div>
    </div>
  )
}
