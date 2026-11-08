import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PhoneLibrary, bridgeStorage, STORAGE_PREFIX } from '../src/phone-storage.js';
import { BridgeLane } from '../src/diagnostics.js';
import { readLocalFile } from '../src/library.js';
import { syncLibrary, downloadCatalogDocument } from '../src/library-sync.js';
import { libraryManifest, libraryRead, libraryUploadStatus, libraryUploadChunk, libraryCommit, libraryRemove } from '../integrations/even-terminal/pageborne-library.js';

async function fixture(t, cacheChars = 100) {
  const libraryDir = await mkdtemp(path.join(tmpdir(), 'pageborne-on-demand-'));
  t.after(() => rm(libraryDir, { recursive: true, force: true }));
  const values = new Map(), calls = [], writes = [];
  const kv = { async get(k) { return values.get(k) || ''; }, async set(k, v) { writes.push([k, v]); values.set(k, v); } };
  const handlers = { read: libraryRead, status: libraryUploadStatus, chunk: libraryUploadChunk, commit: libraryCommit, remove: libraryRemove };
  const client = { config: { endpoint: 'https://desktop.invalid' }, async api(route, { body, query, signal } = {}) {
    signal?.throwIfAborted(); calls.push(route);
    return route === 'pageborne/library' ? libraryManifest(query, { libraryDir }) : handlers[route.split('/').at(-1)](body, { libraryDir });
  } };
  const options = { lazy: true, onDemand: true, cacheChars, download: (doc, opts) => downloadCatalogDocument(client, doc, opts) };
  let store = new PhoneLibrary(kv, options), saved = {}; await store.read();
  const add = (name, content) => writeFile(path.join(libraryDir, name), content);
  const sync = extras => syncLibrary({ client, store, snapshot: store.snapshot, saved, saveState: async state => { saved = state; }, ...extras });
  return { values, writes, kv, client, calls, options, libraryDir, add, sync, get store() { return store; }, get saved() { return saved; },
    meta: id => store.snapshot.documents.find(d => d.id === id), open: id => store.loadDocument(store.snapshot.documents.find(d => d.id === id)),
    async reopen() { store = new PhoneLibrary(kv, options); await store.read(); return store; } };
}

test('opening a new phone library requires no native writes', async () => {
  const store = new PhoneLibrary({ get: async () => '', set: async () => assert.fail('read must not save an empty migration marker') }, { lazy: true, onDemand: true });
  assert.deepEqual((await store.read()).documents, []); assert.equal(store.syncBaselineTrusted, false);
});

test('raw empty native acknowledgments are distinct from explicit quota rejection', async () => {
  const lane = new BridgeLane({ log() {} });
  const bridge = { callEvenApp: async () => null, setLocalStorage: async () => assert.fail('SDK would hide missing response') };
  const storage = bridgeStorage(bridge, lane);
  await assert.rejects(storage.set('pageborne:models:v1:test', 'tiny'), { code: 'phone-storage-unavailable' });
  assert.equal(storage.health.write, 'unavailable');
  bridge.callEvenApp = async () => false;
  await assert.rejects(storage.set('pageborne:models:v1:test', 'tiny'), { code: 'phone-storage-write' });
  assert.equal(storage.health.write, 'rejected');
});

test('catalog sync downloads no originals, open verifies bytes, cached copy survives restart offline', async t => {
  const f = await fixture(t); await f.add('book.md', '# The title\n\nA short book.');
  const result = await f.sync(); assert.equal(result.listed, 1); assert.equal(result.downloaded, 0);
  assert(!f.calls.some(r => r.endsWith('/read'))); assert.equal(f.meta('book.md').availableOffline, false);
  assert.equal(f.meta('book.md').title, 'The title'); assert(f.meta('book.md').words > 0);
  assert.equal((await f.open('book.md')).content, '# The title\n\nA short book.');
  assert.equal(f.meta('book.md').availableOffline, true);
  await f.reopen(); f.client.api = async () => { throw Error('Offline'); };
  assert.equal((await f.open('book.md')).content, '# The title\n\nA short book.');
});

test('opening downloaded text does not wait for its optional native cache write', async t => {
  const f = await fixture(t); await f.add('book.md', '# Ready\n\nThe network has already delivered the text.'); await f.sync();
  const original = f.kv.set; let release;
  f.kv.set = async (key,value) => { if (key.endsWith(':pending') && value && !release) await new Promise(resolve=>{release=resolve;}); return original(key,value); };
  const doc = await f.store.loadDocument(f.meta('book.md'), {backgroundCache:true});
  assert.match(doc.content,/already delivered/); assert.equal(f.meta('book.md').availableOffline,false);
  while (!release) await new Promise(resolve=>setTimeout(resolve,0));
  release(); await f.store.tail; assert.equal(f.meta('book.md').availableOffline,true);
});

