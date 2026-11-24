import test from 'node:test';
import assert from 'node:assert/strict';
import { preservePdfInlineMath, hasPdfInlineMath } from '../src/pdf-inline-math.js';
import { reflowPdfBlock } from '../src/pdf-reflow.js';
import { createPdfLayout, pdfAnchor, restorePdfAnchor, pdfPageTurn } from '../src/pdf-layout.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';
import { pdfNativeWindow } from '../src/pdf-native.js';
import { glassesReadingUnits } from '../src/reading-view.js';
import { preparedReadingWords } from '../src/reading-estimates.js';
import { readingWords } from '../src/reading-activity.js';

const line = (text, x, y, width, height = 16) => ({ text, x, y, width, height });
const prose = () => {
  const lines = [line('The experiment compares these two instructions.', 40, 100, 420),
    line('The suggested solution', 40, 122, 180), line('𝑥', 228, 126, 9), line('𝑖', 238, 135, 4, 11),
    line('is wrong.', 250, 122, 80), line('The rest of this paragraph remains ordinary prose.', 40, 154, 420)];
  const block = { x: 38, y: 98, width: 426, height: 74, kind: 'text', text: lines.map(l => l.text).join(' '), lines };
  block.reflow = reflowPdfBlock(block); block.reflow.nativeWrap = 1;
  return block;
};

test('only math-bearing source lines become images, including displaced subscripts', () => {
  const block = prose(), pieces = preservePdfInlineMath(block);
  assert.equal(pieces.length, 3);
  assert.deepEqual(pieces.map(piece => Boolean(piece.reflow)), [true, false, true]);
  assert(pieces[1].inlineMath);
  assert.deepEqual(pieces.flatMap(piece => piece.lines), block.lines, 'each source text box survives exactly once');
  for (const item of pieces[1].lines) {
    assert(item.y >= pieces[1].y && item.y + item.height <= pieces[1].y + pieces[1].height, 'scripts are not clipped by an old paragraph crop');
  }
  assert.equal(pieces[0].reflow.text, block.lines[0].text);
  assert.equal(pieces[2].reflow.text, block.lines.at(-1).text);
  assert(pieces.filter(p => p.reflow).every(p => !hasPdfInlineMath(p.reflow.text)));
});

test('ordinary Greek prose and footnote digits remain text; tables and existing equations are untouched', () => {
  const block = prose();
  for (const text of ['Greek τ, Δ and α in prose.', 'A footnote2 and a year 2026.']) {
    const copy = { ...block, reflow: { ...block.reflow, text } };
    assert.equal(preservePdfInlineMath(copy)[0], copy);
  }
  const raster = { ...block, reflow: null, kind: 'figure' };
  assert.deepEqual(preservePdfInlineMath(raster), [raster]);
});

test('native paging stops at inline math and resumes prose without skipping image strips', () => {
  const layout = createPdfLayout([{ number: 1, blocks: [prose()] }]);
  const math = layout.blocks.find(b => b.inlineMath), after = layout.blocks.at(-1);
  assert.equal(pdfNativeWindow(layout, 0).nextY, math.y);
  assert.equal(pdfNativeWindow(layout, math.y), null);
  assert.equal(pdfPageTurn(layout, math.y, 1), after.y);
  assert.equal(pdfNativeWindow(layout, after.y).content, prose().lines.at(-1).text);
  assert(layout.pages.includes(math.y));
  assert.equal(preparedReadingWords(layout), layout.blocks.reduce((n, b) => n + readingWords(b.text), 0));
  const units = glassesReadingUnits({ layout, y: math.y, mode: 'page' });
  assert.equal(units.length, readingWords(math.text), 'math-bearing prose remains measurable while displayed as an image');
  assert.deepEqual(glassesReadingUnits({ layout, y: math.y + 5, mode: 'page' }), units, 'the same held image keeps stable reading identities');
});

test('old cached layouts upgrade from source geometry without OCR and retain source bookmarks', () => {
  // Create a pre-fix cache by temporarily excluding its math-bearing reflow
  // text from detection, then restore the actual saved text and source boxes.
  const block = prose(), text = block.reflow.text;
  block.reflow.text = 'Legacy prose';
  const old = createPdfLayout([{ number: 1, blocks: [block] }]);
  old.blocks[0].reflow.text = text;
  const before = pdfAnchor(old, 0);
  const saved = packPdfPreparation(old, new Map(), new Map([[1, 1.5]]));
  const restored = unpackPdfPreparation(structuredClone(saved));
  assert(restored.upgraded);
  assert.equal(restored.layout.blocks.filter(b => b.inlineMath).length, 1);
  const y = restorePdfAnchor(restored.layout, before);
  assert.equal(pdfAnchor(restored.layout, y).pdf.page, before.pdf.page);
  assert.equal(pdfAnchor(restored.layout, y).pdf.y, before.pdf.y);
  const next = unpackPdfPreparation(packPdfPreparation(restored.layout, restored.marginMasks, restored.pageScales));
  assert.equal(next.upgraded, false);
  assert.deepEqual(next.layout.pages, restored.layout.pages);
  assert.deepEqual(next.layout.blocks.map(b => b.text), restored.layout.blocks.map(b => b.text));
});
