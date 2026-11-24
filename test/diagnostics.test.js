import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeLane, Diagnostics, errorDetails, VERSION } from '../src/diagnostics.js';
import { debugReport } from '../src/debug-export.js';
import { installDiagnosticCheckpoint } from '../src/diagnostic-checkpoint.js';
import { AtomicPhoneValue, bridgeStorage } from '../src/phone-storage.js';

test('crash checkpoints survive a fresh browser origin and coalesce while phone storage is busy', async () => {
  const info = console.info; console.info = () => {};
  const tick = () => new Promise(resolve => setTimeout(resolve, 10));
  try {
    const phone = new Map(); let unblock, writes = 0;
    const diagnostics = new Diagnostics();
    const kv = { get: async key => phone.get(key) || '', set: async (key, value) => {
      if (++writes === 1) await new Promise(resolve => { unblock = resolve; });
      phone.set(key, value); diagnostics.log('bridge-ok', { name: 'storage-write' });
    } };
    installDiagnosticCheckpoint(diagnostics, new AtomicPhoneValue(kv, 'diagnostics'), { delay: 0 });
    diagnostics.speech = { refine: { state: 'loading', phase: 'downloading' } }; diagnostics.log('speech-model-state');
    await tick(); assert.equal(writes, 1);
    for (let i = 0; i < 100; i++) { diagnostics.ask = { state: 'answer', answerCharacters: i }; diagnostics.log('display-frame'); }
    await tick(); assert.equal(writes, 1, 'only one durable write in flight');
    unblock(); await tick(); await tick();
    const saved = await new AtomicPhoneValue(kv, 'diagnostics').read();
    const fresh = new Diagnostics({ getItem: () => null, setItem() {} }); fresh.restore(saved);
    assert.equal(fresh.summary().previousRun.ask.answerCharacters, 99);
    assert.equal(fresh.summary().previousRun.speech.refine.phase, 'downloading');
    const done = writes; await tick(); assert.equal(writes, done, 'storage logging never schedules itself'); assert(writes < 10);
    diagnostics.log('bridge-error', { name: 'storage-write', message: 'Storage full' });
    diagnostics.log('bridge-timeout', { name: 'storage-write' });
    await tick(); assert.equal(writes, done, 'failed checkpoints never recursively retry themselves');
  } finally { console.info = info; }
});

test('restart retains model, conversation and display stages even without a JavaScript error', () => {
  let saved; const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const info = console.info; console.info = () => {};
  try {
    const diagnostics = new Diagnostics(storage);
    diagnostics.ask = { state: 'answer', answerCharacters: 30 };
    diagnostics.speech = { refine: { state: 'loading', phase: 'initializing' } };
    diagnostics.display = { surface: 'text', accepted: true, containers: [{ name: 'body', bytes: 30 }] };
    for (let i = 0; i < 20; i++) diagnostics.log('bridge-ok', { name: 'text-frame' });
    const previous = new Diagnostics(storage).summary().previousRun;
    assert.deepEqual(previous.ask, diagnostics.ask); assert.deepEqual(previous.speech, diagnostics.speech);
    assert.deepEqual(previous.display, diagnostics.display); assert.equal(previous.events.length, 12);
  } finally { console.info = info; }
});

test('release generates no logs or storage traffic while keeping bridge scheduling functional', async () => {
  const calls = []; const storage = { getItem() { calls.push('read'); }, setItem() { calls.push('write'); } };
  const info = console.info; console.info = () => calls.push('console');
  try {
    const diagnostics = new Diagnostics(storage, { enabled: false });
    diagnostics.onError = () => calls.push('backup');
    const sensitive = { get message() { calls.push('serialize-error'); return 'private'; } };
    diagnostics.log('gesture'); diagnostics.error('pdf-error', sensitive);
    diagnostics.restore({ startedAt: 'prior', errors: [{ at: 'prior', error: sensitive }] }); diagnostics.persist();
    assert.deepEqual(diagnostics.summary(), { version: VERSION, enabled: false });
    assert.throws(() => debugReport(diagnostics), /disabled/);
    const lane = new BridgeLane(diagnostics);
    const operations = [];
    await Promise.all(['storage-read', 'text-frame'].map(name => lane.run(name, async () => {
      assert.equal(lane.busy, true); assert.equal(diagnostics.active.name, name); operations.push(name);
    })));
    assert.deepEqual(operations, ['storage-read', 'text-frame']);
    assert.equal(lane.busy, false); assert.equal(diagnostics.active, null);
    assert.deepEqual(diagnostics.events, []); assert.deepEqual(diagnostics.errors, []);
    assert.deepEqual(calls, []);
  } finally { console.info = info; }
});

