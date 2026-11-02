import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfBlankScan, pdfWholePageImage, removePdfScanBorderFragments, pdfScanPageFallback } from '../src/pdf-page-image.js';
import { createPdfLayout, PDF_SCREEN, pdfPageTurn } from '../src/pdf-layout.js';
import { pdfGalleryItems } from '../src/pdf-captions.js';
import { pdfImageFrame } from '../src/pdf-image-frame.js';
import { reflowPdfBlock } from '../src/pdf-reflow.js';

const scan = () => {
  const width = 600, height = 900, data = new Uint8ClampedArray(width * height * 4).fill(255);
  data.fill(0, 20000, 20400);
  for (let i = 20003; i < 20400; i += 4) data[i] = 255;
  return { width, height, data, images: [{ x: 0, y: 0, width, height }], text: [] };
};

test('unresolved scan content becomes one full page without adding crop copies to the gallery', () => {
  const page = scan();
  const annotations = [{ x: 5, y: 100, width: 30, height: 50, kind: 'figure', lines: [], text: '', annotation: { kind: 'handwriting' } }];
  const text = { x: 60, y: 100, width: 480, height: 200, kind: 'text', lines: [], text: 'Readable words', reflow: { text: 'Readable words' } };
  const crop = { x: 80, y: 350, width: 300, height: 80, kind: 'text', lines: [], text: 'Unreadable crop' };
  const input = { blocks: [text, crop], annotations, marginMasks: [{ x: 0, y: 0, width: 600, height: 20 }] };
  const result = pdfScanPageFallback(input, page);
  assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].fullPage, true);
  assert.deepEqual(result.marginMasks, []); assert.equal(result.annotations, annotations);
  const layout = createPdfLayout([{ ...result, number: 1, width: page.width, height: page.height }]);
  assert.equal(pdfGalleryItems(layout).length, 1);
  assert.equal(pdfGalleryItems(layout)[0].block.width, 600); assert.equal(pdfGalleryItems(layout)[0].block.height, 900);
  assert.equal(pdfScanPageFallback(input, { ...page, images: [] }), input, 'native figures keep their normal layout');
  const complete = { ...input, blocks: [text] };
  assert.equal(pdfScanPageFallback(complete, page), complete);
  const blank = { ...input, blocks: [] }; assert.equal(pdfScanPageFallback(blank, page), blank);
});

test('covers and sparse title pages stay whole, fit one glasses pane and appear in the phone gallery', () => {
  const page = scan(); page.text = [{ x: 100, y: 100, width: 400, height: 30, text: 'THE PUBLIC AND ITS PROBLEMS' }];
  const result = pdfWholePageImage(page);
  assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].height, 900);
  const pages = [1, 2].map(number => ({ ...result, number, width: page.width, height: page.height }));
  for (const fitFigures of [true, false]) {
    const layout = createPdfLayout(pages, { fitFigures });
    assert.equal(layout.blocks[0].drawHeight, PDF_SCREEN);
    assert.equal(layout.blocks[0].keepTogether, true);
    assert.equal(pdfPageTurn(layout, 0, 1), layout.blocks[1].y);
    assert.deepEqual(pdfImageFrame(layout, 100, PDF_SCREEN), { y: 0, end: PDF_SCREEN, top: 0 });
    assert.deepEqual(pdfImageFrame(layout, layout.blocks[1].y, PDF_SCREEN), { y: layout.blocks[1].y, end: layout.blocks[1].y + PDF_SCREEN, top: 0 });
    const items = pdfGalleryItems(layout);
    assert.equal(items.length, 2); assert.equal(items[0].title, 'Page image · page 1');
    assert.equal(items[0].block.width, 600); assert.equal(items[0].block.height, 900);
  }
});

test('scanned paragraphs retain reflow and blank pages do not acquire an image', () => {
  const page = scan();
  page.text = Array.from({ length: 12 }, (_, n) => ({ x: 50, y: 100 + n * 20, width: 500, height: 15,
    text: 'A sentence in the body of a scanned book remains available as native text.' }));
  assert.equal(pdfWholePageImage(page), null);
  page.text = []; page.data.fill(255);
  assert.equal(pdfWholePageImage(page), null);
  page.data.fill(0); page.images[0].height = 200;
  assert.equal(pdfWholePageImage(page), null);
});

