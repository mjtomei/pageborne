import { PDF_NAVIGATION_VERSION } from '../src/pdf-navigation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { libraryManifest, libraryOcrDirectory, libraryPreparation, preparationRequest } from '../integrations/even-terminal/pageborne-library.js';
import { PDF_DEFAULTS } from '../src/pdf-settings.js';
import { PDF_PREPARATION_VERSION, packPdfPreparation, unpackPdfPreparation, PdfPreparationCache } from '../src/pdf-cache.js';
import { CHUNK_CHARS } from '../src/phone-storage.js';
import { createPdfLayout } from '../src/pdf-layout.js';
import { desktopPdfCache } from '../src/desktop-pdf-cache.js';
import { preparedReadingWords } from '../src/reading-estimates.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const engine = 'e'.repeat(64);
function prepared() {
  const line = { x: 20, y: 10, width: 450, height: 30, text: 'The state is the public organization.' };
  const block = { ...line, lines: [line], kind: 'text', reflow: { fontSize: 20, lineHeight: 25, height: 25,
    text: line.text, rows: [{ text: line.text, y: 0, start: 0, end: line.text.length, sourceY: 10, items: [line] }] } };
  const layout = createPdfLayout([{ number: 1, blocks: [block,
    { x: 0, y: 50, width: 500, height: 700, kind: 'figure', text: '', lines: [] }] }]);
  layout.navigation = { version: PDF_NAVIGATION_VERSION, sections: [] };
  return packPdfPreparation(layout, new Map(), new Map([[1, 1.5]]));
}
async function fixture(t) {
  const libraryDir = await mkdtemp(path.join(tmpdir(), 'desktop-ocr-'));
  t.after(() => rm(libraryDir, { recursive: true, force: true }));
  const options = { libraryDir }, name = 'book.pdf';
  await writeFile(path.join(libraryDir, name), '%PDF-source');
  const manifest = await libraryManifest({}, options), doc = manifest.files[0];
  const key = JSON.stringify([PDF_PREPARATION_VERSION, '6.3.289', doc.sha256, PDF_DEFAULTS]);
  const root = await libraryOcrDirectory(options);
  const saved = prepared();
  const state = { engine, preparationVersion: PDF_PREPARATION_VERSION, pdfjs: '6.3.289', heartbeat: Date.now() };
  const announce = () => writeFile(path.join(root, 'daemon.json'), JSON.stringify(state));
  const publish = async () => {
    await announce();
    await mkdir(path.join(root, engine, 'prepared'), { recursive: true });
    await writeFile(path.join(root, engine, 'prepared', hash(key)+'.json'), JSON.stringify({ key, engine, saved }));
  };
  let phone = null, writes = 0, calls = 0;
  const local = { read: async () => phone, write: async (_, value, current = () => true) => { if (current()) { phone = value; writes++; } } };
  const client = { api: async (_, { body }) => { calls++; return libraryPreparation(body, options); } };
  return { options, name, key, root, saved, announce, publish, client, local, state,
    phone: () => phone, writes: () => writes, calls: () => calls };
}

test('desktop preparation is optional; pending requests never expose partial pages', async t => {
  const f = await fixture(t);
  assert.deepEqual(await libraryPreparation(f, f.options), { state: 'unavailable' });
  await f.announce();
  assert.equal((await libraryPreparation(f, f.options)).state, 'pending');
  const queued = JSON.parse(await readFile(path.join(f.root, 'requests', hash(f.key)+'.json')));
  assert.deepEqual(queued, { name: f.name, key: f.key });
  f.state.heartbeat = 0; await f.announce();
  assert.equal((await libraryPreparation(f, f.options)).state, 'unavailable');
  assert.equal(await desktopPdfCache(f.local, f.client, f.name).read(f.key), null);
});

