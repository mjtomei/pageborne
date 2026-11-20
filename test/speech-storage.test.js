import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deferredSpeechStore, waitForSpeechHost, retirePreviousVoiceModels } from '../src/speech-storage.js';
import { speechSetupFrame, modelFileStatus, modelDownloadSummary } from '../src/speech-setup.js';
import { getTextWidth } from '@evenrealities/pretext';

test('installed apps wait for the native bridge, including after a retry', async () => {
  const host = new EventTarget(), document = { querySelector: () => ({}) };
  await assert.rejects(waitForSpeechHost({ host, document, timeout: 5 }), /Even app connection/);
  let resolved = false;
  const pending = waitForSpeechHost({ host, document, timeout: 1000 }).then(value => { resolved = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(resolved, false);
  host.flutter_inappwebview = { callHandler() {} };
  host.dispatchEvent(new Event('flutterInAppWebViewPlatformReady'));
  assert.equal(await pending, true);
  assert.equal(await waitForSpeechHost({ host, document }), true);
  assert.equal(await waitForSpeechHost({ host: {}, document: { querySelector: () => null } }), false);
});

test('late storage selection reuses verified phone weights in a new app instance without downloading', async () => {
  const bytes = new Uint8Array(96001).fill(73), values = new Map();
  const file = { file: 'model.onnx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/model.onnx' };
  const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
  const first = deferredSpeechStore(); let downloads = 0;
  first.store.fetch = async () => { downloads++; return new Response(bytes); };
  const saving = first.store.ensure(file);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(downloads, 0, 'no download or cache access before initialization chooses storage');
  first.configure(kv); await saving;
  assert.equal(first.store.storageKind, 'phone'); assert.equal(downloads, 1);
  assert(values.has('pageborne:models:v1:' + file.sha256));
  const updated = deferredSpeechStore(); updated.configure(kv);
  updated.store.fetch = () => { throw Error('Offline on next launch'); };
  await updated.store.ensure(file);
  assert.deepEqual(new Uint8Array(await (await updated.store.read(file)).arrayBuffer()), bytes);
  assert.equal(updated.store.stats.downloadedBytes, 0); assert.equal(updated.store.stats.cachedBytes, bytes.length);
});

test('failed phone storage never falls back to a fresh browser cache or a download', async () => {
  const next = deferredSpeechStore(); next.configure({ get() { throw Error('Phone storage unavailable'); } });
  next.store.fetch = () => { throw Error('Must not download'); };
  await assert.rejects(next.store.ensure({ sha256: 'weight' }), /Phone storage unavailable/);
  assert.equal(next.store.stats.downloadedBytes, 0);
});

test('setup distinguishes real downloads, saved files and one missing file across runs', async t => {
  const values = new Map();
  const kv = { get: async key => values.get(key) || '', set: async (key, value) => values.set(key, value) };
  const fixtures = [73, 74].map((n, index) => {
    const bytes = new Uint8Array(96001).fill(n);
    return { bytes, file: { file: `${index}.onnx`, url: `https://example.invalid/${index}.onnx`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') } };
  });
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async url => { downloads++; return new Response(fixtures.find(f => f.file.url === url).bytes); });
  const entry = { model: { name: 'Test model', files: fixtures.map(f => f.file) }, totalBytes: 192002, downloadBytes: 0, state: 'downloading', setup: {} };
  for (let run = 0; run < 3; run++) {
    if (run === 2) values.delete('pageborne:models:v1:' + fixtures[1].file.sha256);
    const { store, configure } = deferredSpeechStore(); configure(kv);
    const observed = [];
    for (const { file } of fixtures) await store.ensure(file, () => observed.push(modelFileStatus(entry, store)));
    assert.equal(modelFileStatus(entry, store).text, 'Saved on phone');
    assert.equal(modelFileStatus(entry, store).value, 1);
    if (run === 1) {
      assert(observed.every(s => !s.downloading));
      assert.equal(store.stats.networkRequests, 0); assert.equal(store.stats.receivedBytes, 0);
      assert.equal(modelDownloadSummary(store), 'Using saved files. Downloaded this run: 0 MB.');
      assert.doesNotMatch(speechSetupFrame([entry], '', store).body, /Downloading/);
    } else {
      assert(observed.some(s => s.downloading && /Downloading/.test(s.text)));
      assert.equal(store.stats.networkRequests, run ? 1 : 2);
      assert.equal(store.stats.receivedBytes, run ? 96001 : 192002);
      assert.match(modelDownloadSummary(store), /Downloaded this run: 0\.[12] MB/);
    }
    assert.equal(store.files.size, 2);
  }
  assert.equal(downloads, 3, 'only the missing file redownloads on the third run');
});

test('download counter retains failed bytes and counts retry traffic without calling it cached', async t => {
  const bytes = new Uint8Array(96001).fill(73), values = new Map();
  const file = { file: 'model.onnx', url: 'https://example.invalid/model.onnx', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => new Response(++calls === 1 ? new Uint8Array(bytes.length) : bytes));
  const { store, configure } = deferredSpeechStore();
  configure({ get: async key => values.get(key) || '', set: async (key, value) => values.set(key, value) });
  await assert.rejects(store.ensure(file), /integrity/);
  assert.equal(store.files.get(file.sha256).state, 'error');
  assert.equal(store.stats.receivedBytes, bytes.length);
  await store.ensure(file);
  assert.equal(store.stats.receivedBytes, bytes.length * 2);
  assert.equal(store.stats.networkRequests, 2);
  await store.ensure(file);
  assert.equal(store.stats.networkRequests, 2);
  assert.equal(store.stats.receivedBytes, bytes.length * 2);
  assert.match(modelDownloadSummary(store), /0\.2 MB/);
});

test('glasses setup screen identifies loading, errors and progress within native text bounds', () => {
  const entries = [
    { model: { name: 'Conformer CTC Small' }, state: 'ready', ready: { verified: true }, setup: {} },
    { model: { name: 'Zipformer 20M' }, state: 'idle', setup: {} },
    { model: { name: 'Moonshine Base' }, state: 'loading', setup: { stage: 'loading' } },
  ];
  const message = speechSetupFrame(entries);
  assert.match(message.body, /Moonshine Base\nLoading saved files/);
  assert.match(message.status, /1\/3 ready/);
  assert.doesNotMatch(message.body, /library/i);
  assert(message.body.split('\n').length <= 9);
  for (const line of [...message.body.split('\n'), message.status]) assert(getTextWidth(line) <= 552, line);
  const error = speechSetupFrame(entries, 'Interrupted setup');
  assert.match(error.body, /needs attention/); assert.match(error.status, /phone.*retry/);
});

test('verification device identity survives rotation but changes with hardware/runtime hints', async () => {
  const { speechDeviceIdentity } = await import('../src/speech-device.js');
  const device = { navigator: { userAgent: 'iOS 18', platform: 'iPhone', hardwareConcurrency: 6, maxTouchPoints: 5 }, screen: { width: 393, height: 852 }, pixelRatio: 3 };
  const identity = speechDeviceIdentity(device);
  assert.equal(identity, speechDeviceIdentity({ ...device, screen: { width: 852, height: 393 } }));
  assert.notEqual(identity, speechDeviceIdentity({ ...device, navigator: { ...device.navigator, userAgent: 'iOS 19' } }));
  assert.notEqual(identity, speechDeviceIdentity({ ...device, screen: { width: 440, height: 956 } }));
});


test('Mini migration reclaims only retired speech weights and resumes interrupted cleanup', async () => {
  const { ensembleModels, fluidSpeechMini } = await import('@pageborne/browser-stt');
  const { nativeModelCache } = await import('@pageborne/browser-stt/ensemble-cache');
  const values = new Map([['library', 'original'], ['reading-history', 'keep']]);
  const kv = { get: async key => values.get(key), set: async (key, value) => values.set(key, value) };
  const cache = nativeModelCache(kv);
  const old = ensembleModels[0].files.find(f => f.text === undefined).sha256;
  const current = fluidSpeechMini.files[0].sha256;
  await cache.put(old, new Response(new Uint8Array(75000).fill(7)));
  await cache.put(current, new Response('current model'));
  await cache.put('verification:fluid-mini', new Response('current check'));
  await cache.put('verification:conformer', new Response('old check'));
  const prefix = 'pageborne:models:v1:';
  values.set(prefix + 'pending:' + old, JSON.stringify({ id: 'abandoned', chunks: 1 }));
  values.set(prefix + 'abandoned:0', 'partial');
  const set = kv.set; let cleared = 0;
  kv.set = async (key, value) => { if (!value && ++cleared === 5) throw Error('Interrupted'); return set(key, value); };
  await assert.rejects(retirePreviousVoiceModels(cache), /Interrupted/);
  kv.set = set;
  await retirePreviousVoiceModels(nativeModelCache(kv));
  await retirePreviousVoiceModels(nativeModelCache(kv));
  assert.equal(await cache.match(old), undefined);
  assert.equal(await cache.match('verification:conformer'), undefined);
  assert.equal(values.get(prefix + 'abandoned:0'), '');
  assert.equal(await (await cache.match(current)).text(), 'current model');
  assert.equal(await (await cache.match('verification:fluid-mini')).text(), 'current check');
  assert.equal(values.get('library'), 'original'); assert.equal(values.get('reading-history'), 'keep');
  assert.equal([...values.values()].filter(Boolean).length, 6, 'only two current cache entries and unrelated data remain');
});
