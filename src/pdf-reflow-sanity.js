import { pdfTextRows } from './pdf-reflow.js';

export const PDF_REFLOW_SANITY_VERSION = 1;
const words = text => String(text || '').match(/\p{L}[\p{L}\p{M}'’\d-]*/gu) || [];

// This checks the RESULT against recognition that existed before layout. A
// whole-page fallback deliberately discards its text boxes, so inspecting only
// final blocks would incorrectly call it a textless illustration. Findings are
// review signals: a table, screenshot or equation may legitimately stay raster.
// Never use this heuristic to delete an image or force uncertain OCR into prose.
export function pdfReflowPageSanity(number, extracted, blocks, { reflow = true, markdown = '' } = {}) {
  const text = extracted.text.filter(line => typeof line.text === 'string' && line.text.trim());
  const rows = pdfTextRows(text);
  const prose = rows.filter(row => row.text.length >= 35 && words(row.text).length >= 5);
  const tokens = text.flatMap(line => line.words?.length ? line.words : [line]);
  let known = 0, confident = 0;
  for (const token of tokens) if (Number.isFinite(token.confidence)) {
    const count = words(token.text).length; known += count;
    if (token.confidence >= 80) confident += count;
  }
  const recognizedWords = rows.reduce((sum, row) => sum + words(row.text).length, 0);
  const reflowWords = blocks.reduce((sum, block) => sum + words(block.reflow?.text).length, 0);
  const imageBlocks = blocks.filter(block => !block.reflow);
  const fullPage = imageBlocks.some(block => block.fullPage);
  const contents = rows.some(row => /^(?:table of )?contents\s*$/i.test(row.text.trim()))
    && rows.filter(row => /\s(?:\d{1,4}|[ivxlcdm]{1,8})\s*$/i.test(row.text) && words(row.text).length >= 2).length >= 4;
  // Include short continuation leaves (e.g. two prose lines on an otherwise
  // empty page), while leaving sparse covers and diagram labels unflagged.
  const substantialText = prose.length >= 2 && recognizedWords >= 25 || contents;
  const result = { page: number, recognizedWords, proseLines: prose.length, reflowWords,
    imageBlocks: imageBlocks.length, fullPage, issues: [] };
  if (!reflow || !substantialText) return result;
  const evidence = {
    ...(known ? { confidentWordFraction: Math.round(confident / known * 100) / 100 } : {}),
    ...(contents ? { contents: true } : {}),
    // Structured model output is evidence to REVIEW, never grounds to suppress
    // a warning: a mixed table/prose page can still lose all of its prose.
    ...(/<(?:fcel|ecel|ucel|table)\b|^\s*\|.*\|\s*$/im.test(markdown) ? { structuredContent: true } : {}),
  };
  if (fullPage && reflowWords === 0) result.issues.push({ code: 'text-page-as-image', ...evidence });
  else if (imageBlocks.length && recognizedWords >= 100 && prose.length >= 5 && reflowWords < recognizedWords * .5)
    result.issues.push({ code: 'most-text-not-reflowed', ...evidence });
  else if (!blocks.length) result.issues.push({ code: 'recognized-text-without-content', ...evidence });
  return result;
}

export function pdfReflowSanity(pages, { expectedPages = pages.map(page => page.page), reflow = true } = {}) {
  const checked = new Set(pages.map(page => page.page));
  const missingPages = expectedPages.filter(number => !checked.has(number));
  return { version: PDF_REFLOW_SANITY_VERSION, enabled: reflow, complete: missingPages.length === 0,
    checkedPages: checked.size, missingPages,
    fullPageImages: pages.filter(page => page.fullPage).map(page => page.page),
    issues: pages.flatMap(({ page, recognizedWords, proseLines, reflowWords, issues }) =>
      issues.map(issue => ({ page, ...issue, recognizedWords, proseLines, reflowWords }))) };
}
