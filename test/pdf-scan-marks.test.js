import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfScanMarks, pdfUnderlineBlock, pdfScanRuleFragment } from '../src/pdf-scan-marks.js';
import { createPdfLayout } from '../src/pdf-layout.js';
import { pdfAnnotationItems, pdfGalleryItems } from '../src/pdf-captions.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';

function fixture() {
  const width = 600, height = 800, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const at = (yy * width + xx) * 4; data[at] = data[at + 1] = data[at + 2] = 0;
  } };
  const text = Array.from({ length: 12 }, (_, i) => ({ text: 'This printed paragraph remains readable even when someone underlines it.',
    x: 80, y: 100 + i * 40, width: 400, height: 20, confidence: 96 }));
  for (const row of text) for (let x = row.x; x < row.x + row.width; x += 20) rect(x, row.y, 12, 16);
  return { width, height, data, text, rect };
}
test('underline hallucinations are removed without losing printed words; margin handwriting is captured as pixels', () => {
  const p = fixture(); p.rect(100, 123, 300, 2);
  p.text.push({ x: 100, y: 122, width: 300, height: 12, text: '— eer 5 =', confidence: 25 });
  for (let x = 520; x < 575; x += 10) p.rect(x, 155, 6, 15);
  p.text.push({ x: 520, y: 155, width: 55, height: 18, text: 'PoBlit', confidence: 13 });
  const result = pdfScanMarks(p);
  assert.equal(result.text.length, 12); assert.ok(result.text.every(line => line.text.startsWith('This printed')));
  assert.equal(result.annotations.length, 1); assert.ok(result.annotations[0].x > 500);
  assert.equal(result.masks.length, 1);
  assert.equal(pdfUnderlineBlock({ x: 100, y: 122, width: 300, height: 3, kind: 'scan', lines: [] }, result.text), true);
  assert.equal(pdfUnderlineBlock({ x: 100, y: 122, width: 300, height: 30, kind: 'scan', lines: [] }, result.text), false);
});
test('low confidence alone cannot delete a real word, heading, figure or note reference', () => {
  const p = fixture(); const name = { x: 100, y: 123, width: 80, height: 20, text: 'John', confidence: 30 };
  p.text.push(name); p.rect(100, 123, 12, 20); p.rect(140, 123, 12, 20);
  assert.ok(pdfScanMarks(p).text.includes(name));
  p.text = p.text.slice(0, 2);
  assert.deepEqual(pdfScanMarks(p).annotations, []);
});

