import test from 'node:test';
import assert from 'node:assert/strict';
import { readPdfNavigation, documentContents } from '../src/document-contents.js';
import { openNavigationPicker, refreshNavigationPicker, movePositionPicker, togglePositionStep, positionPickerText } from '../src/position-picker.js';
import { parseDocument } from '../src/document.js';
import { nativeLayout, byteLength, VISIBLE_LINES } from '../src/native-text.js';
import { appMenu } from '../src/controls.js';
import { pdfReadingViews } from '../src/pdf-notes.js';
import { createPdfLayout } from '../src/pdf-layout.js';

const prose = 'This paragraph has enough ordinary words to read. '.repeat(20);
const line = (text, y, height = 12) => ({ text, x: 30, y, height, width: 500 });
const crop = (text, y, height = 12) => ({ kind: 'text', x: 20, y, width: 550, height: height + 15, text, lines: [line(text, y, height)] });

test('Markdown levels 1–6 and setext headings navigate to their actual blocks', () => {
  const layout = nativeLayout(parseDocument(`# Title\n\n${prose}\n\n## Second\n\n${prose}\n\n### Detail\n\n${prose}\n\n#### Four\n\n${prose}\n\n##### Five\n\n${prose}\n\n###### Six\n\n${prose}\n\nSetext\n------\n\n${prose}`));
  const entries = documentContents(layout);
  assert.deepEqual(entries.map(e => e.level), [1, 2, 3, 4, 5, 6, 2]);
  for (const [i, entry] of entries.entries()) assert.equal(entry.y, layout.blockY[layout.headings[i].index]);
  let picker = openNavigationPicker(layout, entries[2].y + 10);
  assert.equal(picker.index, 2);
  assert.equal(togglePositionStep(picker), picker, 'holding never opens speech or percentage mode');
  assert.equal(movePositionPicker(picker, -1).index, 1);
  for (let i = 0; i < 30; i++) picker = movePositionPicker(picker, 1);
  assert.equal(picker.index, entries.length - 1);
  assert.equal(positionPickerText(picker, layout).split('\n').length, VISIBLE_LINES);
  assert.match(positionPickerText(picker, layout), /Contents/);
  assert.doesNotMatch(positionPickerText(picker, layout), /%/);
  assert.equal(appMenu(false, true)[1].itemName, 'Contents');
  assert.equal(appMenu(true, true)[1].itemName, 'Go to latest');
});

test('contents rows fit the native display even with deep Unicode headings', () => {
  const layout = nativeLayout(parseDocument(Array.from({length: 12}, (_, i) => `###### ${i} ${'中文👓'.repeat(100)}\n\n${prose}`).join('\n\n')));
  let picker = openNavigationPicker(layout, 0);
  for (let i = 0; i < 12; i++) {
    assert.ok(byteLength(positionPickerText(picker, layout)) < 900);
    picker = movePositionPicker(picker, 1);
  }
});

test('plain prose and a document title alone keep percentage navigation', () => {
  for (const text of [prose, `# Title\n\n${prose}`]) {
    const layout = nativeLayout(parseDocument(text));
    assert.deepEqual(documentContents(layout), []);
    assert.equal(openNavigationPicker(layout, 0).step, 5);
  }
});

test('PDF named, nested, page and precise destinations resolve; invalid/external entries are skipped', async () => {
  const navigation = await readPdfNavigation({ numPages: 3,
    getPageLabels: async () => ['i', '1', '2'],
    getOutline: async () => [{ title: 'Chapter', dest: 'chapter', items: [{ title: 'Detail', dest: [1, { name: 'XYZ' }, 0, 650] }] },
      { title: 'External', url: 'https://example.com' }, { title: 'Broken', dest: [{ broken: true }], items: [{ title: 'End', dest: [2, { name: 'Fit' }] }] }],
    getDestination: async () => [{ num: 1 }, { name: 'Fit' }],
    getPageIndex: async ref => { if (ref.broken) throw Error('bad reference'); return 0; },
    getPage: async () => ({ rotate: 0, getViewport: () => ({ width: 900, height: 1200, convertToViewportPoint: (x, y) => [x, 1200 - y] }) }),
  });
  assert.deepEqual(navigation.outline.map(e => [e.title, e.level, e.page]), [['Chapter', 1, 1], ['Detail', 2, 2], ['End', 2, 3]]);
  assert.deepEqual(navigation.outline[1].point, { x: 0, y: 550 });
  const layout = createPdfLayout([1, 2, 3].map(number => ({ number, blocks: [crop('First', 40), crop('Detail', 550), crop(prose, 600)] })));
  layout.navigation = navigation;
  const entries = documentContents(layout);
  assert.equal(entries[1].y, layout.blocks.find(b => b.page === 2 && b.sourceY === 550).y);
});

