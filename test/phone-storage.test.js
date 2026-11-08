import test from 'node:test';
import assert from 'node:assert/strict';
import { AtomicPhoneValue, PhoneLibrary, PhonePreferences, STORAGE_PREFIX, CHUNK_CHARS, bridgeStorage, retryAfterStorageRecovery } from '../src/phone-storage.js';
import { BridgeLane } from '../src/diagnostics.js';
import { PdfPreparationCache } from '../src/pdf-cache.js';
import { localSnapshot, readLocalFile } from '../src/library.js';

function memoryPhone() {
  const values = new Map();
  return { values, failure: null, async get(key) { return values.get(key) || ''; },
    async set(key, value) { if (this.failure?.(key, value)) throw new Error('Storage write failed'); values.set(key, value); } };
}
const document = (text = '# Kept\n\nSaved on the phone', name = 'kept.md') => readLocalFile(new File([text], name));

test('a native storage rejection is logged as an error, with no payloads or false OK', async () => {
  const events = [], lane = new BridgeLane({ log: (type, data) => events.push({ type, ...data }) });
  const kv = bridgeStorage({ setLocalStorage: async () => false, getLocalStorage: async () => null }, lane);
  await assert.rejects(kv.set(`${STORAGE_PREFIX}:doc:secret:0`, 'private text'), { code: 'phone-storage-write' });
  await assert.rejects(kv.get(`${STORAGE_PREFIX}:doc:secret:0`), /storage is unavailable/);
  assert.equal(events.filter(e => e.type === 'bridge-ok').length, 0);
  assert.equal(events.filter(e => e.type === 'bridge-error').length, 2);
  assert.equal(events[1].area, 'doc'); assert.equal(events[1].characters, 12);
  assert.doesNotMatch(JSON.stringify(events), /secret|private text/);
});

test('deletion retries a rejected index save at full quota after freeing only derived caches', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv); await store.read();
  await store.save(await document('# Keep this original', 'keep.md'));
  await store.save(await document('Remove this original '.repeat(2000), 'delete.md'));
  const cache = new PdfPreparationCache(kv);
  await cache.forDocument('keep.md').write('fixture', { text: 'Derived '.repeat(20000) });
  const usage = () => [...kv.values.values()].reduce((sum, value) => sum + value.length, 0), limit = usage();
  const set = kv.set.bind(kv);
  kv.set = async (key, value) => {
    if (usage() - (kv.values.get(key)?.length || 0) + value.length > limit) throw Object.assign(Error('Rejected'), { code: 'phone-storage-write' });
    await set(key, value);
  };
  const doc = store.snapshot.documents[0];
  await assert.rejects(store.updateMetadata([{ id: doc.id, expected: doc, readingWords: 12345 }]), { code: 'phone-storage-write' });
  assert.equal(store.uncertain, false, 'an explicit refusal must not lock future deletion');
  let recovered = 0;
  const result = await retryAfterStorageRecovery(async () => {
    // Deletion preserves conversation references before removing the original.
    await new AtomicPhoneValue(kv, 'reading-recovery-fixture').write({ text: 'History '.repeat(2000) });
    return store.remove('delete.md');
  }, async () => { recovered++; return cache.clear(); });
  assert.equal(recovered, 1); assert.deepEqual(result.snapshot.documents.map(d => d.id), ['keep.md']);
  const reopened = await new PhoneLibrary(kv).read();
  assert.equal(reopened.documents[0].content, '# Keep this original');
  assert(usage() < limit);
});

test('full library storage can delete without any PDF/model caches by reclaiming the unused index', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv); await store.read();
  for (let i = 0; i < 8; i++) await store.save(await document('Original '.repeat(1000), `file-${i}.md`));
  const usage = () => [...kv.values.values()].reduce((sum, value) => sum + value.length, 0), limit = usage(), set = kv.set.bind(kv);
  kv.set = async (key, value) => {
    if (usage() - (kv.values.get(key)?.length || 0) + value.length > limit) throw Object.assign(Error('Full'), { code: 'phone-storage-write' });
    return set(key, value);
  };
  await store.remove('file-4.md');
  const restored = await new PhoneLibrary(kv).read();
  assert.equal(restored.documents.length, 7);
  assert(restored.documents.every(doc => doc.id !== 'file-4.md' && doc.content === 'Original '.repeat(1000)));
  assert(usage() < limit);
});

