/**
 * 执行监督归因结果 → 写信台调度（预测轨 / 狭义推理轨）。
 */

import type { BookIndex } from './pipelineA'
import { useAttentionIo, type LetterDeskPackage } from './attentionIoStore'
import { askDeepSeekWithLetterDesk } from './a1DsChat'
import { mapBriefToBook, listAllSettledBriefs } from './masterTableMap'
import type { CritiqueDecision } from './superviseCritique'
import { priorInferKeysForQuery } from './superviseCritique'
import { runAutoFlow } from './autoFlow'

function sid(): string {
  return `crit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export async function executeSuperviseCritique(input: {
  decision: CritiqueDecision
  queryKey: string
  bookIndex: BookIndex
  userText: string
  onProgress?: (msg: string) => void
  sealItems: Parameters<typeof runAutoFlow>[0]['sealItems']
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const { decision, queryKey, bookIndex } = input
  const st = useAttentionIo.getState()
  const q = st.settledQueries[queryKey] || input.userText
  const docId = bookIndex.docId

  if (decision.fault === 'ask_user') {
    st.setDeskPrompt(`写信台 · 监督：${decision.why}`)
    return { ok: false, answer: '', note: `critique_ask_user · ${decision.why}` }
  }

  // ——— 狭义推理轨：必带排除坏 ι，不过 decide ———
  if (decision.fault === 'reason_narrow') {
    let runQ = q
    let runQk = queryKey
    if (decision.reasonSub === 'deepen') {
      const deep =
        decision.deepenQuestion?.trim() ||
        input.userText
          .replace(/^(请)?(深化|收窄|更具体|监督)[：:\s]*/i, '')
          .trim() ||
        q
      runQk = st.ensureDeepenedQueryKey({
        parentQueryKey: queryKey,
        question: deep,
      })
      runQ = st.settledQueries[runQk] || deep
    }

    const excludeKeys = [
      ...new Set([
        ...decision.autopsy.excludeInferKeys,
        ...priorInferKeysForQuery(queryKey),
        ...priorInferKeysForQuery(runQk),
      ]),
    ]
    if (excludeKeys.length === 0) {
      return {
        ok: false,
        answer: '',
        note: 'reason_narrow 但无可排除的先验 ι · 拒绝无差分重跑',
      }
    }

    const briefs =
      decision.autopsy.keepBriefKeys.length > 0
        ? decision.autopsy.keepBriefKeys
        : st.queryKeyToBriefKeys[runQk] ??
          st.queryKeyToBriefKeys[queryKey] ??
          listAllSettledBriefs(docId).map((b) => b.briefKey)
    const briefKey = briefs[0] || ''
    const bookKey =
      (briefKey && mapBriefToBook(docId, briefKey)?.bookKey) ||
      decision.autopsy.touchedBookKeys[0] ||
      ''

    const pkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `critique_infer_${runQk}`,
      bookKey,
      briefKey,
      question: runQ,
      job: 'infer',
      versionIndex: 0,
      createdAt: Date.now(),
      excludeMode: 'B',
      excludeInferKeys: excludeKeys,
      onlyBriefKeys: briefs.length ? briefs : undefined,
    }
    input.onProgress?.(
      `监督 · 狭义推理 · 排除 ι×${excludeKeys.length}` +
        (decision.reasonSub === 'deepen' ? ' · 深化' : ' · 同问'),
    )
    const res = await askDeepSeekWithLetterDesk({
      question: runQ,
      packages: [pkg],
      bookIndex,
      docId,
      turnQueryKey: runQk,
      onProgress: input.onProgress,
    })
    return {
      ok: res.ok,
      answer:
        `### 监督 · 狭义推理轨\n${decision.why}\n排除：${excludeKeys.map((k) => `\`${k}\``).join(', ')}\n\n` +
        (res.answer || ''),
      note: `critique_reason · ${decision.reasonSub} · ${res.note}`,
    }
  }

  // ——— 预测轨：先迭代 decide 策略（尸检提示进窗）；可选再 auto_flow 热启 ———
  const keep = new Set(decision.autopsy.keepBriefKeys)
  const drop = new Set(decision.autopsy.dropBriefKeys)
  let briefKeys =
    keep.size > 0
      ? [...keep]
      : st.queryKeyToBriefKeys[queryKey] ??
        listAllSettledBriefs(docId).map((b) => b.briefKey)
  if (decision.predictSub === 'drop_briefs' && drop.size > 0) {
    briefKeys = briefKeys.filter((b) => !drop.has(b))
  }
  if (briefKeys.length === 0) {
    briefKeys = listAllSettledBriefs(docId).map((b) => b.briefKey)
  }

  const briefKey = briefKeys[0] || ''
  const bookKey =
    (briefKey && mapBriefToBook(docId, briefKey)?.bookKey) || ''

  const decidePkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `critique_decide_${queryKey}`,
    bookKey,
    briefKey,
    question: q,
    job: 'decide',
    versionIndex: 0,
    createdAt: Date.now(),
    onlyBriefKeys: briefKeys,
    decideCritiqueHint: decision.decideStrategyHint,
  }

  input.onProgress?.(`监督 · 预测轨 · ${decision.predictSub || 'reframe'} · decide…`)
  const decideRes = await askDeepSeekWithLetterDesk({
    question: q,
    packages: [decidePkg],
    bookIndex,
    docId,
    turnQueryKey: queryKey,
    onProgress: input.onProgress,
  })

  const parts = [
    `### 监督 · 预测轨\n${decision.why}\n\n${decision.decideStrategyHint}\n\n`,
    decideRes.answer || '### decide · （空）',
  ]

  // need_peek：decide 之后若仍弱，交自动流续热启（策略已进上一窗）
  if (decision.predictSub === 'need_peek') {
    input.onProgress?.('监督 · 预测轨 · 续自动流（可能热启 peek）…')
    const flow = await runAutoFlow({
      question: q,
      bookIndex,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
    })
    parts.push(`### 续自动流\n${flow.answer || flow.note}`)
    return {
      ok: decideRes.ok || flow.ok,
      answer: parts.join('\n\n'),
      note: `critique_predict · need_peek · decide:${decideRes.note} · flow:${flow.note}`,
    }
  }

  // reframe / drop_briefs：decide 后若有充分 prospect，可直开 infer（带排除旧 ι，避免同构）
  const st2 = useAttentionIo.getState()
  const family = new Set(st2.listQuerySelfAndAncestors(queryKey))
  const newProspects = st2.prospects.filter((p) => family.has(p.queryKey))
  const excludeKeys = priorInferKeysForQuery(queryKey)
  if (newProspects.length > 0 && excludeKeys.length > 0) {
    const pk = newProspects[0]!
    const bk = mapBriefToBook(docId, pk.briefKey)?.bookKey || bookKey
    const inferPkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `critique_infer_after_decide_${queryKey}`,
      bookKey: bk,
      briefKey: pk.briefKey,
      question: q,
      job: 'infer',
      versionIndex: 0,
      createdAt: Date.now(),
      excludeMode: 'B',
      excludeInferKeys: excludeKeys,
    }
    input.onProgress?.(
      `监督 · 预测轨 · decide 后 infer（排除旧 ι×${excludeKeys.length}）…`,
    )
    const inferRes = await askDeepSeekWithLetterDesk({
      question: q,
      packages: [inferPkg],
      bookIndex,
      docId,
      turnQueryKey: queryKey,
      onProgress: input.onProgress,
    })
    parts.push(inferRes.answer || '### infer · （空）')
    return {
      ok: decideRes.ok && inferRes.ok,
      answer: parts.join('\n\n'),
      note: `critique_predict · ${decision.predictSub} · ${decideRes.note} → ${inferRes.note}`,
    }
  }

  return {
    ok: decideRes.ok,
    answer: parts.join('\n\n'),
    note: `critique_predict · ${decision.predictSub} · ${decideRes.note}`,
  }
}
