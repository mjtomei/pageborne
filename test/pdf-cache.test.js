import test from 'node:test';
import assert from 'node:assert/strict';
import { PdfPreparationCache, pdfPreparationKey, packPdfPreparation, unpackPdfPreparation, validatePdfPreparation } from '../src/pdf-cache.js';
import { createPdfLayout, pdfAnchor, restorePdfAnchor } from '../src/pdf-layout.js';
import { pdfNativeWindow } from '../src/pdf-native.js';
import { CHUNK_CHARS, STORAGE_PREFIX } from '../src/phone-storage.js';

function memoryPhone() {
  const values = new Map();
  return { values, failure: null, async get(key) { return values.get(key) || ''; },
    async set(key, value) { if (this.failure?.(key, value)) throw new Error('Storage write failed'); values.set(key, value); } };
}
const bodyValues = kv => [...kv.values].filter(([key, value]) => key.includes(':pdf-cache:body:') && value);
const payload = { text: 'Prepared OCR text 👓 café '.repeat(4000) };

test('full PDF bytes, formatting settings and PDF.js version invalidate preparation', async () => {
  const bytes = new Uint8Array(4096); const key = await pdfPreparationKey(bytes, { reflow: true, textSize: 20 }, '6');
  assert.equal(await pdfPreparationKey(bytes, { reflow: true, textSize: 20 }, '6'), key);
  bytes[4095] = 1;
  assert.notEqual(await pdfPreparationKey(bytes, { reflow: true, textSize: 20 }, '6'), key);
  bytes[4095] = 0;
  assert.notEqual(await pdfPreparationKey(bytes, { reflow: false, textSize: 20 }, '6'), key);
  assert.notEqual(await pdfPreparationKey(bytes, { reflow: true, textSize: 24 }, '6'), key);
  assert.notEqual(await pdfPreparationKey(bytes, { reflow: true, textSize: 20 }, '7'), key);
});

test('saved geometry keeps native pages, figures and exact source anchors through JSON', () => {
  const line = { x: 20, y: 10, width: 450, height: 100, text: 'Recognized prose' };
  const prose = { ...line, lines: [line], kind: 'text', reflow: { fontSize: 20, lineHeight: 25, height: 500, nativeWrap: 1, text: line.text,
    rows: Array.from({ length: 20 }, (_, i) => ({ text: `Recognized row ${i}`, y: i * 25, start: i * 17, end: i * 17 + 16, sourceY: 10 + i * 4, items: [line] })) } };
  const figure = { x: 20, y: 200, width: 500, height: 220, kind: 'figure', text: 'Figure', lines: [], colorProfile: { background: [255, 255, 255] } };
  const layout = createPdfLayout([{ number: 1, blocks: [prose, figure] }, { number: 2, blocks: [prose] }]);
  layout.reflowSanity = { version: 1, complete: true, checkedPages: 2, issues: [] };
  layout.pdf = { circular: layout }; layout.sourcePages = ['deliberately excluded'];
  const masks = new Map([[1, [{ x: 2, y: 3, width: 30, height: 10 }]]]); const scales = new Map([[1, 1.5], [2, 1.5]]);
  const encoded = JSON.stringify(packPdfPreparation(layout, masks, scales));
  assert.doesNotMatch(encoded, /items|sourcePages|circular/);
  const checked = JSON.parse(encoded);
  validatePdfPreparation(checked);
  assert.equal(JSON.stringify(checked), encoded, 'validation does not mutate or expand the saved layout');
  const restored = unpackPdfPreparation(JSON.parse(encoded));
  assert.deepEqual(restored.layout.reflowSanity, layout.reflowSanity);
  assert.deepEqual(restored.marginMasks, masks); assert.deepEqual(restored.pageScales, scales);
  assert.deepEqual(restored.layout.pages, layout.pages);
  assert.deepEqual(restored.layout.nativeRuns, layout.nativeRuns);
  const oldPages = JSON.parse(encoded);
  oldPages.layout.pages = [0, 200, oldPages.layout.maxY]; // Previous builds repeated a row.
  assert.deepEqual(unpackPdfPreparation(oldPages).layout.pages, layout.pages, 'cached pages adopt zero overlap without reflow');
  for (const y of [0, 125, layout.blocks[1].y, layout.maxY]) {
    assert.deepEqual(pdfNativeWindow(restored.layout, y), pdfNativeWindow(layout, y));
    assert.equal(restorePdfAnchor(restored.layout, pdfAnchor(layout, y)), y);
  }
  const invalid = JSON.parse(encoded); invalid.layout.blocks[0].scale = null;
  assert.throws(() => unpackPdfPreparation(invalid), /incomplete/);
  assert.throws(() => unpackPdfPreparation({}), /incomplete/);
  const longBook = JSON.parse(encoded);
  longBook.pageScales = longBook.pageScales.map(([page, scale]) => [page === 2 ? 450 : page, scale]);
  for (const block of longBook.layout.blocks) if (block.page === 2) block.page = 450;
  assert.ok(unpackPdfPreparation(longBook).layout.blocks.some(block => block.page === 450));
  longBook.pageScales.push([1001, 1]);
  assert.throws(() => unpackPdfPreparation(longBook), /incomplete/);
});