test('interrupted deletion resumes its saved intent without damaging unselected originals', async () => {
  for (const location of ['inactive', 'journal', 'body', 'index', 'pointer', 'cleanup']) {
    const kv = memoryPhone(), store = new PhoneLibrary(kv); await store.read();
    await store.save(await document('# Kept', 'kept.md')); await store.save(await document('# Selected', 'selected.md'));
    kv.failure = (key, value) => location === 'inactive' ? /:library:[ab]:\d+$/.test(key) && !value
      : location === 'journal' ? key.endsWith(':pending') && value : location === 'body' ? key.includes(':doc:') && !value
      : location === 'index' ? /:library:[ab]:\d+$/.test(key) && value
      : location === 'cleanup' ? key.endsWith(':pending') && !value : key === `${STORAGE_PREFIX}:library`;
    if (location === 'cleanup') await store.remove('selected.md');
    else await assert.rejects(store.remove('selected.md'), /Storage write failed/);
    kv.failure = null;
    const reopened = new PhoneLibrary(kv), saved = await reopened.read();
    assert.deepEqual(saved.documents.map(doc => doc.content), ['inactive', 'journal'].includes(location) ? ['# Kept', '# Selected'] : ['# Kept']);
    await reopened.remove('selected.md');
    assert.equal((await new PhoneLibrary(kv).read()).documents[0].content, '# Kept');
  }
});

test('storage recovery never retries uncertain writes and only retries a rejection once', async () => {
  let calls = 0, recoveries = 0;
  await assert.rejects(retryAfterStorageRecovery(async () => { calls++; throw Object.assign(Error('pending'), { code: 'bridge-timeout' }); }, async () => { recoveries++; return 1; }), /pending/);
  assert.equal(calls, 1); assert.equal(recoveries, 0);
  await assert.rejects(retryAfterStorageRecovery(async () => { calls++; throw Object.assign(Error('refused'), { code: 'phone-storage-write' }); }, async () => { recoveries++; return 1; }), /refused/);
  assert.equal(calls, 3); assert.equal(recoveries, 1);
});

test('a deletion whose pointer commits before a lost acknowledgement cannot delete the next document on restart', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv); await store.read();
  await store.save(await document('# Selected', 'selected.md')); await store.save(await document('# Keep', 'keep.md'));
  const set = kv.set.bind(kv); let pending = true;
  kv.set = async (key, value) => {
    await set(key, value);
    if (pending && key === `${STORAGE_PREFIX}:library`) {
      pending = false; throw Object.assign(Error('Still pending'), { code: 'bridge-timeout' });
    }
  };
  await assert.rejects(store.remove('selected.md'), { code: 'bridge-timeout', deletionPending: true });
  await assert.rejects(store.remove('keep.md'), /could not be confirmed/);
  const restored = await new PhoneLibrary(kv).read();
  assert.deepEqual(restored.documents.map(doc => [doc.id, doc.content]), [['keep.md', '# Keep']]);
  assert.equal(kv.values.get(`${STORAGE_PREFIX}:pending`), '');
});

test('phone documents survive a fresh library with no browser state, and deletions stay deleted', async () => {
  const kv = memoryPhone(); const first = new PhoneLibrary(kv); await first.read();
  const text = '# Long\n\n' + 'a'.repeat(CHUNK_CHARS - 9) + '👓 café\n'.repeat(16000);
  const progress = []; await first.save(await document(text), value => progress.push(value));
  assert.ok(progress.length > 3); assert.equal(progress.at(-1).loaded, progress.at(-1).total);
  const second = new PhoneLibrary(kv);
  assert.equal((await second.read()).documents[0].content, text);
  await second.remove('kept.md');
  assert.equal((await new PhoneLibrary(kv).read(first.snapshot)).documents.length, 0, 'stale browser copies cannot resurrect deleted files');
  assert.ok([...kv.values].filter(([key]) => key.includes(':doc:')).every(([, value]) => value === ''), 'deleted body chunks are cleared');
});

test('failed chunks and interrupted index commits preserve the previous complete library', async () => {
  for (const location of ['body', 'index', 'pointer']) {
    const kv = memoryPhone(); const first = new PhoneLibrary(kv); await first.read(); await first.save(await document());
    kv.failure = (key, value) => value && (location === 'body' ? key.includes(':doc:') : location === 'index' ? /:library:[ab]:\d+$/.test(key) : key === `${STORAGE_PREFIX}:library`);
    await assert.rejects(first.save(await document('# New\n\n' + 'text '.repeat(10000), 'new.md')), /Storage write failed/);
    kv.failure = null;
    const reopened = new PhoneLibrary(kv); const restored = await reopened.read();
    assert.deepEqual(restored.documents.map(d => d.id), ['kept.md']);
    assert.equal(kv.values.get(`${STORAGE_PREFIX}:pending`), '', 'restart cleans an interrupted import journal');
    await reopened.save(await document('# Retry', 'new.md'));
    assert.equal((await new PhoneLibrary(kv).read()).documents.length, 2);
  }
});

