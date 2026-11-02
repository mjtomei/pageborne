import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfNavigationCandidates, pdfNavigationSections } from '../src/pdf-navigation.js';
import { documentContents } from '../src/document-contents.js';
import { createPdfLayout } from '../src/pdf-layout.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';

const box = (text, y, x = 250, width = 400, height = 24) => ({ text, x, y, width, height, confidence: 92 });
const prose = y => box('Ordinary OCR body text continues across the page in a long paragraph.', y, 90, 720);

test('old-book chapter labels join smaller multiline titles and preserve nested numbered sections', () => {
  const text = [box('A RUNNING HEADER', 30), box('CHAPTER', 210, 300, 200), box('IV', 210, 510, 50),
    box('A SMALLER CHAPTER TITLE', 265, 220, 460, 18), box('ON TWO LINES', 295, 320, 260, 18),
    box('I', 340, 445, 10, 20), prose(370), prose(405),
    box('2', 475, 445, 10, 18), prose(505), prose(540), box('37', 865, 440, 20)];
  const result = pdfNavigationSections(pdfNavigationCandidates({ text, width: 900, height: 1000 }, 14));
  assert.deepEqual(result.map(e => [e.title, e.level]), [
    ['CHAPTER IV — A SMALLER CHAPTER TITLE ON TWO LINES', 1], ['Section I', 2], ['Section 2', 2],
  ]);
  assert.equal(result[0].point.y, 210);
});

test('scan furniture and continuation contents pages do not become sections or out-of-order parts', () => {
  const toc = { text: [box('CONTENTS', 100), box('CHAPTER I', 200), box('CHAPTER II', 250)], width: 900, height: 1000 };
  assert.deepEqual(pdfNavigationCandidates(toc, 4), []);
  const result = pdfNavigationSections([
    { title: 'PART VIII. LATER MATERIAL', role: 'part', page: 6 },
    { title: 'PART I — INTRODUCTION', role: 'part', page: 7 },
    { title: 'CHAPTER I — BEGINNING', role: 'chapter', page: 9 },
    { title: 'QUOTED NEWSPAPER HEADLINE', role: 'heading', page: 15 },
    { title: 'Section 2', role: 'section', page: 16 },
    { title: 'INDEX', role: 'heading', page: 40 },
  ]);
  assert.deepEqual(result.map(e => [e.page, e.level]), [[7, 1], [9, 2], [16, 3], [40, 1]]);
});

test('OCR chapter navigation survives full-page image fallback and phone preparation caching', () => {
  const layout = createPdfLayout([1, 2].map(number => ({ number, blocks: [{ kind: 'figure', x: 0, y: 0, width: 900, height: 1200, lines: [], text: '' }] })));
  layout.navigation = { version: 1, outline: [], sections: pdfNavigationSections([1, 2].flatMap(number => pdfNavigationCandidates({ width: 900, height: 1200,
    text: [box(`CHAPTER ${number}`, 210), box(number === 1 ? 'THE FIRST SUBJECT' : 'THE SECOND SUBJECT', 270), prose(350)] }, number))) };
  const packed = JSON.parse(JSON.stringify(packPdfPreparation(layout, new Map(), new Map([[1, 1], [2, 1]]))));
  const restored = unpackPdfPreparation(packed).layout;
  assert.deepEqual(documentContents(restored).map(e => [e.title, e.page, e.y]), [
    ['CHAPTER 1 — THE FIRST SUBJECT', 1, layout.blocks[0].y], ['CHAPTER 2 — THE SECOND SUBJECT', 2, layout.blocks[1].y],
  ]);
});
