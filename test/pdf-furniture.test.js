import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatedPdfTextMasks, removeRepeatedPdfDividers, pdfFurnitureText, pdfFurniturePages, pdfPageNumberMasks } from '../src/pdf-furniture.js';
import { insidePdfMargin } from '../src/pdf-margins.js';
import { analyzePdfPage } from '../src/pdf-layout.js';

const line = (text, y, x = 60, width = 470, height = 12) => ({ text, x, y, width, height });

test('hidden scan text supplies missing furniture evidence without replacing corrected prose', () => {
  const body = [180, 205, 230, 255].map(y => line('The corrected body paragraph must remain available.', y));
  const pages = [25, 27].map(n => ({ width: 600, height: 800, text: body,
    furnitureText: pdfFurnitureText([line('PLANS', 35, 200, 60), line(String(n), 35, 500, 20),
      line('Uncorrected original body', 180)], 800) }));
  const alternatives = pdfFurniturePages(pages), masks = repeatedPdfTextMasks(alternatives);
  assert.ok(masks.every(page => page.length === 1));
  assert.ok(body.every(box => !insidePdfMargin(box, masks[0])));
  assert.equal(alternatives[0].text.filter(box => box.text.includes('Uncorrected')).length, 0);
  assert.equal(pages[0].text, body, 'body source objects are unchanged');
  assert.deepEqual(repeatedPdfTextMasks([alternatives[0]]), [[]], 'isolated titles are protected');
  const folio = { ...pages[0], furnitureText: [line('3', 35, 500, 10)] };
  assert.equal(pdfPageNumberMasks(pdfFurniturePages([folio])[0]).length, 1);
});

test('a repeated compact running head survives a damaged OCR folio without retaining its garbage', () => {
  const body = [180, 210, 240, 270].map(y => line('Alphabetical index entry, 25', y, 60, 180, 14));
  const a = { width: 600, height: 800, text: [line('222', 44, 60, 30, 14), line('INDEX', 44, 260, 70, 14), ...body] };
  const b = { ...a, text: [line('INDEX', 44, 230, 70, 14), line('2', 44, 500, 10, 14),
    { ...line('[§v]', 46, 512, 10, 12), confidence: 0 }, { ...line('°S)', 46, 524, 10, 12), confidence: 0 }, ...body] };
  const masks = repeatedPdfTextMasks([a, b]);
  assert.ok(masks.every(page => page.length === 1));
  assert.ok(b.text.slice(0, 4).every(box => insidePdfMargin(box, masks[1])));
  assert.ok(body.every(box => !insidePdfMargin(box, masks[1])));
  assert.deepEqual(repeatedPdfTextMasks([b]), [[]], 'one suspicious edge row is insufficient');
});
const pages = () => Array.from({ length: 8 }, (_, i) => ({ width: 600, height: 800, text: [
  line(i % 2 ? `Journal Review ${100 + i}` : `${100 + i} Running Title`, 42),
  line('A repeated phrase in the body is still content.', 200),
  line(`Unique body paragraph ${i}.`, 230),
  line(`Unique footnote explanation ${i}.`, 687),
  line('Downloaded from the archive on 2026-09-29', 741),
  line('Archive terms apply.', 758),
] }));

function chapterPages() {
  const body = [180, 205, 230, 255].map(y => line('A long body passage that continues the chapter discussion.', y));
  const title = line('SEARCH FOR THE PUBLIC', 150, 150, 330, 20);
  const words = [line('4', 47, 60, 10, 12), line('SEARCH', 45, 220, 70, 14), line('FOR', 45, 300, 30, 14),
    line('THE', 45, 340, 30, 14), line('PUBLIC', 45, 380, 80, 14)];
  const head = { ...line('4 SEARCH FOR THE PUBLIC', 45, 60, 400, 14), words };
  return [{ width: 600, height: 800, text: [title, ...body] }, { width: 600, height: 800, text: [head, ...body] }];
}

test('the first numbered running head is removed using the chapter title in a partial prefix', () => {
  const input = chapterPages(); const masks = repeatedPdfTextMasks(input);
  assert.equal(insidePdfMargin(input[1].text[0], masks[1]), true);
  assert.equal(insidePdfMargin(input[0].text[0], masks[0]), false, 'keep the actual chapter opening');
  assert.ok(input.every((page, i) => page.text.slice(1).every(box => !insidePdfMargin(box, masks[i]))));
  assert.deepEqual(repeatedPdfTextMasks([input[1]]), [[]], 'a lone numbered title is not sufficient evidence');
});