test('PDF errors retain stacks and processing context after routine events and restarts', () => {
  let saved; const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const info = console.info; console.info = () => {};
  try {
    const diagnostics = new Diagnostics(storage);
    const error = new TypeError('undefined is not a function');
    diagnostics.error('pdf-open-error', error, { stage: 'extracting-text', page: 7, pages: 28, selection: 2 });
    for (let i = 0; i < 200; i++) diagnostics.log('bridge-ok', { name: 'text-frame' });
    assert.equal(diagnostics.events.some(e => e.type === 'pdf-open-error'), false);
    assert.equal(diagnostics.summary().errors[0].error.stack, error.stack);
    const reopened = new Diagnostics(storage);
    assert.deepEqual(reopened.summary().errors[0].context, { stage: 'extracting-text', page: 7, pages: 28, selection: 2 });
    const report = debugReport(reopened);
    assert.match(report.filename, new RegExp(`pageborne-${VERSION}-debug-.*\\.json$`));
    assert.equal(JSON.parse(report.text).errors[0].version, VERSION);
    assert.equal(typeof JSON.parse(report.text).environment.capabilities.iteratorMap, 'string');
    // A fresh WebView can restore the same error from the phone storage backup.
    const cold = new Diagnostics({ getItem: () => null, setItem() {} });
    cold.restore(JSON.parse(saved)); cold.restore(JSON.parse(saved));
    assert.equal(cold.errors.length, 1);
    assert.equal(cold.errors[0].error.message, error.message);
  } finally { console.info = info; }
});

test('error history is bounded, deduplicates retries and tolerates unavailable storage', () => {
  const info = console.info; console.info = () => {};
  try {
    const diagnostics = new Diagnostics({ getItem() { throw new Error('unavailable'); }, setItem() { throw new Error('full'); } });
    let writes = 0; diagnostics.onError = () => { writes++; };
    for (let i = 0; i < 100; i++) diagnostics.error('pdf-render-error', new Error('render failed'), { stage: 'drawing-frame', page: 1 });
    assert.equal(diagnostics.errors.length, 1); assert.equal(writes, 1);
    assert.equal(diagnostics.errors[0].occurrences, 100);
    for (let page = 2; page <= 30; page++) diagnostics.error('pdf-render-error', new Error('render failed'), { page });
    assert.equal(diagnostics.errors.length, 12);
    assert.doesNotThrow(() => JSON.stringify(diagnostics.summary()));
  } finally { console.info = info; }
});

test('error serialization handles primitive failures and bounds recursive causes and stacks', () => {
  assert.equal(errorDetails(undefined).message, 'Unknown error');
  assert.equal(errorDetails('worker failed').message, 'worker failed');
  const error = new Error('x'.repeat(10000)); error.stack = 's'.repeat(20000); error.cause = error;
  const serialized = errorDetails(error);
  assert.equal(serialized.message.length, 2000); assert.equal(serialized.stack.length, 12000);
  assert.equal(serialized.cause, undefined);
});

test('bulk model bridge calls retain timeout/error handling without per-chunk log writes', async () => {
  const events = [], diagnostics = { log: (...args) => events.push(args) };
  const lane = new BridgeLane(diagnostics);
  assert.equal(await lane.run('storage-write', async () => true, { quiet: true }), true);
  assert.deepEqual(events, []); assert.equal(diagnostics.active, null);
  await assert.rejects(lane.run('storage-read', async () => { throw Error('storage unavailable'); }, { quiet: true }), /storage unavailable/);
  assert.equal(events[0][0], 'bridge-error'); assert.equal(lane.busy, false);
});

test('bulk preference traffic is summarized without erasing speech events or hiding storage failures', async () => {
  const info = console.info; console.info = () => {};
  try {
    let persisted = 0, reject = false;
    const diagnostics = new Diagnostics({ getItem: () => null, setItem: () => { persisted++; } });
    diagnostics.log('voice-startup', { stage: 'first-word', ms: 120 });
    const values = new Map(), lane = new BridgeLane(diagnostics);
    const kv = bridgeStorage({ getLocalStorage: async key => values.get(key) || '', setLocalStorage: async (key, value) => {
      if (reject) return false; values.set(key, value); return true;
    } }, lane);
    const before = persisted, value = { answer: 'private words '.repeat(55000) }, atomic = new AtomicPhoneValue(kv, 'preferences');
    await atomic.write(value);
    const traffic = diagnostics.summary().storageTraffic.preferences;
    assert.equal(traffic.writes, values.size);
    assert.equal(traffic.writtenCharacters, [...values.values()].reduce((n, value) => n + value.length, 0));
    assert.equal(persisted - before, 2, 'only the commit head emits success events');
    assert(diagnostics.events.some(e => e.type === 'voice-startup'));
    assert.deepEqual(await new AtomicPhoneValue(kv, 'preferences').read(), value);
    assert.equal(diagnostics.summary().storageTraffic.preferences.reads, values.size);
    reject = true; await assert.rejects(atomic.write({ answer: 'new words' }), { code: 'phone-storage-write' });
    assert.equal(diagnostics.summary().storageTraffic.preferences.errors, 1);
    assert(diagnostics.events.some(e => e.type === 'bridge-error' && e.area === 'preferences'));
    let release;
    const pending = new BridgeLane(diagnostics, 10).run('storage-write', () => new Promise(resolve => { release = resolve; }),
      { quiet: true, context: { area: 'preferences', characters: 2 } });
    await assert.rejects(pending, { code: 'bridge-timeout' }); release(true);
    assert.equal(diagnostics.summary().storageTraffic.preferences.timeouts, 1);
    assert(diagnostics.events.some(e => e.type === 'bridge-timeout'));
    assert.doesNotMatch(JSON.stringify(diagnostics.summary()), /private words|new words|even-reader:phone/);
    assert.equal(kv.health.write, 'rejected');
  } finally { console.info = info; }
});

