import { PDF_REFLOW_SANITY_VERSION, pdfReflowPageSanity, pdfReflowSanity } from '../../src/pdf-reflow-sanity.js';

// Read one saved recognition page at a time. No PDF rendering, model imports,
// memory admission changes, or recognition fallbacks are permitted here.
export async function auditCheckpointReflow(saved, readPage, { reflow = true, current = () => true } = {}) {
  const numbers = saved.pageScales.map(([number]) => number).sort((a, b) => a - b);
  const byPage = new Map(numbers.map(number => [number, []]));
  for (const block of saved.layout.blocks) byPage.get(block.page)?.push(block);
  const pages = [];
  const cancelled = () => { throw new DOMException('Reflow audit cancelled.', 'AbortError'); };
  for (const number of numbers) {
    if (!current()) cancelled();
    const checkpoint = await readPage(number);
    if (checkpoint?.number !== number || !Array.isArray(checkpoint.extracted?.text)) continue;
    pages.push(pdfReflowPageSanity(number, checkpoint.extracted, byPage.get(number), { reflow, markdown: checkpoint.markdown }));
  }
  if (!current()) cancelled();
  return { ...pdfReflowSanity(pages, { expectedPages: numbers, reflow }), pages };
}

export async function attachCheckpointReflowSanity(saved, readPage, options) {
  const previous = saved.layout.reflowSanity;
  if (previous?.version === PDF_REFLOW_SANITY_VERSION && previous.complete) return false;
  let audited;
  try { audited = await auditCheckpointReflow(saved, readPage, options); }
  catch (error) { if (error.name === 'AbortError') return false; throw error; }
  const { pages, ...report } = audited;
  // Missing recognition is an incomplete audit, never a clean bill of health.
  // Store it but retry on the next pass if the checkpoints become available.
  if (JSON.stringify(previous) === JSON.stringify(report)) return false;
  saved.layout.reflowSanity = report;
  return true;
}