test('a short paragraph continuation reaches layout analysis instead of being treated as a cover', () => {
  const page = scan();
  page.text = ['the preceding discussion explains why the activities cannot be separated from their setting,',
    'and why an account of their practical circumstances is necessary to understand the result.']
    .map((text, n) => ({ text, x: 50, y: 100 + n * 20, width: 500, height: 15, confidence: 95 }));
  assert.equal(pdfWholePageImage({ ...page, reflow: true }), null);
  assert.equal(pdfWholePageImage(page).blocks[0].fullPage, true);
  page.text = [{ ...page.text[0], text: 'A BOOK TITLE' }, { ...page.text[1], text: 'AN AUTHOR' }];
  assert.equal(pdfWholePageImage({ ...page, reflow: true }).blocks[0].fullPage, true);
});

test('binding shadows after prose do not turn into several empty reflow panes', () => {
  const page = scan(); page.data.fill(255);
  const ink = (x, y, value = 0) => { const i = (y * page.width + x) * 4; page.data.fill(value, i, i + 3); };
  for (let y = 600; y < 899; y++) ink(1, y);
  for (let x = 0; x < page.width; x++) ink(x, 899);
  const body = { x: 60, y: 100, width: 480, height: 400, kind: 'text', text: 'Readable prose. '.repeat(30), lines: [] };
  const strip = { x: 0, y: 600, width: 5, height: 150, kind: 'scan', text: '', lines: [] };
  const wide = { ...strip, y: 770, width: 600, height: 130 };
  const next = { ...pdfWholePageImage({ ...page, text: [] }), number: 2 };
  const blocks = removePdfScanBorderFragments({ ...page, blocks: [body, strip, wide] });
  assert.deepEqual(blocks, [body]);
  const layout = createPdfLayout([{ number: 1, blocks }, next]);
  assert.equal(layout.blocks.length, 2);
  assert.equal(pdfPageTurn(layout, layout.pages.at(-2), 1), layout.blocks[1].y);
  const separateLines = Array.from({ length: 10 }, (_, i) => ({ ...body, y: 100 + i * 25, height: 20, text: 'The printed line remains readable.' }));
  assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [...separateLines, wide] }), separateLines);
  // Even a faint interior stroke is evidence to retain the original image.
  ink(300, 820, 234);
  assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [body, wide] }), [body, wide]);
});

test('border cleanup preserves figures, recognized edge text, isolated marks and sparse scans', () => {
  const page = scan(); page.data.fill(255);
  const body = { x: 60, y: 100, width: 480, height: 400, kind: 'text', text: 'Readable prose. '.repeat(30), lines: [] };
  const edge = { x: 0, y: 600, width: 5, height: 150, kind: 'scan', text: '', lines: [] };
  for (const block of [{ ...edge, kind: 'figure' }, { ...edge, fullPage: true }, { ...edge, text: 'I' },
    { ...edge, lines: [{ text: 'I' }] }, { ...edge, x: 100 }]) {
    assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [body, block] }), [body, block]);
  }
  assert.deepEqual(removePdfScanBorderFragments({ ...page, blocks: [edge] }), [edge]);
});

test('blank scan leaves with paper gradients, edge shadows and isolated specks are omitted', () => {
  const page = scan();
  for (let y = 0; y < page.height; y++) for (let x = 0; x < page.width; x++) {
    const p = (y * page.width + x) * 4, value = x < 3 ? 90 : 245 - Math.floor(x / page.width * 13);
    page.data[p] = page.data[p + 1] = page.data[p + 2] = value;
  }
  for (const [x, y] of [[200, 400], [300, 700]]) page.data.fill(100, (y * page.width + x) * 4, (y * page.width + x) * 4 + 3);
  assert.equal(pdfBlankScan(page), true);
  assert.deepEqual(pdfWholePageImage({ ...page, blank: pdfBlankScan(page) }).blocks, []);
  assert.equal(pdfWholePageImage({ ...page, blank: false }).blocks[0].fullPage, true, 'scan-only view can retain the original');
  page.text = [{ text: 'A faint note', x: 100, y: 100, width: 200, height: 20 }];
  assert.equal(pdfBlankScan(page), false);
});

test('unrecognized faint illustrations and dark photographs are not blank scans', () => {
  const page = scan(); page.data.fill(245);
  for (let y = 100; y < 300; y++) for (let x = 100; x < 300; x++) {
    const p = (y * page.width + x) * 4; page.data.fill(226, p, p + 3);
  }
  assert.equal(pdfBlankScan(page), false, 'low-contrast interior artwork has coherent edges');
  page.data.fill(100); assert.equal(pdfBlankScan(page), false);
});