test('an unfinished setup survives repeated fresh-origin reopens and an interrupted guard', () => {
  const info = console.info; console.info = () => {};
  try {
    const firstRun = '2026-10-14T01:33:15.606Z';
    const setup = { stage: 'loading', file: 'onnx/encoder_model.onnx', component: 'encoder',
      fileLoadedBytes: 33096000, fileBytes: 80818781, startedAt: 1791941605417, lastProgressAt: 1791941606325 };
    let saved = { version: '0.8.69', startedAt: '2026-10-14T01:33:44.788Z', speech: { models: { moonshine: { state: 'error' } } },
      previousRun: { version: '0.8.69', startedAt: firstRun, speech: { models: { moonshine: { state: 'loading', setup } } },
        events: [{ at: '2026-10-14T01:33:26.325Z', type: 'speech-model-state', models: { moonshine: { state: 'loading', setup } } }] } };
    for (let run = 0; run < 6; run++) {
      const fresh = new Diagnostics({ getItem: () => null, setItem() {} });
      fresh.restore(saved); fresh.restore(saved);
      fresh.speech = { models: { moonshine: { state: 'error', setup: { stage: 'runtime', loadedBytes: 0 } } } };
      for (let i = 0; i < 150; i++) fresh.log('bridge-ok', { name: 'storage-read' });
      saved = JSON.parse(debugReport(fresh).text);
      assert.equal(saved.unfinishedSetups.length, 1);
      const attempt = saved.unfinishedSetups[0];
      assert.equal(attempt.runStartedAt, firstRun); assert.equal(attempt.setup.fileLoadedBytes, 33096000);
      assert.equal(attempt.events[0].file, 'onnx/encoder_model.onnx'); assert(!attempt.resolvedAt);
    }
    const fixed = new Diagnostics({ getItem: () => JSON.stringify(saved), setItem() {} });
    fixed.speech = { models: { moonshine: { state: 'ready' } } }; fixed.log('speech-model-state', fixed.speech);
    assert(fixed.unfinishedSetups[0].resolvedAt, 'successful preparation clears the recovery pause');
    assert.equal(fixed.unfinishedSetups[0].setup.fileLoadedBytes, 33096000, 'success retains the earlier evidence');
  } finally { console.info = info; }
});

test('unfinished setup history is bounded and contains model metadata only', () => {
  const info = console.info; console.info = () => {};
  try {
    const diagnostics = new Diagnostics({ getItem: () => null, setItem() {} });
    for (let i = 0; i < 10; i++) {
      const setup = { stage: 'loading', startedAt: i + 1, file: 'model.onnx', fileLoadedBytes: i, transcript: 'PRIVATE WORDS' };
      diagnostics.restore({ startedAt: `2020-01-01T00:00:0${i}Z`, speech: { models: { moonshine: { state: 'loading', setup } } },
        events: Array.from({ length: 100 }, (_, j) => ({ type: 'speech-model-state', at: String(j), models: { moonshine: { state: 'loading', setup } }, audio: 'PRIVATE AUDIO' })) });
    }
    assert.equal(diagnostics.unfinishedSetups.length, 4);
    assert(diagnostics.unfinishedSetups.every(entry => entry.events.length === 16));
    assert(!JSON.stringify(diagnostics.unfinishedSetups).includes('PRIVATE'));
  } finally { console.info = info; }
});

test('startup flush preserves recovered evidence before new model work and serializes with a pending checkpoint', async () => {
  const info = console.info; console.info = () => {};
  try {
    const diagnostics = new Diagnostics(); let unblock, active = 0, maximum = 0, saved;
    const schedule = installDiagnosticCheckpoint(diagnostics, { async write(value) {
      maximum = Math.max(maximum, ++active);
      if (!unblock) await new Promise(resolve => { unblock = resolve; });
      saved = value; active--;
    } }, { delay: 0 });
    schedule(); await new Promise(resolve => setTimeout(resolve, 10));
    diagnostics.restore({ startedAt: '2020-01-01', speech: { models: { moonshine: { state: 'loading', setup: { fileLoadedBytes: 33096000 } } } } });
    const flush = diagnostics.flushCheckpoint(); unblock(); await flush;
    assert.equal(maximum, 1); assert.equal(saved.unfinishedSetups[0].setup.fileLoadedBytes, 33096000);
  } finally { console.info = info; }
});

test('checkpoint serialization failure cannot prevent startup or a later successful save', async () => {
  let broken = true, saved;
  const diagnostics = { errors: [], summary() { if (broken) throw Error('cannot serialize'); return { ok: true }; } };
  installDiagnosticCheckpoint(diagnostics, { async write(value) { saved = value; } });
  await diagnostics.flushCheckpoint(); assert.equal(saved, undefined);
  broken = false; await diagnostics.flushCheckpoint(); assert.deepEqual(saved, { ok: true });
});
