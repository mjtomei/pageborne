import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfNavigationCandidates, pdfNavigationSections, pdfNavigationSanity } from '../src/pdf-navigation.js';

const line = (text, y, x = 120, width = text.length * 7, height = 15) => ({ text, x, y, width, height });
const prose = y => line('Ordinary text continues in a paragraph across the width of this scanned book.', y, 120, 650);
const page = (title, y = 130) => ({ width: 900, height: 1165, text: [line(title, y), prose(y + 45), prose(y + 68)] });
const titles = ['Opening', 'Working tools', 'Planning', 'Situated work', 'Shared resources', 'Case and Methods', 'Machine dialogue', 'Conclusion'];
const destinations = [12, 16, 30, 44, 56, 74, 86, 132];
function contents() {
  const entries = titles.map((title, i) => [`CHAPTER ${i + 1}: ${title.toUpperCase()}`, destinations[i] - 9]);
  entries.push(['APPENDIX', 133]);
  return { width: 900, height: 1165, text: [line('Table of Contents', 90), ...entries.map(([title, reference], i) => {
    const y = 170 + i * 42, words = [line(title, y), line(String(reference), y, 740, 15)];
    return { ...line(`${title} ${reference}`, y, 120, 635), words };
  })] };
}
function textbook() {
  return [...pdfNavigationCandidates(contents(), 8), ...titles.flatMap((title, i) =>
    pdfNavigationCandidates(page(`${i + 1}. ${i === 5 ? 'The ' : ''}${title}`), destinations[i]))];
}

test('scanned textbook contents with coarse OCR rows corroborate all eight numbered chapter openings', () => {
  const candidates = textbook(), before = structuredClone(candidates);
  const result = pdfNavigationSections(candidates, { pages: 163 });
  assert.equal(candidates.filter(c => c.role === 'contents').length, 9);
  assert.deepEqual(result.filter(s => s.role === 'chapter').map(s => s.page), destinations);
  assert.ok(result.filter(s => s.role === 'chapter').every(s => s.level === 1 && s.contentsReference));
  assert.deepEqual(result.at(-1), { title: 'APPENDIX', page: 142, level: 1, role: 'heading', contentsReference: '133', inferredFromContents: true });
  assert.deepEqual(pdfNavigationSanity(result, { candidates, pages: 163 }).issues, []);
  assert.deepEqual(candidates, before, 'resolving metadata must not mutate candidate evidence');
});

test('chapter references within prose, paragraphs and running headers never become headings', () => {
  for (const reference of [
    'Chapter 2 for a discussion of both), the author set out to test the method',
    'Chapter 7; (1) the pre-allocation of types of turns, who speaks when',
    'Chapter 7 describes the first encounters with a new machine',
    'CHAPTER 2 OF THE BOOK IS DISCUSSED BY THE AUTHORS',
  ]) {
    const text = [prose(110), line(reference, 133, 120, 650), prose(156)];
    assert.deepEqual(pdfNavigationCandidates({ width: 900, height: 1165, text }, 53), [], reference);
  }
  assert.deepEqual(pdfNavigationCandidates(page('Chapter 7 describes the method'), 74), []);
  assert.deepEqual(pdfNavigationCandidates({ width: 900, height: 1165, text: [line('CHAPTER 2', 20), prose(130)] }, 53), []);
});

test('numbered subsections retain hierarchy and repair missing dots only with unambiguous preceding context', () => {
  const candidates = textbook();
  for (const [p, title] of [[17, '2.1 First subject'], [19, '2.2 Second subject'], [22, '2.3 Third subject'],
    [23, '23.1 First detail'], [26, '2.3.2 Second detail'], [31, '3.1 Another subject'],
    [33, '3.1.2 Second detail'], [35, '313 Third detail'], [36, '999 Unrelated isolated number'],
    [45, '4.1 First subject'], [46, '4.2 Second subject'], [47, '4.3 Third subject'], [49, '44 Fourth subject'],
    [96, '7.3 A subject'], [97, '7.3.1 "Quoted" detail']]) candidates.push(...pdfNavigationCandidates(page(title), p));
  const result = pdfNavigationSections(candidates, { pages: 163 });
  assert.equal(result.find(e => e.page === 23).title, '2.3.1 First detail');
  assert.equal(result.find(e => e.page === 35).title, '3.1.3 Third detail');
  assert.equal(result.find(e => e.page === 49).title, '4.4 Fourth subject');
  assert.equal(result.find(e => e.page === 97).level, 3);
  assert.equal(result.find(e => e.page === 23).level, 3);
  assert.ok(!result.some(e => e.page === 36));
});