test('digitization credits reflow while their full original image remains in the gallery', () => {
  const page = scan(); page.text = ['Digitized by the Example Library', 'in 2020', 'https://example.org/book'].map((text, i) =>
    ({ text, x: 80, y: 300 + i * 60, width: 440, height: 20, confidence: 95 }));
  const analysis = pdfWholePageImage({ ...page, reflow: true });
  const block = analysis.blocks[0]; assert.equal(block.digitizationCredit, true);
  block.reflow = reflowPdfBlock(block, { measure: text => text.length * 10, pixels: page.data, pageWidth: page.width });
  assert.ok(block.reflow); assert.match(block.reflow.text, /Digitized by the Example Library/);
  const layout = createPdfLayout([{ ...analysis, number: 6 }]); const items = pdfGalleryItems(layout);
  assert.equal(items.length, 1); assert.equal(items[0].block.fullPage, true); assert.equal(items[0].block.sourceY, 0);
  assert.equal(items[0].block.width, page.width); assert.equal(items[0].block.height, page.height);
  assert.equal(items[0].block.reflow, undefined);
  assert.equal(pdfWholePageImage(page).blocks[0].fullPage, true, 'image-only mode retains the page image');
  page.text.push({ text: 'A book dedication or other content stays in its original page image.', confidence: 95 });
  assert.equal(pdfWholePageImage({ ...page, reflow: true }).blocks[0].fullPage, true);
});

test('original paper pixels remove amplified shadows but preserve interior artwork', () => {
  const page = scan(); page.data.fill(255);
  const originalData = new Uint8ClampedArray(page.data);
  const body = { x: 60, y: 100, width: 480, height: 400, kind: 'text', text: 'Readable prose. '.repeat(30), lines: [] };
  const crop = { x: 0, y: 620, width: 600, height: 280, kind: 'scan', text: '', lines: [] };
  for (let y = 620; y < 900; y++) for (let x = 0; x < 600; x++) {
    const p = (y * 600 + x) * 4, paper = 246 - Math.floor(x / 600 * 18);
    originalData.fill(x > 580 ? 140 : paper, p, p + 3);
    page.data.fill(x > 500 ? 180 : 250, p, p + 3);
  }
  const input = { ...page, originalData, blocks: [body, crop] };
  assert.deepEqual(removePdfScanBorderFragments(input), [body]);
  const narrow = { ...crop, x: 575, width: 25 };
  assert.deepEqual(removePdfScanBorderFragments({ ...input, blocks: [body, narrow] }), [body], 'a crop just outside the edge inset is still paper');
  for (let y = 700; y < 760; y++) for (let x = 200; x < 300; x++) originalData.fill(205, (y * 600 + x) * 4, (y * 600 + x) * 4 + 3);
  assert.deepEqual(removePdfScanBorderFragments(input), [body, crop], 'faint coherent interior drawing remains');
  const mark = { ...crop, x: 200, y: 700, width: 10, height: 10 };
  assert.deepEqual(removePdfScanBorderFragments({ ...input, blocks: [body, mark] }), [body, mark]);
});

test('pale paper stains are omitted from textless crops while continuous faint marks remain', () => {
  const page = scan(); page.data.fill(255);
  const bounds = { x: 100, y: 600, width: 400, height: 200 };
  for (let y = 600; y < 800; y++) for (let x = 100; x < 500; x++) page.data.fill(216, (y * 600 + x) * 4, (y * 600 + x) * 4 + 3);
  for (let y = 690; y < 700; y++) for (let x = 200; x < 210; x++) page.data.fill(202, (y * 600 + x) * 4, (y * 600 + x) * 4 + 3);
  assert.equal(pdfBlankScan({ ...page, bounds }), true);
  for (let x = 300; x < 340; x++) page.data.fill(202, (700 * 600 + x) * 4, (700 * 600 + x) * 4 + 3);
  assert.equal(pdfBlankScan({ ...page, bounds }), false);
});

test('a centered section number can reflow beside binding shadow, but interior ink is still required to match', () => {
  const page = scan(); page.data.fill(255);
  const ink = (x,y,w,h) => { for(let yy=y; yy<y+h; yy++) for(let xx=x; xx<x+w; xx++) page.data.fill(0, (yy*page.width+xx)*4, (yy*page.width+xx)*4+3); };
  const line = { x: 290, y: 300, width: 12, height: 20, text: '5', confidence: 95 };
  const block = { x: 0, y: 298, width: 310, height: 26, kind: 'text', text: '5', lines: [line] };
  ink(290,300,12,20); ink(0,298,15,26);
  const options = { pixels: page.data, pageWidth: page.width, allowSparseUncertainty: true };
  assert.ok(reflowPdfBlock(block, options));
  assert.equal(reflowPdfBlock(block, { ...options, allowSparseUncertainty: false }), null);
  ink(120,300,80,20);
  assert.equal(reflowPdfBlock(block, options), null);
});