test('library word counts are opt-in, follow current PDF bytes, refresh after repair, and never start OCR', async t => {
  const f = await fixture(t);
  assert.equal((await libraryManifest({ reading: true }, f.options)).files[0].readingWords, undefined);
  await f.publish();
  assert.equal((await libraryManifest({}, f.options)).files[0].readingWords, undefined);
  const words = preparedReadingWords(f.saved.layout);
  assert.equal(words, 6);
  assert.equal((await libraryManifest({ reading: true }, f.options)).files[0].readingWords, words);
  f.saved.layout.blocks[0].reflow.rows[0].text += ' More words.'; await f.publish();
  assert.equal((await libraryManifest({ reading: true }, f.options)).files[0].readingWords, 8);
  f.saved.layout.preparation = { complete: false }; await f.publish();
  assert.equal((await libraryManifest({ reading: true }, f.options)).files[0].readingWords, undefined);
  await writeFile(path.join(f.options.libraryDir, f.name), '%PDF-replaced');
  assert.equal((await libraryManifest({ reading: true }, f.options)).files[0].readingWords, undefined);
  await assert.rejects(readFile(path.join(f.root, 'requests', hash(f.key)+'.json')), /ENOENT/);
});

test('verified desktop artifact downloads once, persists offline, and preserves whole figures', async t => {
  const f = await fixture(t); await f.publish();
  const remote = desktopPdfCache(f.local, f.client, f.name);
  const saved = await remote.read(f.key);
  assert.equal(saved.desktopEngine, engine); assert.equal(f.writes(), 1);
  const restored = unpackPdfPreparation(structuredClone(saved));
  assert.ok(restored.layout.blocks[1].keepTogether); assert.equal(restored.layout.blocks[1].height, 700);
  const calls = f.calls(); await remote.read(f.key);
  assert.equal(f.calls(), calls+1); assert.equal(f.writes(), 1);
  const offline = desktopPdfCache(f.local, { api: async () => { throw new Error('offline'); } }, f.name);
  assert.deepEqual(await offline.read(f.key), saved);
});

test('a phone cache with obsolete chapter navigation receives upgraded OCR metadata once', async t => {
  const f = await fixture(t); await f.publish();
  const old = structuredClone(f.saved); old.layout.navigation = { version: 1, sections: [] }; old.desktopEngine = engine;
  await f.local.write(f.key, old);
  const before = f.writes();
  const remote = desktopPdfCache(f.local, f.client, f.name);
  assert.equal((await remote.read(f.key)).layout.navigation.version, PDF_NAVIGATION_VERSION);
  assert.equal(f.writes(), before + 1);
  await remote.read(f.key); assert.equal(f.writes(), before + 1);
});

test('a repaired layout replaces the phone copy even when the OCR engine is unchanged', async t => {
  const f = await fixture(t); await f.publish();
  const remote = desktopPdfCache(f.local, f.client, f.name);
  const original = await remote.read(f.key);
  f.saved.layout.blocks[0].reflow.rows[0].text = 'Corrected column order.';
  await f.publish();
  const repaired = await remote.read(f.key);
  assert.equal(repaired.desktopEngine, original.desktopEngine);
  assert.notEqual(repaired.desktopSha256, original.desktopSha256);
  assert.equal(repaired.layout.blocks[0].reflow.rows[0].text, 'Corrected column order.');
  assert.equal(unpackPdfPreparation(structuredClone(repaired)).desktopSha256, repaired.desktopSha256);
  const writes = f.writes(); await remote.read(f.key); assert.equal(f.writes(), writes);
});