test('alternating folios and footer titles match before the longer repetition threshold', () => {
  const input = chapterPages(); input.shift();
  const original = input[0].text[0];
  const words = [...original.words.slice(1).map(w => ({ ...w, x: w.x - 140 })), line('5', 45, 510, 10, 14)];
  input.push({ ...input[0], text: [{ ...original, text: 'SEARCH FOR THE PUBLIC 5', words }, ...input[0].text.slice(1)] });
  assert.ok(repeatedPdfTextMasks(input).every((masks, i) => insidePdfMargin(input[i].text[0], masks)));
  const footers = chapterPages(); const footer = footers[1].text[0];
  footers[1].text[0] = { ...footer, y: 745, words: footer.words.map(w => ({ ...w, y: w.y + 700 })) };
  assert.ok(insidePdfMargin(footers[1].text[0], repeatedPdfTextMasks(footers)[1]));
  const embedded = chapterPages();
  embedded[1].text.splice(0, 1, line('4', 47, 60, 10, 12), line('SEARCH FOR THE PUBLIC', 45, 220, 240, 14));
  const masks = repeatedPdfTextMasks(embedded)[1];
  assert.ok(embedded[1].text.slice(0, 2).every(box => insidePdfMargin(box, masks)));
});

test('matching prose, normal numbered sections, oversized chapter headings and small prefixes remain', () => {
  for (const change of [head => ({ ...head, y: 300, words: head.words.map(w => ({ ...w, y: 300 })) }),
    head => ({ ...head, text: '4. SEARCH FOR THE PUBLIC', words: head.words.map((w, i) => i ? w : { ...w, text: '4.' }) }),
    head => ({ ...head, height: 26, words: head.words.map(w => ({ ...w, height: 26 })) }),
    head => ({ ...head, words: head.words.map((w, i) => i ? w : { ...w, x: 202 }) })]) {
    const input = chapterPages(); input[1].text[0] = change(input[1].text[0]);
    assert.equal(insidePdfMargin(input[1].text[0], repeatedPdfTextMasks(input)[1]), false);
  }
});

test('recurring edge ornaments disappear without discarding figures, equations, body separators or unique marks', () => {
  const bar = { kind: 'scan', x: 0, y: 110, width: 550, height: 8, lines: [] };
  const content = { kind: 'text', x: 50, y: 200, width: 500, height: 200, lines: [line('Body text', 200)], reflow: { text: 'Body text' } };
  const kept = [{ ...bar, y: 300 }, { ...bar, y: 50, kind: 'figure' }, { ...bar, y: 760, lines: [line('x = y', 760)] }];
  const input = Array.from({ length: 5 }, () => ({ width: 600, height: 800, blocks: [{ ...bar }, content, ...kept] }));
  input[0].blocks.push({ ...bar, y: 135 });
  const output = removeRepeatedPdfDividers(input);
  assert.equal(output[0].blocks.length, 5); assert.equal(output[1].blocks.length, 4);
  assert.deepEqual(output[1].blocks, [content, ...kept]); assert.equal(input[1].blocks.length, 5);
  assert.equal(removeRepeatedPdfDividers(input.slice(0, 2))[0].blocks.length, 6);
});

test('recurring edge text and alternating running heads are hidden, while body and footnotes survive', () => {
  const input = pages(); const masks = repeatedPdfTextMasks(input);
  for (const [i, page] of input.entries()) {
    for (const n of [0, 4, 5]) assert.equal(insidePdfMargin(page.text[n], masks[i]), true);
    for (const n of [1, 2, 3]) assert.equal(insidePdfMargin(page.text[n], masks[i]), false);
  }
});

test('OCR spacing and changing page numbers do not prevent a header match', () => {
  const input = pages(); input[1].text[0].text = 'Journal Re view 101';
  assert.equal(insidePdfMargin(input[1].text[0], repeatedPdfTextMasks(input)[1]), true);
});

test('vertical manuscript watermarks clear their lane while preserving nearby text and chart axes', () => {
  const mark = line('Author Manuscript', 150, 25, 12, 150);
  const axis = line('Elapsed time', 350, 565, 12, 160);
  const title = line('A cover title reaching into the margin', 80, 30, 480, 20);
  const input = pages().map((page, i) => ({ ...page, text: [...page.text, mark, axis, ...(i === 0 ? [title] : [])] }));
  const masks = repeatedPdfTextMasks(input);
  assert.ok(insidePdfMargin(mark, masks[0]));
  assert.ok(insidePdfMargin({ x: 37, y: 550, width: 1, height: 100 }, masks[0]), 'the associated line between watermarks is cleared');
  assert.equal(insidePdfMargin(axis, masks[0]), false);
  assert.equal(insidePdfMargin({ x: 30, y: 82, width: 10, height: 15 }, masks[0]), false, 'other text protects its band');
});