test('phone migration resumes without duplicate files and preserves old bookmark keys', async () => {
  const kv = memoryPhone(); const old = localSnapshot({ server: 'https://old.example', documents: [await document('# First', 'first.md'), await document('# Second', 'second.md')] });
  let bodies = 0; kv.failure = key => key.includes(':doc:') && ++bodies === 2;
  await assert.rejects(new PhoneLibrary(kv).read(old)); kv.failure = null;
  const restored = await new PhoneLibrary(kv).read(old);
  assert.deepEqual({ ...restored, documents: restored.documents.map(({ revision, sha256, ...doc }) => doc) }, old);
});

test('concurrent saves use distinct names and index commits never lose an import', async () => {
  const kv = memoryPhone(); const store = new PhoneLibrary(kv); await store.read();
  await Promise.all([store.save(await document('# One')), store.save(await document('# Two'))]);
  assert.deepEqual((await new PhoneLibrary(kv).read()).documents.map(d => d.id), ['kept.md', 'kept (2).md']);
});

test('incomplete saved content fails visibly without resetting the phone library', async () => {
  const kv = memoryPhone(); const store = new PhoneLibrary(kv); await store.read(); await store.save(await document());
  const pointer = kv.values.get(`${STORAGE_PREFIX}:library`);
  const bodyKey = [...kv.values.keys()].find(key => key.includes(':doc:')); kv.values.set(bodyKey, 'truncated');
  await assert.rejects(new PhoneLibrary(kv).read(), /incomplete/);
  assert.equal(kv.values.get(`${STORAGE_PREFIX}:library`), pointer);
});

test('large preference values commit atomically and coalesce to the latest reading position', async () => {
  const kv = memoryPhone(); const errors = [];
  const preferences = new PhonePreferences(kv, error => errors.push(error), 0);
  await preferences.read({});
  const state = { positions: { 'local\nkept.md': { percent: 20 } }, bookmarks: ['x'.repeat(CHUNK_CHARS * 2)] };
  preferences.schedule(state); await preferences.flush();
  preferences.schedule({ ...state, size: 12 }); preferences.schedule({ ...state, size: 26 }); await preferences.flush();
  const fresh = new PhonePreferences(kv, error => errors.push(error));
  assert.equal((await fresh.read({})).size, 26);
  kv.failure = key => /:preferences:[ab]:1$/.test(key);
  preferences.schedule({ ...state, size: 22 }); await preferences.flush(); kv.failure = null;
  assert.equal((await new AtomicPhoneValue(kv, 'preferences').read()).size, 26);
  assert.equal(errors.length, 1);
});

test('an idle preference flush and reverting an unsaved change do not block later saves', async () => {
  const kv = memoryPhone(); const preferences = new PhonePreferences(kv, error => { throw error; });
  await preferences.read({}); await preferences.flush();
  preferences.schedule({ position: 1 }); await preferences.flush();
  preferences.schedule({ position: 2 }); preferences.schedule({ position: 1 }); await preferences.flush();
  assert.deepEqual(await new AtomicPhoneValue(kv, 'preferences').read(), { position: 1 });
  preferences.schedule({ position: 3 }); await preferences.flush();
  assert.deepEqual(await new AtomicPhoneValue(kv, 'preferences').read(), { position: 3 });
});

test('position checkpoints avoid rewriting chats and restore across fresh origins', async () => {
  const kv = memoryPhone(); const state = { updatedAt: 100, askChats: { kept: ['x'.repeat(250000)] }, positions: { book: { percent: 10 } }, selected: { id: 'book' } };
  await new AtomicPhoneValue(kv, 'preferences').write(state);
  const preferences = new PhonePreferences(kv); await preferences.read({});
  const set = kv.set.bind(kv), writes = []; kv.set = (key, text) => { writes.push([key,text.length]); return set(key,text); };
  preferences.schedule({ ...state, updatedAt: 200, positions: { book: { percent: 63 } } }); await preferences.flush();
  assert(writes.every(([key]) => key.includes(':reading-position'))); assert(writes.reduce((sum,[,n])=>sum+n,0) < 1000);
  const reopened = await new PhonePreferences(kv).read({}); assert.equal(reopened.positions.book.percent, 63); assert.deepEqual(reopened.askChats, state.askChats);
  preferences.schedule({ ...reopened, selected: undefined, updatedAt: 300 }); await preferences.flush();
  assert.equal((await new PhonePreferences(kv).read({})).selected, undefined, 'clearing selection also persists');
});