test('cache budget permits one larger book and restores prior data after an interrupted replacement', async () => {
  const kv = memoryPhone(); const cache = new PdfPreparationCache(kv, { maxChars: 100 });
  await cache.forDocument('old').write('key', { text: 'Older preparation' });
  kv.failure = (key, value) => value && key.includes(':body:') && key.endsWith(':1');
  await assert.rejects(cache.forDocument('large').write('key', payload), /Storage write failed/);
  kv.failure = null;
  assert.deepEqual(await new PdfPreparationCache(kv).forDocument('old').read('key'), { text: 'Older preparation' });
  await cache.forDocument('large').write('key', payload);
  const fresh = new PdfPreparationCache(kv, { maxChars: 100 });
  assert.deepEqual(await fresh.forDocument('large').read('key'), payload);
  assert.equal(await fresh.forDocument('old').read('key'), null);
  await fresh.forDocument('small').write('key', { text: 'Small' });
  assert.equal(await fresh.forDocument('large').read('key'), null);
  assert.equal(bodyValues(kv).length, 1);
});

test('preparation survives SDK-only restart, uses bounded chunks and replaces the same document', async () => {
  const kv = memoryPhone(); const first = new PdfPreparationCache(kv);
  await first.forDocument('a.pdf').write('options1', payload);
  assert.ok(bodyValues(kv).length > 1);
  assert.ok(bodyValues(kv).every(([, value]) => value.length <= CHUNK_CHARS));
  const second = new PdfPreparationCache(kv);
  assert.deepEqual(await second.forDocument('a.pdf').read('options1'), payload);
  assert.equal(await second.forDocument('a.pdf').read('options2'), null);
  await second.forDocument('a.pdf').write('options2', { text: 'New layout' });
  assert.equal(await second.forDocument('a.pdf').read('options1'), null);
  assert.deepEqual(await second.forDocument('a.pdf').read('options2'), { text: 'New layout' });
  assert.equal(bodyValues(kv).length, 1, 'old multi-chunk preparation is reclaimed');
  await second.remove('a.pdf');
  assert.equal(bodyValues(kv).length, 0);
  assert.equal(await new PdfPreparationCache(kv).forDocument('a.pdf').read('options2'), null);
});

test('interrupted chunks/index/pointer retain the last cache and reclaim partial writes', async () => {
  for (const location of ['body', 'index', 'pointer']) {
    const kv = memoryPhone(); const first = new PdfPreparationCache(kv);
    await first.forDocument('a.pdf').write('old', { text: 'Kept' });
    kv.failure = (key, value) => value && (location === 'body' ? key.includes(':body:') && key.endsWith(':1')
      : location === 'index' ? /:pdf-cache:index:[ab]:\d+$/.test(key) : key === `${STORAGE_PREFIX}:pdf-cache:index`);
    await assert.rejects(first.forDocument('a.pdf').write('new', payload), /Storage write failed/);
    kv.failure = null;
    const second = new PdfPreparationCache(kv);
    assert.deepEqual(await second.forDocument('a.pdf').read('old'), { text: 'Kept' });
    assert.equal(await second.forDocument('a.pdf').read('new'), null);
    assert.equal(bodyValues(kv).length, 1);
    await second.forDocument('a.pdf').write('new', payload);
    assert.deepEqual(await second.forDocument('a.pdf').read('new'), payload);
  }
});

test('damaged cache can be replaced and failed cleanup after commit is recovered', async () => {
  const kv = memoryPhone(); const cache = new PdfPreparationCache(kv);
  await cache.forDocument('a.pdf').write('first', payload);
  const [key] = bodyValues(kv)[0]; kv.values.set(key, 'truncated');
  await assert.rejects(cache.forDocument('a.pdf').read('first'), /incomplete/);
  kv.failure = (key, value) => key.includes(':body:') && value === '';
  assert.equal(await cache.forDocument('a.pdf').write('second', { text: 'Fixed' }), true);
  kv.failure = null;
  assert.deepEqual(await new PdfPreparationCache(kv).forDocument('a.pdf').read('second'), { text: 'Fixed' });
  assert.equal(bodyValues(kv).length, 1);
});

test('delete during an ongoing save prevents resurrection and allows a later same-name import', async () => {
  const kv = memoryPhone(); const cache = new PdfPreparationCache(kv); const document = cache.forDocument('a.pdf');
  let removal;
  kv.failure = (key, value) => { if (key.includes(':body:') && value && !removal) removal = cache.remove('a.pdf'); return false; };
  assert.equal(await document.write('first', payload), false);
  await removal; kv.failure = null;
  assert.equal(bodyValues(kv).length, 0);
  assert.equal(await document.write('late', payload), false);
  assert.equal(await cache.forDocument('a.pdf').write('new-import', payload), true);
  await cache.retain([]);
  assert.equal(bodyValues(kv).length, 0);
});

test('cache is bounded, canceled preparation is not committed, oversized cache preserves prior data', async () => {
  const kv = memoryPhone(); const cache = new PdfPreparationCache(kv, { maxChars: 300, maxEntryChars: 200 });
  await cache.forDocument('a').write('key', { text: 'a'.repeat(150) });
  await cache.forDocument('b').write('key', { text: 'b'.repeat(150) });
  assert.equal(await cache.forDocument('a').read('key'), null);
  assert.ok(await cache.forDocument('b').read('key'));
  await assert.rejects(cache.forDocument('b').write('other', { text: 'c'.repeat(200) }), /size limit/);
  assert.ok(await cache.forDocument('b').read('key'));
  assert.equal(await cache.forDocument('c').write('key', {}, () => false), false);
});
