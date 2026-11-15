import { readFileSync } from 'node:fs';
import { mkdir, lstat, readdir, readFile, writeFile, rename, open, statfs, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';

const CHUNK_BYTES = 256000, MAX_AUDIO_BYTES = 19200000, METADATA_BYTES = 1000000;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function speechRecordingConfig() {
  let config = {};
  try { if (process.env.EVEN_TERMINAL_STATE_DIR) config = JSON.parse(readFileSync(path.join(process.env.EVEN_TERMINAL_STATE_DIR, 'pageborne-speech.json'), 'utf8')); }
  catch { /* Disabled when no valid desktop opt-in exists. */ }
  return { enabled: config.recordings === true, root: path.join(homedir(), '.pageborne', 'speech-recordings'), maxBytes: 10 * 1024 ** 3 };
}
export const speechRecordingCapabilities = () => speechRecordingConfig().enabled ? { speechRecordings: 1 } : {};
function waveHeader(bytes) {
  const b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
async function regular(file, limit) {
  const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit) fail('Invalid recording file.');
  return readFile(file);
}
export function createSpeechRecordingStore(options = {}) {
  const config = { ...speechRecordingConfig(), ...options }; let queue = Promise.resolve(), used;
  async function directory(folder) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const s = await lstat(folder); if (!s.isDirectory() || s.isSymbolicLink()) fail('Invalid recording directory.');
  }
  async function scan(folder) {
    let bytes = 0;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name), s = await lstat(file);
      if (s.isSymbolicLink() || s.nlink > 1 && s.isFile()) fail('Invalid recording file.');
      if (s.isDirectory()) bytes += await scan(file); else if (s.isFile()) bytes += s.size;
    }
    return bytes;
  }
  async function room(bytes) {
    used ??= await scan(config.root);
    const space = await statfs(config.root);
    if (used + bytes > config.maxBytes || Number(space.bavail) * Number(space.bsize) < bytes + (config.reserveBytes ?? 1024 ** 3)) fail('Recording storage limit reached.', 507);
  }
  async function save(file, data) {
    let prior = 0; try { prior = (await regular(file, MAX_AUDIO_BYTES + METADATA_BYTES)).length; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await room(data.length); const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { flag: 'wx', mode: 0o600 }); await rename(temp, file); used += data.length - prior;
    } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  function run(id, task) {
    if (!config.enabled) return Promise.reject(Object.assign(new Error('Recording collection is disabled.'), { status: 404 }));
    if (!uuid(id)) return Promise.reject(Object.assign(new Error('Invalid recording ID.'), { status: 400 }));
    const next = queue.catch(() => {}).then(async () => {
      await directory(config.root); const folder = path.join(config.root, id); await directory(folder);
      return task(folder);
    }); queue = next; return next;
  }
  async function state(folder) {
    try { return JSON.parse(await regular(path.join(folder, 'record.json'), METADATA_BYTES + 50000)); }
    catch (e) { if (e.code !== 'ENOENT') throw e; return { version: 1, id: path.basename(folder), revision: -1, chunks: {}, reference: null }; }
  }
  async function finish(folder, record) {
    const capture = record.metadata?.capture;
    if (!capture?.endedAt || !capture.complete || record.audio || !Number.isInteger(capture.parts) || capture.parts < 1 || capture.parts > 75) return;
    const chunks = Array.from({ length: capture.parts }, (_, i) => record.chunks[i]);
    if (chunks.some(c => !c)) return;
    const bytes = chunks.reduce((n, c) => n + c.bytes, 0);
    if (bytes !== capture.bytes || bytes > MAX_AUDIO_BYTES) fail('Recording length mismatch.');
    const target = path.join(folder, 'audio.wav');
    // Recover a crash between committing WAV bytes and its JSON receipt.
    try {
      const prior = await regular(target, MAX_AUDIO_BYTES + 44);
      if (!prior.subarray(0, 44).equals(waveHeader(bytes)) || prior.length !== bytes + 44) fail('Recording output conflict.', 409);
      let at = 44;
      for (const chunk of chunks) { if (hash(prior.subarray(at, at + chunk.bytes)) !== chunk.sha256) fail('Recording output conflict.', 409); at += chunk.bytes; }
      record.audio = { file: 'audio.wav', bytes, sampleRate: 16000, channels: 1, bits: 16, seconds: bytes / 32000, pcmSha256: hash(prior.subarray(44)) }; return;
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await room(bytes + 44); const temp = path.join(folder, `audio.${randomUUID()}.tmp`);
    const digest = createHash('sha256');
    try {
      const out = await open(temp, 'wx', 0o600);
      try {
        await out.writeFile(waveHeader(bytes));
        for (let i = 0; i < chunks.length; i++) {
          const pcm = await regular(path.join(folder, `${i}.pcm`), CHUNK_BYTES);
          if (hash(pcm) !== chunks[i].sha256) fail('Recording checksum mismatch.');
          digest.update(pcm); await out.writeFile(pcm);
        }
      } finally { await out.close(); }
      try { await lstat(target); fail('Recording output already exists.', 409); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(temp, target); used += bytes + 44;
    } finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
    record.audio = { file: 'audio.wav', bytes, sampleRate: 16000, channels: 1, bits: 16, seconds: bytes / 32000, pcmSha256: digest.digest('hex') };
  }
  async function commit(folder, record) {
    await save(path.join(folder, 'record.json'), Buffer.from(JSON.stringify(record)));
    if (record.audio) for (const [index, chunk] of Object.entries(record.chunks)) {
      try { await unlink(path.join(folder, `${index}.pcm`)); used -= chunk.bytes; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  return {
    enabled: config.enabled,
    chunk(id, index, input) {
      return run(id, async folder => {
        if (!/^\d{1,2}$/.test(index) || Number(index) >= 75 || String(Number(index)) !== String(index)) fail('Invalid audio part.');
        if (typeof input?.pcm !== 'string' || input.pcm.length > 4 * Math.ceil(CHUNK_BYTES / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.pcm)) fail('Invalid audio part.');
        const pcm = Buffer.from(input.pcm, 'base64');
        if (!pcm.length || pcm.length % 2 || pcm.length > CHUNK_BYTES || pcm.toString('base64') !== input.pcm) fail('Invalid PCM audio.');
        const record = await state(folder), digest = hash(pcm), old = record.chunks[index];
        if (old && (old.sha256 !== digest || old.bytes !== pcm.length)) fail('Audio part already contains different bytes.', 409);
        if (!old) { await save(path.join(folder, `${index}.pcm`), pcm); record.chunks[index] = { bytes: pcm.length, sha256: digest }; }
        await finish(folder, record); await commit(folder, record);
        return { ok: true, id, index: Number(index), sha256: digest, complete: !!record.audio };
      });
    },
    metadata(id, input) {
      return run(id, async folder => {
        const metadata = input?.metadata, encoded = JSON.stringify(metadata);
        if (!Number.isSafeInteger(input?.revision) || input.revision < 0 || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
          || Buffer.byteLength(encoded) > METADATA_BYTES || Object.keys(metadata).some(k => !['appVersion', 'sttVersion', 'source', 'backend', 'startedAt', 'capture', 'recognition', 'formattedText', 'sentText', 'outcome', 'hypotheses', 'document', 'sessionId', 'turnId', 'vocabulary', 'filenames', 'reproduction'].includes(k))) fail('Invalid recording metadata.');
        if (!['phone', 'glasses'].includes(metadata.source) || !Number.isFinite(Date.parse(metadata.startedAt))) fail('Invalid recording metadata.');
        if (metadata.capture && (!Number.isInteger(metadata.capture.bytes) || metadata.capture.bytes < 0 || metadata.capture.bytes > MAX_AUDIO_BYTES
          || !Number.isInteger(metadata.capture.parts) || metadata.capture.parts < 0 || metadata.capture.parts > 75 || typeof metadata.capture.complete !== 'boolean')) fail('Invalid recording capture.');
        // Phone predictions and sent text are never reference labels. A future
        // desktop transcriber writes its own versioned reference files.
        const record = await state(folder);
        if (record.audio && metadata.capture?.bytes !== record.audio.bytes) fail('Completed audio length cannot change.', 409);
        if (input.revision < record.revision) return { ok: true, stale: true };
        if (input.revision === record.revision && JSON.stringify(record.metadata) !== encoded) fail('Metadata revision conflict.', 409);
        record.metadata = metadata; record.revision = input.revision;
        await finish(folder, record); await commit(folder, record);
        return { ok: true, id, revision: record.revision, complete: !!record.audio };
      });
    },
  };
}
export function installSpeechRecordings(router, options) {
  const store = createSpeechRecordingStore(options);
  const handle = task => async (req, res) => { try { res.json(await task(req)); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not save the recording.' }); } };
  router.post('/pageborne/speech-recordings/:id/chunks/:index', handle(req => store.chunk(req.params.id, req.params.index, req.body)));
  router.post('/pageborne/speech-recordings/:id', handle(req => store.metadata(req.params.id, req.body)));
}