test('a rejected position save reclaims cache once, or stops native retries while retaining pending state', async () => {
  const kv = memoryPhone(); let recoveries = 0, errors = 0;
  const initial = { updatedAt: 100, positions: {} }; await new AtomicPhoneValue(kv, 'preferences').write(initial);
  const preferences = new PhonePreferences(kv, () => errors++, 0, { recover: async () => { recoveries++; kv.failure = null; return 1000; } });
  await preferences.read({}); kv.failure = () => { throw Object.assign(Error('Full'), { code: 'phone-storage-write' }); };
  preferences.schedule({ ...initial, updatedAt: 200, positions: { book: { percent: 20 } } }); await preferences.flush();
  assert.equal(recoveries, 1); assert.equal(errors, 0); assert.equal((await new PhonePreferences(kv).read({})).positions.book.percent, 20);
  kv.failure = () => { throw Object.assign(Error('Full'), { code: 'phone-storage-write' }); }; preferences.schedule({ ...initial, updatedAt: 300 }); await preferences.flush();
  assert.equal(errors, 1); assert.equal(preferences.suspended, true); assert(preferences.pending);
  preferences.schedule({ ...initial, updatedAt: 400 }); await preferences.flush(); assert.equal(errors, 1);
  kv.failure = null; await preferences.resume(); assert.equal((await new PhonePreferences(kv).read({})).updatedAt, 400);
});

test('a newer local position survives reopening before the phone write commits', async () => {
  const kv = memoryPhone(); const old = { updatedAt: 100, mode: 'speed', positions: { paper: { percent: 20 } } };
  await new AtomicPhoneValue(kv, 'preferences').write(old);
  const newer = { updatedAt: 200, mode: 'auto', positions: { paper: { percent: 40 } } };
  const preferences = new PhonePreferences(kv, error => { throw error; });
  assert.deepEqual(await preferences.read(newer), newer);
  preferences.schedule(newer); await preferences.flush();
  assert.deepEqual(await new PhonePreferences(kv).read(old), newer, 'newer phone data still wins over an older browser copy');
  assert.deepEqual(await new PhonePreferences(kv).read({}), newer, 'a fresh WebView retains phone persistence');
});

test('a library above 64 MiB opens metadata only and loads one requested body', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv, { lazy: true }); await store.read();
  const text = 'x'.repeat(4 * 1024 * 1024);
  for (let i = 0; i < 17; i++) await store.save(await document(text, `${i}.txt`));
  assert.equal(store.snapshot.documents.reduce((sum, doc) => sum + doc.bytes, 0), 68 * 1024 * 1024);
  assert(store.snapshot.documents.every(doc => !('content' in doc)));
  const reads = [], get = kv.get.bind(kv); kv.get = key => { reads.push(key); return get(key); };
  const fresh = new PhoneLibrary(kv, { lazy: true });
  const snapshot = await fresh.read(() => { throw Error('Already migrated: legacy data must not load'); });
  assert.equal(reads.filter(key => key.includes(':doc:')).length, 0);
  const selected = snapshot.documents[7];
  assert.equal((await fresh.loadDocument(selected)).content, text);
  assert(reads.filter(key => key.includes(':doc:')).every(key => key.startsWith(selected.revision + ':')));
  assert(snapshot.documents.every(doc => !('content' in doc)), 'opening must not pin bodies in the catalog');
});

test('lazy file reads detect corruption independently and can be cancelled between chunks', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv, { lazy: true }); await store.read();
  await store.save(await document('a'.repeat(CHUNK_CHARS * 3), 'large.txt'));
  await store.save(await document('still readable', 'other.txt'));
  const [large, other] = store.snapshot.documents;
  const controller = new AbortController(), get = kv.get.bind(kv); let chunks = 0;
  kv.get = async key => { if (key.startsWith(large.revision + ':') && ++chunks === 1) controller.abort(); return get(key); };
  await assert.rejects(store.loadDocument(large, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(chunks, 1);
  kv.get = get; kv.values.set(`${large.revision}:0`, 'corrupt');
  const reopened = new PhoneLibrary(kv, { lazy: true }); await reopened.read();
  await assert.rejects(reopened.loadDocument(large), /incomplete/);
  assert.equal((await reopened.loadDocument(other)).content, 'still readable');
});

test('lazy replacement checks revisions, keeps old saves on failure, and never compares absent bodies as equal', async () => {
  const kv = memoryPhone(), store = new PhoneLibrary(kv, { lazy: true }); await store.read();
  await store.save(await document('old')); const expected = store.snapshot.documents[0];
  kv.failure = key => key.includes(':doc:');
  await assert.rejects(store.put(await document('failed'), expected)); kv.failure = null;
  assert.equal((await store.loadDocument(expected)).content, 'old');
  await store.put(await document('new'), expected);
  await assert.rejects(store.put(await document('stale overwrite'), expected), /changed during sync/);
  await assert.rejects(store.remove(expected.id, expected), /changed during sync/);
  await assert.rejects(store.loadDocument(expected), /changed during sync/);
  assert.equal((await store.loadDocument(store.snapshot.documents[0])).content, 'new');
});