test('a unique title, unique footer and a body phrase matching the running head are retained', () => {
  const input = pages();
  input[0].text[0].text = 'An article title'; input[0].text[4].text = 'A unique publication statement';
  input[2].text.push(line('Journal Review 102', 400));
  const masks = repeatedPdfTextMasks(input);
  assert.equal(insidePdfMargin(input[0].text[0], masks[0]), false);
  assert.equal(insidePdfMargin(input[0].text[4], masks[0]), false);
  assert.equal(insidePdfMargin(input[2].text.at(-1), masks[2]), false);
  assert.deepEqual(repeatedPdfTextMasks(input.slice(0, 2)), [[], []]);
});

test('normalized page positions support PDFs with different page sizes', () => {
  const input = pages(); input[0] = { width: 900, height: 1200,
    text: input[0].text.map(t => ({ ...t, x: t.x * 1.5, y: t.y * 1.5, width: t.width * 1.5, height: t.height * 1.5 })) };
  const masks = repeatedPdfTextMasks(input);
  assert.equal(insidePdfMargin(input[0].text[0], masks[0]), true);
  assert.equal(insidePdfMargin(input[0].text[4], masks[0]), true);
});

test('whole-row masks remove scan glyphs outside their OCR boxes without clipping neighboring text', () => {
  const input = pages(); input[0].text.push(line('A nearby body line.', 62));
  const masks = repeatedPdfTextMasks(input);
  const headerMask = masks[0][0];
  assert.equal(headerMask.x, 0); assert.equal(headerMask.width, 600);
  assert.ok(headerMask.y + headerMask.height <= 62);
  const data = new Uint8ClampedArray(600 * 800 * 4).fill(255);
  for (const [x, y, w, h] of [[20, 40, 8, 15], [60, 63, 250, 10]]) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) data.fill(0, (row * 600 + col) * 4, (row * 600 + col) * 4 + 3);
  }
  const result = analyzePdfPage({ width: 600, height: 800, data, text: input[0].text, pageMasks: masks[0] });
  assert.ok(result.blocks.length > 0);
  assert.ok(result.blocks.every(b => b.y >= 60));
  assert.ok(result.blocks.some(b => b.text.includes('A nearby body line.')));
});

test('an isolated first-page folio is removed even without repetition; body numbers and note markers stay', async () => {
  const { pdfPageNumberMasks } = await import('../src/pdf-furniture.js');
  const page = { width: 600, height: 800, text: [line('A long body passage with a meaningful original number 633.', 200), line('633', 690, 280, 30, 12)] };
  const masks = pdfPageNumberMasks(page);
  assert.equal(insidePdfMargin(page.text[1], masks), true);
  assert.equal(insidePdfMargin(page.text[0], masks), false);
  const withNote = { ...page, text: [page.text[0], line('1', 740, 60, 8, 8), line('Footnote content on the same baseline.', 742, 72, 400, 11)] };
  assert.equal(pdfPageNumberMasks(withNote).length, 0);
  assert.equal(pdfPageNumberMasks({ ...page, text: [page.text[0], line('IV', 320, 280, 20, 16)] }).length, 0, 'Roman section heading remains');
});

test('word-by-word scan text still establishes a body for an isolated nearby bottom folio', async () => {
  const { pdfPageNumberMasks } = await import('../src/pdf-furniture.js');
  const body = ['The', 'last', 'sentence', 'continues', 'here.'].map((text, i) => line(text, 725, 60 + i * 80, 70, 12));
  const folio = line('121', 745, 280, 30, 16);
  const page = { width: 600, height: 800, text: [...body, folio] };
  assert.equal(insidePdfMargin(folio, pdfPageNumberMasks(page)), true);
  assert.equal(pdfPageNumberMasks({ ...page, text: [...body, folio, line('a note on the same line', 749, 320, 220)] }).length, 0);
});

test('repeated sideways publisher watermarks survive OCR variations; marginal notes stay', () => {
  const label = 'Downloaded from example journals at University on 1 November 2026';
  const documents = Array.from({ length: 8 }, (_, i) => ({ width: 600, height: 800, text: [
    line('A substantial body paragraph remains readable in the book.', 200),
    { x: 583+i%3, y: 250, width: 8, height: 300, text: label.replace('University', i%2 ? 'Unlversity' : 'University') },
    { x: 20, y: 300, width: 10, height: 80, text: `My unique handwritten note ${i}` },
  ] }));
  const masks = repeatedPdfTextMasks(documents);
  for (let i = 0; i < documents.length; i++) {
    assert.equal(insidePdfMargin(documents[i].text[1], masks[i]), true);
    assert.equal(insidePdfMargin(documents[i].text[0], masks[i]), false);
    assert.equal(insidePdfMargin(documents[i].text[2], masks[i]), false);
  }
  assert.deepEqual(repeatedPdfTextMasks(documents.slice(0, 1)), [[]]);
  documents[0].text.push({ x: 580, y: 580, width: 15, height: 20, text: 'Real label' });
  assert.equal(insidePdfMargin(documents[0].text.at(-1), repeatedPdfTextMasks(documents)[0]), false);
});
