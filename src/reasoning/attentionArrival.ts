/**
 * LLM 自报「注意力是否到位」；缺省则写信台补监（§7.5+）。
 * 不写入注意力窗 steps/edges，只供台侧提示。
 */

import { extractJsonObject } from './inferPath'
import { useAttentionIo } from './attentionIoStore'

export type AttentionArrival =
  | { reported: true; arrived: boolean; source: 'llm' }
  | { reported: false; arrived: null; source: 'desk_monitor' }

/** 从任意 LLM JSON out 抽 attentionArrived / attentionReady */
export function parseAttentionArrival(llmText: string): AttentionArrival {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') {
    return { reported: false, arrived: null, source: 'desk_monitor' }
  }
  const root = obj as Record<string, unknown>
  const raw =
    root.attentionArrived ??
    root.attentionReady ??
    root.wmReady ??
    root.attention_ok
  if (typeof raw === 'boolean') {
    return { reported: true, arrived: raw, source: 'llm' }
  }
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (['true', 'yes', '到位', '已到', 'ok', '1'].includes(s)) {
      return { reported: true, arrived: true, source: 'llm' }
    }
    if (['false', 'no', '未到', '不到', '0'].includes(s)) {
      return { reported: true, arrived: false, source: 'llm' }
    }
  }
  return { reported: false, arrived: null, source: 'desk_monitor' }
}

/**
 * 台监：LLM 未自报 → 记台侧提示；自报未到位 → 写信台提示人。
 * 绝不写入 attention steps。
 */
export function deskMonitorAttentionArrival(input: {
  job: string
  llmText: string
  /** decide 可用 coverage 作弱代理：enough≈到位 */
  coverageProxy?: string | null
}): AttentionArrival {
  const parsed = parseAttentionArrival(input.llmText)
  const io = useAttentionIo.getState()

  if (parsed.reported) {
    if (!parsed.arrived) {
      io.setDeskPrompt(
        `写信台 · ${input.job} LLM 自报注意力未到位（attentionArrived=false）。请检查本窗材料或重跑。`,
      )
      io.pushIntentDeskLog({
        question: '',
        action: 'attention_not_arrived',
        note: `${input.job} · llm self-report false`,
      })
    }
    return parsed
  }

  // 台补监：未自报
  const proxy =
    input.coverageProxy === 'enough'
      ? true
      : input.coverageProxy === 'insufficient' ||
          input.coverageProxy === 'partial'
        ? false
        : null

  const note =
    proxy === true
      ? `${input.job} · 未自报注意力；台按 coverage=enough 视为到位`
      : proxy === false
        ? `${input.job} · 未自报注意力；台按 coverage≠enough 视为未到位`
        : `${input.job} · 未自报注意力；台仅记监、不挡下游`

  io.pushIntentDeskLog({
    question: '',
    action: 'desk_monitor_attention',
    note,
  })

  if (proxy === false) {
    io.setLastStatus(`台监 · ${input.job} 注意力可能未到位（LLM 未自报）`)
  }

  return {
    reported: false,
    arrived: proxy,
    source: 'desk_monitor',
  }
}
