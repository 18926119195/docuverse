import type { OcrBlock, OcrPageResult } from '../data/ocrService'
import { protocolEmitPage, type ServerEmittedSlot } from './protocolClient'

function slotsToOcrResult(
  strandIndex: number,
  slots: ServerEmittedSlot[],
  markdown: string,
  pageWidth?: number,
  pageHeight?: number,
): OcrPageResult {
  const blocks: OcrBlock[] = slots.map((s, i) => {
    if (!s.handle || !s.handle.startsWith('h1.')) {
      throw new Error('emit-page missing sealed handle')
    }
    return {
      // Opaque server handle — used as A1 key* by pipelineA
      id: s.handle,
      index: typeof s.slotK === 'number' ? s.slotK : i,
      label: s.label,
      content: s.content,
      sourceContent: s.sourceContent,
      bbox: s.bbox,
      confirmed: false,
      cutBound: true,
      slotK: typeof s.slotK === 'number' ? s.slotK : i,
    }
  })
  return {
    strandIndex,
    markdown,
    blocks,
    pageWidth: pageWidth ?? 0,
    pageHeight: pageHeight ?? 0,
    createdAt: Date.now(),
  }
}

/**
 * Cut→slot emission via server protocol (handles only; lockId never in browser).
 */
export async function emitPageViaProtocol(input: {
  docId: string
  page: number
  strandIndex: number
  imageDataUri: string
}): Promise<OcrPageResult> {
  const res = await protocolEmitPage({
    docId: input.docId,
    page: input.page,
    imageDataUri: input.imageDataUri,
  })
  if (!res.ok) {
    throw new Error(res.error || 'emit-page failed')
  }
  return slotsToOcrResult(
    input.strandIndex,
    res.slots,
    res.markdown,
    res.pageWidth,
    res.pageHeight,
  )
}