test('PDF contents use ready pages only and refresh the selected destination as loading grows', () => {
  const navigation = { outline: [1, 2, 3].map(page => ({ title: `Chapter ${page}`, page, level: 1 })) };
  const partial = createPdfLayout([1, 2].map(number => ({ number, blocks: [crop(prose, 20)] })));
  partial.navigation = navigation; partial.preparation = { complete: false, readyPages: 2 };
  const picker = movePositionPicker(openNavigationPicker(partial, 0), 1);
  assert.equal(picker.entries.length, 2);
  assert.match(positionPickerText(picker, partial), /more loading/);
  const full = createPdfLayout([1, 2, 3].map(number => ({ number, blocks: [crop(prose, 20), crop(prose, 80)] })));
  full.navigation = navigation;
  const refreshed = refreshNavigationPicker(picker, full);
  assert.equal(refreshed.entries.length, 3);
  assert.equal(refreshed.entries[refreshed.index].title, 'Chapter 2');
  assert.notEqual(refreshed.entries[refreshed.index].y, picker.entries[picker.index].y);
});

test('PDF destinations survive footnote removal and blank destination pages', () => {
  const layout = createPdfLayout([{ number: 1, blocks: [crop(prose, 40), { ...crop('A note', 700), annotation: { kind: 'footnote' } }] },
    { number: 2, blocks: [] }, { number: 3, blocks: [crop(prose, 40)] }]);
  layout.navigation = { outline: [{ title: 'First', page: 1 }, { title: 'Second', page: 2 }] };
  const { body } = pdfReadingViews(layout);
  const entries = documentContents(body);
  assert.equal(entries[1].y, body.blocks.find(b => b.page === 3).y);
});

test('PDF derives headings without turning ordinary paragraphs and repeated headers into contents', () => {
  const layout = createPdfLayout([1, 2, 3].map(number => ({ number, blocks: [crop('Running Header', 10, 24), crop(`Section ${number}`, 60, 20), crop(prose, 130, 12)] })));
  assert.deepEqual(documentContents(layout).map(e => e.title), ['Section 1', 'Section 2', 'Section 3']);
  const plain = createPdfLayout([1, 2].map(number => ({ number, blocks: [crop(prose, 40)] })));
  assert.deepEqual(documentContents(plain), []);
});

test('printed contents match titles or explicit page labels, never assume printed folios equal PDF pages', () => {
  const toc = { ...crop('Contents', 40), contents: [{ text: 'First chapter — page 1' }, { text: 'Second chapter — page 2' }] };
  const pages = [{ number: 1, blocks: [toc] }, { number: 2, blocks: [crop(prose, 40)] },
    { number: 3, blocks: [crop('First chapter', 40), crop(prose, 80)] }, { number: 4, blocks: [crop('Second chapter', 40), crop(prose, 80)] }];
  const layout = createPdfLayout(pages);
  assert.deepEqual(documentContents(layout).map(e => e.page), [3, 4]);
  const unmatched = createPdfLayout(pages.map(p => ({ ...p, blocks: p.number === 1 ? p.blocks : [crop(prose, 40)] })));
  assert.deepEqual(documentContents(unmatched), []);
  const labeled = { ...unmatched, navigation: { labels: ['i', 'ii', '1', '2'] } };
  assert.deepEqual(documentContents(labeled).map(e => e.page), [3, 4]);
});

test('a chapter reference in ordinary body text cannot enable percentage-replacing navigation', () => {
  const layout = createPdfLayout([{ number: 1, blocks: [crop('Chapter 7 describes the method used throughout this book', 40), crop(prose, 80)] },
    { number: 2, blocks: [crop(prose, 40)] }]);
  assert.deepEqual(documentContents(layout), []);
});