test('persistent LRU evicts only confirmed desktop copies, keeping catalog, imports and history', async t => {
  const f = await fixture(t, 100);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await f.add(name, name.repeat(6)); // 30 chars each
  await f.store.save(await readLocalFile(new File(['Unsynced original'.repeat(100)], 'local.txt')));
  // Catalog receipt does not require uploading the local original for this case.
  const manifest = await libraryManifest({}, { libraryDir: f.libraryDir });
  const source = { libraryId: manifest.id, endpoint: f.client.config.endpoint };
  for (const file of manifest.files) await f.store.putRemote(file, source, null);
  f.values.set('reading-history', 'precious'); f.values.set('complete-model', 'weights');
  await f.open('a.txt'); await new Promise(r => setTimeout(r, 3)); await f.open('b.txt');
  await new Promise(r => setTimeout(r, 3)); await f.open('a.txt');
  await f.reopen(); f.store.cacheChars = 60; await f.open('c.txt');
  assert.equal(f.meta('b.txt').availableOffline, false); assert.equal(f.meta('a.txt').availableOffline, true);
  assert.equal(f.store.cacheUsage, 60); assert.equal(f.store.snapshot.documents.length, 4);
  assert((await f.open('local.txt')).content.startsWith('Unsynced original'));
  assert.equal(await f.store.clearCachedDocuments(), 60); assert.equal(f.store.cacheUsage, 0);
  assert((await f.open('local.txt')).content.startsWith('Unsynced original'));
  assert.equal(f.values.get('reading-history'), 'precious'); assert.equal(f.values.get('complete-model'), 'weights');
  await f.reopen(); assert.equal(f.store.snapshot.documents.length, 4);
});

test('download bigger than cache is readable but not persisted', async t => {
  const f = await fixture(t, 10); await f.add('large.txt', 'content'.repeat(50)); await f.sync();
  const writes = f.writes.length; assert.equal((await f.open('large.txt')).content.length, 350);
  assert.equal(f.writes.length, writes); assert.equal(f.store.cacheUsage, 0);
  assert.equal(f.meta('large.txt').availableOffline, false);
});

test('failed cache write does not prevent reading or damage protected originals', async t => {
  const f = await fixture(t); await f.store.save(await readLocalFile(new File(['Keep me'], 'local.txt')));
  await f.add('remote.txt', 'Download works'); await f.sync();
  const before = new Map(f.values); f.kv.set = async () => { throw Object.assign(Error('Full'), { code: 'phone-storage-write' }); };
  assert.equal((await f.open('remote.txt')).content, 'Download works'); assert.equal(f.meta('remote.txt').availableOffline, false);
  assert.deepEqual(f.values, before); assert.equal((await f.open('local.txt')).content, 'Keep me');
});

test('read-only fallback transfers no originals until opened and never mutates either library', async t => {
  const f = await fixture(t); await f.add('remote.md', '# Remote'); await f.sync();
  const saved = structuredClone(f.saved); f.values.clear(); await f.reopen(); f.store.readOnly = true;
  f.kv.set = async () => assert.fail('read-only native write'); f.calls.length = 0;
  const result = await f.sync({ saved, saveState: async () => assert.fail('read-only baseline mutation') });
  assert(result.readOnly); assert.equal(f.meta('remote.md').availableOffline, false);
  assert.deepEqual(f.calls, ['pageborne/library']);
  assert.equal((await f.open('remote.md')).content, '# Remote');
  await assert.rejects(f.store.remove('remote.md'), { code: 'phone-storage-unavailable' });
  await assert.rejects(f.store.save(await readLocalFile(new File(['new'], 'new.txt'))), { code: 'phone-storage-unavailable' });
  assert(!f.calls.some(r => /remove|commit|chunk|status/.test(r)));
});

test('lost phone index with surviving baseline must never delete desktop originals', async t => {
  const f = await fixture(t); await f.add('remote.txt', 'Original'); await f.sync();
  f.values.clear(); await f.reopen(); f.calls.length = 0; await f.sync();
  assert(!f.calls.some(r => r.endsWith('/remove'))); assert.equal(f.meta('remote.txt').availableOffline, false);
  assert.equal(await readFile(path.join(f.libraryDir, 'remote.txt'), 'utf8'), 'Original');
});

test('changing desktop original invalidates cached body; saved remote reference restores baseline without preferences', async t => {
  const f = await fixture(t); await f.add('remote.txt', 'First'); await f.sync(); await f.open('remote.txt');
  await f.add('remote.txt', 'Second'); await assert.rejects(downloadCatalogDocument(f.client, f.meta('remote.txt')), /changed or is unavailable/);
  await f.sync({ saved: {} }); assert.equal(f.meta('remote.txt').availableOffline, false);
  assert.equal((await f.open('remote.txt')).content, 'Second');
  assert.equal(f.store.snapshot.documents.length, 1);
});

