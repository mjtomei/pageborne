import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AskRecordings } from '../src/ask-recordings.js';
import { createSpeechRecordingStore } from '../integrations/even-terminal/pageborne-speech-recordings.js';

const config = { mode: 'terminal', endpoint: 'https://recordings.test', agent: 'claude', token: 'fixture' };
const wait = async archive => {
  for (let i = 0; i < 1000 && (archive.jobs.length || archive.inflight); i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(archive.jobs.length, 0); assert.equal(archive.inflight, null);
};
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pb-recording-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = createSpeechRecordingStore({ enabled: true, root, reserveBytes: 0, ...options });
  const requests = [];
  const archive = new AskRecordings({ appVersion: 'test-version', sttVersion: 'pinned-source-revision', options: () => ({ fetcher: async (url, init) => {
    const p = new URL(url).pathname;
    assert.equal(init.headers.Authorization, 'Bearer fixture');
    if (p.endsWith('/info')) return Response.json({ pageborne: { speechRecordings: 1 } });
    const [id, kind, index] = p.split('/').slice(4); const body = JSON.parse(init.body); requests.push({ id, kind, index, body });
    try { return Response.json(kind === 'chunks' ? await store.chunk(id, index, body) : await store.metadata(id, body)); }
    catch (e) { return Response.json({ error: e.message }, { status: e.status || 500 }); }
  } }) });
  archive.configure(config); await archive.ready; return { root, store, archive, requests };
}
test('one WAV per spoken input with pinned models, dispatch dictionaries, hypotheses, and sent text; no gold label', async t => {
  const { root, store, archive } = await fixture(t);
  const r = archive.start({ source: 'glasses', backend: 'wasm', reproduction: { models: [{ id: 'conformer', files: [{ sha256: 'pinned-hash' }] }] } });
  const pcm = new Uint8Array(300000).map((_, i) => i % 255); archive.receive(pcm);
  const dictionary = ['Licklider', 'Taylor']; archive.hints(r, dictionary, ['handoff.md']);
  const finished = archive.decode(r, 'conformer', new Blob([pcm]), { vocabulary: dictionary, partial: false, chunkSeconds: 20 }, { offset: 0, length: pcm.length });
  dictionary.push('later mutation'); finished({ text: 'phone prediction', transcribeMs: 400 });
  archive.stop(r, pcm.length); archive.recognition(r, { text: 'phone prediction', models: ['conformer'] }, 'phone prediction', [{ id: 'conformer', text: 'phone prediction' }]);
  archive.sent(r, 'possibly edited text', 'turn-1', 'session-1'); await wait(archive);
  const folder = path.join(root, r.id), wav = await readFile(path.join(folder, 'audio.wav'));
  assert.deepEqual([...await readdir(folder)].sort(), ['audio.wav', 'record.json']);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
  assert.deepEqual(wav.subarray(44), Buffer.from(pcm));
  const record = JSON.parse(await readFile(path.join(folder, 'record.json')));
  assert.equal(record.reference, null); assert.equal(record.metadata.recognition.text, 'phone prediction');
  assert.equal(record.metadata.sentText, 'possibly edited text'); assert.equal(record.metadata.sttVersion, 'pinned-source-revision');
  assert.deepEqual(record.metadata.vocabulary, ['Licklider', 'Taylor']);
  assert.deepEqual(record.metadata.reproduction.dictionaries, [['Licklider', 'Taylor']]);
  assert.equal(record.metadata.reproduction.decodes[0].outputText, 'phone prediction');
  assert.equal(record.metadata.reproduction.models[0].files[0].sha256, 'pinned-hash');
  await store.chunk(r.id, '0', { pcm: Buffer.from(pcm.subarray(0, 256000)).toString('base64') });
  assert.deepEqual([...await readdir(folder)].sort(), ['audio.wav', 'record.json'], 'idempotent retries do not recreate duplicate audio');
  await assert.rejects(store.chunk(r.id, '0', { pcm: Buffer.alloc(256000).toString('base64') }), e => e.status === 409);
});
test('out-of-order parts survive restart and assemble only when all expected audio arrives', async t => {
  const { root, store } = await fixture(t); const id = randomUUID();
  const metadata = { source: 'phone', startedAt: new Date().toISOString(), capture: { endedAt: new Date().toISOString(), bytes: 6, parts: 2, complete: true } };
  await store.metadata(id, { revision: 1, metadata });
  await store.chunk(id, '1', { pcm: Buffer.from([3, 4]).toString('base64') });
  assert(!(await readdir(path.join(root, id))).includes('audio.wav'));
  const restarted = createSpeechRecordingStore({ enabled: true, root, reserveBytes: 0 });
  await restarted.chunk(id, '0', { pcm: Buffer.from([1, 2, 1, 2]).toString('base64') });
  assert.deepEqual((await readFile(path.join(root, id, 'audio.wav'))).subarray(44), Buffer.from([1, 2, 1, 2, 3, 4]));
  await restarted.metadata(id, { revision: 2, metadata: { ...metadata, sentText: 'later text' } });
  await restarted.metadata(id, { revision: 1, metadata });
  assert.equal(JSON.parse(await readFile(path.join(root, id, 'record.json'))).metadata.sentText, 'later text');
});
test('disabled, unsafe, malformed, linked, and over-quota writes are rejected', async t => {
  const { root, store } = await fixture(t, { maxBytes: 8 }); const id = randomUUID();
  await assert.rejects(createSpeechRecordingStore({ enabled: false, root }).chunk(id, '0', {}), e => e.status === 404);
  await assert.rejects(store.chunk('../outside', '0', {}), e => e.status === 400);
  await assert.rejects(store.chunk(id, '75', {}), e => e.status === 400);
  await assert.rejects(store.chunk(id, '0', { pcm: 'AQ==' }), e => e.status === 400);
  await assert.rejects(store.chunk(id, '0', { pcm: Buffer.alloc(32).toString('base64') }), e => e.status === 507);
  const linked = randomUUID(); await symlink(tmpdir(), path.join(root, linked));
  await assert.rejects(store.chunk(linked, '0', { pcm: 'AAAA' }), e => e.status === 400);
});
test('collection is opt-in and missing audio is never labelled complete', async t => {
  const { root, archive } = await fixture(t);
  const r = archive.start({ source: 'phone', backend: 'wasm' }); archive.receive(new Uint8Array(3200)); archive.stop(r, 6400); await wait(archive);
  const record = JSON.parse(await readFile(path.join(root, r.id, 'record.json')));
  assert.equal(record.metadata.capture.complete, false); assert.equal(record.audio, undefined);
  assert.equal(archive.status, 'incomplete');
  const off = new AskRecordings({ options: () => ({ fetcher: async () => Response.json({ pageborne: {} }) }) });
  off.configure(config); await off.ready; assert.equal(off.start({ source: 'phone' }), null); off.receive(new Uint8Array(3200)); assert.equal(off.jobs.length, 0);
});
test('in-memory upload queue stays bounded and a stalled upload does not block capture', async t => {
  const { archive } = await fixture(t); let release;
  archive.client.api = () => new Promise(resolve => { release = resolve; });
  const r = archive.start({ source: 'phone', backend: 'wasm' });
  for (let i = 0; i < 40; i++) archive.receive(new Uint8Array(256000));
  archive.stop(r); assert(archive.queuedBytes <= 8 * 1024 * 1024); assert(r.lost > 0); assert.equal(r.metadata.capture.complete, false);
  archive.jobs = []; archive.queuedBytes = 0; release({ ok: true });
});
test('long overlapping predictions lose intermediate text before losing the single audio receipt', async t => {
  const { root, archive } = await fixture(t);
  const r = archive.start({ source: 'phone', backend: 'wasm' }); archive.receive(new Uint8Array(3200));
  for (let i = 0; i < 150; i++) archive.decode(r, 'conformer', new Blob(), { vocabulary: ['Licklider'] }, { offset: i * 100 })( { text: 'x'.repeat(8000) });
  archive.stop(r, 3200); archive.sent(r, 'final prediction', 'turn-1'); await wait(archive);
  const record = JSON.parse(await readFile(path.join(root, r.id, 'record.json')));
  assert.equal(record.audio.bytes, 3200); assert.equal(record.metadata.sentText, 'final prediction');
  assert.equal(record.metadata.reproduction.truncated, true);
  assert.deepEqual(record.metadata.reproduction.dictionaries, [['Licklider']]);
  assert.equal(record.metadata.reproduction.decodes.length, 150);
  assert.equal(record.metadata.reproduction.decodes[0].outputText, undefined);
});
test('failed audio upload is marked incomplete even after its metadata saves', async t => {
  const { root, archive } = await fixture(t); const api = archive.client.api.bind(archive.client);
  archive.client.api = (route, options) => route.includes('/chunks/') ? Promise.reject(Object.assign(new Error('quota'), { status: 507 })) : api(route, options);
  const r = archive.start({ source: 'phone' }); archive.receive(new Uint8Array(3200)); archive.stop(r, 3200); await wait(archive);
  const record = JSON.parse(await readFile(path.join(root, r.id, 'record.json')));
  assert.equal(record.metadata.capture.complete, false); assert.equal(record.audio, undefined);
  assert.equal(archive.status, 'incomplete');
});