test('printed reference labels outside hanging indents are not cropped as handwriting', () => {
  const p = fixture();
  for (const y of [100, 260, 420]) {
    const label = { x: 40, y, width: 42, height: 20, text: 'Author,', confidence: 96 };
    for (let x = 40; x < 80; x += 10) p.rect(x, y, 6, 16);
    const row = p.text.find(row => row.y === y);
    row.words = [label, { ...row }]; row.text = `${label.text} ${row.text}`; row.x = 40; row.width = 440;
  }
  // Real, unrecognized writing in the opposite margin must still be saved.
  for (let x = 520; x < 575; x += 10) p.rect(x, 155, 6, 15);
  const result = pdfScanMarks(p);
  assert.equal(result.annotations.length, 1); assert.ok(result.annotations[0].x > 500);
  assert.equal(result.text.filter(row => row.text.startsWith('Author,')).length, 3);
});
test('wavy underline artifacts can touch a footer glyph, while underlined words remain', () => {
  const p = fixture();
  for (let x = 100; x < 400; x++) p.rect(x, 123 + Math.floor(x / 60) % 3, 1, 2);
  p.rect(280, 124, 7, 15);
  const artifact = { x: 100, y: 122, width: 300, height: 18, text: '— eer 5 -', confidence: 34 };
  p.text.push(artifact);
  assert.ok(!pdfScanMarks(p).text.includes(artifact));
  const name = { ...artifact, text: 'John' }; p.text[p.text.length - 1] = name;
  assert.ok(pdfScanMarks(p).text.includes(name));
});
test('thin pencil strokes and detached glyph strokes stay inside the saved crop', () => {
  const p = fixture(); p.rect(520, 150, 1, 24); p.rect(521, 150, 14, 1);
  p.rect(520, 160, 15, 1); p.rect(534, 151, 1, 9);
  p.rect(550, 150, 1, 20); p.rect(551, 169, 12, 1);
  const [crop] = pdfScanMarks(p).annotations;
  assert.ok(crop.y < 150 && crop.y + crop.height > 174);
  assert.ok(crop.x < 520 && crop.x + crop.width > 562);
});
test('attached phantom letters and tiny pen marks do not turn underlined prose into images', () => {
  const p = fixture();
  p.rect(100, 123, 65, 2);
  p.text.push({ x: 100, y: 122, width: 65, height: 14, text: 'N——', confidence: 0 });
  p.rect(180, 163, 30, 2);
  p.text.push({ x: 180, y: 162, width: 30, height: 7, text: 'S—', confidence: 43 });
  p.text.push({ x: 200, y: 202, width: 6, height: 8, text: 'M', confidence: 46 });
  const short = { x: 100, y: 580, width: 100, height: 20, text: 'medium,', confidence: 69 };
  p.text.push(short, { x: 100, y: 605, width: 65, height: 14, text: 'p——', confidence: 0 }); p.rect(100, 606, 65, 2);
  const result = pdfScanMarks(p);
  assert.equal(result.text.length, 13); assert.ok(result.text.includes(short));
  assert.ok(!result.text.some(line => /[—]/.test(line.text) || line.text === 'M'));
  const actual = { x: 100, y: 122, width: 65, height: 20, text: 'John—', confidence: 30 };
  p.text.push(actual); assert.ok(pdfScanMarks(p).text.includes(actual), 'an underlined name is still a word');
});
test('a spurious tiny word can be removed from a printed line without deleting the line', () => {
  const p = fixture();
  const word = { x: 100, y: 540, width: 140, height: 20, text: 'democracy.', confidence: 96 };
  // The artifact lies under an existing printed baseline and has almost no height.
  const pen = { x: 260, y: 562, width: 18, height: 2, text: 'BN', confidence: 0 };
  p.text.push({ ...word, width: 178, height: 24, text: 'democracy. BN', confidence: 40, words: [word, pen] });
  const clean = pdfScanMarks(p).text.at(-1);
  assert.equal(clean.text, 'democracy.'); assert.equal(clean.confidence, 96); assert.deepEqual(clean.words, [word]);
});
test('annotation gallery is separate from reading/figures and survives preparation cache reload', () => {
  const note = { x: 520, y: 150, width: 60, height: 80, kind: 'figure', text: '', lines: [], annotation: { kind: 'handwriting' } };
  const body = { x: 80, y: 100, width: 400, height: 500, kind: 'text', text: 'Printed words', lines: [], reflow: { text: 'Printed words', height: 27, fontSize: 20, lineHeight: 27, rows: [{ text: 'Printed words', y: 0, items: [] }] } };
  const layout = createPdfLayout([{ number: 1, blocks: [body], annotations: [note] }]);
  assert.equal(layout.blocks.length, 1); assert.deepEqual(pdfGalleryItems(layout), []);
  const item = pdfAnnotationItems(layout)[0]; assert.equal(item.block.sourceY, 150); assert.equal(item.page, 1);
  const saved = packPdfPreparation(layout, new Map(), new Map([[1, 1.5]]));
  const restored = unpackPdfPreparation(JSON.parse(JSON.stringify(saved))).layout;
  assert.deepEqual(pdfAnnotationItems(restored), pdfAnnotationItems(layout));
  saved.layout.annotations[0].width = NaN;
  assert.throws(() => unpackPdfPreparation(saved), /annotations are incomplete/);
});

test('a detached footnote separator and broken underline tail are furniture, not page images', () => {
  const p = fixture(); p.data.fill(255);
  const block = { x: 80, y: 124, width: 510, height: 80, kind: 'scan', lines: [], text: '' };
  p.rect(100, 125, 150, 3); p.rect(290, 125, 12, 1);
  assert.equal(pdfScanRuleFragment(block, p), true);
  p.rect(350, 150, 20, 20);
  assert.equal(pdfScanRuleFragment(block, p), false, 'interior artwork is retained');
  p.data.fill(255); p.rect(100, 126, 150, 3);
  assert.equal(pdfScanRuleFragment({ ...block, kind: 'figure' }, p), false);
  assert.equal(pdfScanRuleFragment({ ...block, fullPage: true }, p), false);
  assert.equal(pdfScanRuleFragment({ ...block, text: 'A note' }, p), false);
  assert.equal(pdfScanRuleFragment(block, { ...p, text: [] }), false);
});

test('alphabetic OCR of an underline requires independent absence AND thin-stroke pixels', () => {
  const p = fixture(); p.rect(100, 122, 160, 2);
  const artifact = { x: 100, y: 122, width: 160, height: 15, text: 'Be easn TN', confidence: 3, desktopUnmatched: true };
  p.text.push(artifact);
  assert.ok(!pdfScanMarks(p).text.includes(artifact));
  delete artifact.desktopUnmatched;
  assert.ok(pdfScanMarks(p).text.includes(artifact));
  artifact.desktopUnmatched = true; p.rect(180, 122, 40, 15);
  assert.ok(pdfScanMarks(p).text.includes(artifact), 'an omitted real printed passage is protected');
});