test('contents page offsets require three distinct corroborations, consistent pagination and in-range targets', () => {
  const candidates = textbook();
  const insufficient = candidates.filter(e => e.role === 'contents' || e.page <= 16);
  assert.ok(!pdfNavigationSections(insufficient, { pages: 163 }).some(e => e.inferredFromContents));
  const conflicting = candidates.map(e => e.role !== 'contents' && e.page === 30 ? { ...e, page: 31 } : e);
  assert.ok(!pdfNavigationSections(conflicting, { pages: 163 }).some(e => e.inferredFromContents));
  assert.ok(!pdfNavigationSections(candidates, { pages: 140 }).some(e => e.page === 142));
  const bad = [...candidates, { role: 'contents', title: '........noise', reference: '5', page: 8 }];
  assert.ok(!pdfNavigationSections(bad, { pages: 163 }).some(e => e.title === '........noise'));
});

test('a single numbered list item cannot suppress the rest of a document outline as a chapter', () => {
  const result = pdfNavigationSections(pdfNavigationCandidates(page('1. Memory', 400), 2));
  assert.ok(result.every(e => e.role !== 'chapter'));
});

test('automatic sanity checks expose invalid, repeated, backward, prose and missing contents destinations', () => {
  const sections = [{ title: 'Opening', page: 12 }, { title: 'Opening', page: 12 },
    { title: 'Backward', page: 3 }, { title: 'Out of range', page: 999 }, { title: 'Ordinary words '.repeat(25), page: 140 }];
  const report = pdfNavigationSanity(sections, { candidates: [{ title: 'Missing chapter', role: 'contents', reference: '20', page: 8 }], pages: 163 });
  assert.deepEqual(new Set(report.issues.map(i => i.code)), new Set(['invalid-page', 'duplicate-heading', 'backward-page', 'prose-heading', 'unresolved-contents']));
  const roman = [{ title: 'Section I', page: 10 }, { title: 'Section II', page: 10 }];
  assert.deepEqual(pdfNavigationSanity(roman).issues, []);
});

test('a real repeated printed section number keeps both titles and produces a diagnostic', () => {
  const candidates = textbook();
  for (const [n, title] of [[76, '6.3 A subject'], [79, '6.4 The example'], [81, '64 Methodology']])
    candidates.push(...pdfNavigationCandidates(page(title), n));
  const result = pdfNavigationSections(candidates, { pages: 163 });
  assert.equal(result.find(e => e.page === 81).title, '6.4 Methodology');
  assert.deepEqual(pdfNavigationSanity(result, { candidates, pages: 163 }).issues,
    [{ code: 'duplicate-section-number', page: 81, number: '6.4' }]);
});

test('front matter stays alongside chapters without promoting figure captions', () => {
  const list = { width: 900, height: 1165, text: [line('LIST OF FIGURES AND TABLES', 140, 300, 300, 23),
    line('FIGURE 1: A DIAGRAM .................................... 9', 173),
    line('FIGURE 2: ANOTHER DIAGRAM ............................... 20', 210)] };
  const candidates = [...textbook(), ...pdfNavigationCandidates(list, 5), ...pdfNavigationCandidates(page('SUMMARY'), 6)];
  const result = pdfNavigationSections(candidates, { pages: 163 });
  assert.ok(result.some(e => e.title === 'LIST OF FIGURES AND TABLES' && e.page === 5));
  assert.ok(result.some(e => e.title === 'SUMMARY' && e.page === 6));
  assert.ok(!result.some(e => e.title.startsWith('FIGURE')));
  assert.deepEqual(pdfNavigationSanity([{ title: 'FOREWORD', page: 2 }], {
    candidates: [{ role: 'contents', title: 'Foreword', reference: 'i', page: 4 }], pages: 20,
  }).issues, [], 'front matter before the printed contents is already resolved');
});