test('migrating old originals confirms hashes before eviction and leaves unsynced contents protected', async t => {
  const f = await fixture(t, 0);
  const old = new PhoneLibrary(f.kv); await old.read();
  await old.save(await readLocalFile(new File(['Same bytes'], 'same.txt')));
  await old.save(await readLocalFile(new File(['Local only'], 'local.txt')));
  await f.add('same.txt', 'Same bytes'); await f.reopen();
  assert.equal(f.store.cacheUsage, 0, 'unconfirmed originals excluded from disposable cache');
  const manifest = await libraryManifest({}, { libraryDir: f.libraryDir });
  await f.store.confirmRemote(manifest.files, { endpoint: f.client.config.endpoint, libraryId: manifest.id });
  assert.equal(f.meta('same.txt').availableOffline, false);
  assert.equal((await f.open('local.txt')).content, 'Local only');
  assert.equal((await f.open('same.txt')).content, 'Same bytes');
});

test('explicit deletion of remote-only document still propagates safely and can restart', async t => {
  const f = await fixture(t); await f.add('remote.txt', 'Remove'); await f.sync();
  await f.store.remove('remote.txt'); await f.reopen(); await f.sync();
  assert(f.calls.some(r => r.endsWith('/remove'))); assert.equal((await libraryManifest({}, { libraryDir: f.libraryDir })).files.length, 0);
});

test('wrong desktop identity, wrong endpoint and corrupt downloads cannot populate cache', async t => {
  const f = await fixture(t); await f.add('remote.txt', 'Data'); await f.sync();
  const expected = f.meta('remote.txt');
  await assert.rejects(downloadCatalogDocument({ ...f.client, config: { endpoint: 'https://wrong.invalid' } }, expected), /Reconnect/);
  const api = f.client.api;
  f.client.api = async (...args) => ({ ...await api(...args), id: 'wrong' });
  await assert.rejects(f.open('remote.txt'), /changed or is unavailable/);
  f.client.api = async (...args) => { const result = await api(...args); return args[0].endsWith('/read') ? { ...result, data: 'YmFkIQ==' } : result; };
  await assert.rejects(f.open('remote.txt'), /checksum mismatch/); assert.equal(f.store.cacheUsage, 0);
});

test('aborted download never caches a partial original', async t => {
  const f = await fixture(t); await f.add('remote.txt', 'content'); await f.sync();
  const controller = new AbortController();
  await assert.rejects(f.store.loadDocument(f.meta('remote.txt'), { signal: controller.signal, progress: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(f.store.cacheUsage, 0); await f.reopen(); assert.equal(f.meta('remote.txt').availableOffline, false);
});

for (const stage of ['journal', 'body', 'index', 'pointer']) test(`cache failure at ${stage} leaves catalog recoverable and desktop original intact`, async t => {
  const f = await fixture(t); await f.add('remote.txt', 'Safe original'); await f.sync();
  const set = f.kv.set; let failed = false;
  f.kv.set = async (key, value) => {
    const match = stage === 'journal' ? key.endsWith(':pending') : stage === 'body' ? key.includes(':doc:') : stage === 'index' ? /:library:[ab]:/.test(key) : key.endsWith(':library');
    if (match && !failed) { failed = true; throw Object.assign(Error('Full'), { code: 'phone-storage-write' }); }
    return set(key, value);
  };
  assert.equal((await f.open('remote.txt')).content, 'Safe original'); assert(failed);
  f.kv.set = set; await f.reopen(); assert.equal((await f.open('remote.txt')).content, 'Safe original');
  assert.equal(await readFile(path.join(f.libraryDir, 'remote.txt'), 'utf8'), 'Safe original');
  assert.equal(f.values.get(`${STORAGE_PREFIX}:pending`), '');
});

test('old body-only revisions stay stable when migrated to remote references', async t => {
  const f = await fixture(t, 0), old = new PhoneLibrary(f.kv); await old.read();
  await old.save(await readLocalFile(new File(['Old bytes'], 'old.txt')));
  delete old.catalog.documents[0].revision; await old.commit(old.catalog);
  await f.add('old.txt', 'Old bytes'); await f.reopen(); const revision = f.meta('old.txt').revision;
  await f.sync(); assert.equal(f.meta('old.txt').revision, revision);
  assert.equal((await f.open('old.txt')).revision, revision);
});

test('interrupted replacement cleanup frees both old and partial cache bodies after reopening', async t => {
  const f = await fixture(t); await f.add('remote.txt', 'Original'); await f.sync(); await f.open('remote.txt');
  const original = f.store.catalog.documents[0].body, expected = f.meta('remote.txt');
  // Force repair of a corrupt cached copy while retaining its cleanup record.
  f.values.set(original.prefix + ':0', 'broken');
  const set = f.kv.set; let committed = false;
  f.kv.set = async (key, value) => {
    if (key.endsWith(':library') && value) committed = true;
    if (committed && key === original.prefix + ':0' && !value) throw Object.assign(Error('Cleanup refused'), { code: 'phone-storage-write' });
    return set(key, value);
  };
  assert.equal((await f.store.loadDocument(expected)).content, 'Original');
  assert.equal(f.values.get(original.prefix + ':0'), 'broken');
  f.kv.set = set; await f.reopen();
  assert.equal(f.values.get(original.prefix + ':0'), ''); assert.equal((await f.open('remote.txt')).content, 'Original');
  assert.equal([...f.values].filter(([k,v]) => k.includes(':doc:') && v).length, 1);
});