test('a preparation over 16 MiB transfers in chunks and survives a phone cache restart offline', async t => {
  const f = await fixture(t);
  // Large OCR text is part of the real layout, not extra transfer padding.
  f.saved.layout.blocks[0].lines[0].text = 'Recognized book text. '.repeat(850_000);
  await f.publish();
  const info = await libraryPreparation(f, f.options);
  assert.ok(info.bytes > 16*1024*1024);
  const values = new Map();
  const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
  const cache = new PdfPreparationCache(kv);
  await cache.forDocument('old.pdf').write('old', { text: 'Evicted only after the large book commits.' });
  let chunks = 0;
  const client = { api: async (route, options) => {
    const response = await f.client.api(route, options);
    if (response.data) { chunks++; assert.ok(Buffer.from(response.data, 'base64').length <= 768*1024); }
    return response;
  } };
  const received = await desktopPdfCache(cache.forDocument(f.name), client, f.name).read(f.key);
  assert.ok(chunks > 20);
  assert.deepEqual(received.layout, f.saved.layout);
  assert.ok([...values].filter(([key, value]) => key.includes(':body:') && value).every(([, value]) => value.length <= CHUNK_CHARS));
  assert.equal(await cache.forDocument('old.pdf').read('old'), null);
  const reopened = new PdfPreparationCache(kv).forDocument(f.name);
  const offline = await desktopPdfCache(reopened, { api: async () => { throw new Error('offline'); } }, f.name).read(f.key);
  assert.deepEqual(offline, received);
  assert.ok(unpackPdfPreparation(offline).layout.blocks[1].keepTogether);
});

test('prepared file changes invalidate the cached checksum before another range is served', async t => {
  const f = await fixture(t); await f.publish();
  const before = await libraryPreparation(f, f.options);
  f.saved.layout.blocks[0].text = 'A changed preparation';
  await f.publish();
  await assert.rejects(libraryPreparation({ ...f, offset: 0, sha256: before.sha256 }, f.options), /changed/);
  const after = await libraryPreparation(f, f.options);
  assert.notEqual(after.sha256, before.sha256);
  const chunk = await libraryPreparation({ ...f, offset: after.bytes - 1, sha256: after.sha256 }, f.options);
  assert.equal(Buffer.from(chunk.data, 'base64').length, 1);
  await assert.rejects(libraryPreparation({ ...f, offset: after.bytes, sha256: after.sha256 }, f.options), /offset/);
});

test('a changed original, formatting option, version or symlink cannot supply stale OCR', async t => {
  const f = await fixture(t); await f.publish();
  const changed = JSON.parse(f.key); changed[3].textSize = 28;
  assert.equal((await libraryPreparation({ ...f, key: JSON.stringify(changed) }, f.options)).state, 'pending');
  changed[0]++;
  assert.equal((await libraryPreparation({ ...f, key: JSON.stringify(changed) }, f.options)).state, 'unavailable');
  await writeFile(path.join(f.options.libraryDir, f.name), '%PDF-edited');
  await assert.rejects(libraryPreparation(f, f.options), /changed/i);
  await assert.rejects(libraryPreparation({ ...f, name: '../outside.pdf' }, f.options));
  const second = await fixture(t); await second.publish();
  const artifact = path.join(second.root, engine, 'prepared', hash(second.key)+'.json');
  await rm(artifact); await symlink(path.join(second.options.libraryDir, second.name), artifact);
  await assert.rejects(libraryPreparation(second, second.options), /Linked/);
  assert.throws(() => preparationRequest(JSON.stringify([17, '6.3.289', 'a'.repeat(64), { ...PDF_DEFAULTS, extra: true }])));
});

test('corruption and a document switch cannot overwrite a usable phone preparation', async t => {
  const f = await fixture(t); await f.publish();
  await f.local.write(f.key, f.saved);
  const corrupt = { api: async (route, options) => {
    const response = await f.client.api(route, options);
    return response.data ? { ...response, data: Buffer.from('corrupt').toString('base64') } : response;
  } };
  assert.deepEqual(await desktopPdfCache(f.local, corrupt, f.name).read(f.key), f.saved);
  let current = true;
  const switched = { api: async (route, options) => { const r = await f.client.api(route, options); current = false; return r; } };
  assert.deepEqual(await desktopPdfCache(f.local, switched, f.name, () => current).read(f.key), f.saved);
  assert.equal(f.writes(), 1);
  const brokenLocal = { read: async () => { throw new Error('damaged local cache'); }, write: async () => { throw new Error('full'); } };
  assert.equal((await desktopPdfCache(brokenLocal, f.client, f.name).read(f.key)).desktopEngine, engine);
});
