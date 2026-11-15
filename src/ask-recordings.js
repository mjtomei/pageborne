import { EvenTerminal } from './ask-terminal.js';
import { safeTimeout, cancelTimeout } from './timers.js';

const CHUNK = 256000, MAX_AUDIO = 19200000, MAX_QUEUED = 8 * 1024 * 1024;
const base64 = bytes => {
  let text = ''; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
};
// Collection has its own bounded memory queue. It never uses Even storage,
// blocks recognition, changes microphone limits, or submits an Ask question.
export class AskRecordings {
  constructor({ options = () => ({}), changed = () => {}, appVersion = '', sttVersion = '', now = () => Date.now() } = {}) {
    Object.assign(this, { options, changed, appVersion, sttVersion, now });
    this.jobs = []; this.queuedBytes = 0; this.enabled = false; this.status = 'off';
  }
  configure(config) {
    const identity = JSON.stringify([config.mode, config.endpoint, config.token]);
    if (identity === this.identity) return;
    this.identity = identity; this.enabled = false; this.client = null; this.incomplete = false;
    this.cancel(); this.jobs = []; this.queuedBytes = 0; cancelTimeout(this.retryTimer); this.retryTimer = null;
    if (config.mode !== 'terminal' || !config.endpoint || !config.token) { this.status = 'off'; this.changed(); return; }
    let client; try { client = new EvenTerminal(config, this.options()); } catch { this.status = 'unavailable'; this.identity = null; this.changed(); return; }
    this.ready = client.serverInfo().then(info => {
      if (this.identity !== identity) return;
      this.enabled = info.pageborne?.speechRecordings === 1; this.client = this.enabled ? client : null;
      this.status = this.enabled ? 'ready' : 'off'; this.changed();
    }).catch(() => { if (this.identity === identity) { this.status = 'unavailable'; this.identity = null; this.changed(); } });
  }
  start({ source, backend, document, reproduction }) {
    this.cancel(); if (!this.enabled || !this.client) return null;
    const recording = { id: crypto.randomUUID(), client: this.client, revision: 0, parts: 0, bytes: 0, lost: 0,
      buffer: new Uint8Array(CHUNK), buffered: 0, metadata: { appVersion: this.appVersion, sttVersion: this.sttVersion,
        source, backend, startedAt: new Date(this.now()).toISOString(), document, outcome: 'recording',
        reproduction: { ...reproduction, mode: 'single-recording', dictionaries: [], decodes: [] } } };
    this.current = recording; this.status = 'recording'; this.changed(); return recording;
  }
  receive(bytes, r = this.current) {
    if (!r?.buffer || !(bytes instanceof Uint8Array)) return;
    const length = bytes.length - bytes.length % 2;
    let at = 0;
    while (at < length) {
      if (r.bytes >= MAX_AUDIO || r.lost) { r.lost += length - at; break; }
      const count = Math.min(length - at, CHUNK - r.buffered, MAX_AUDIO - r.bytes);
      r.buffer.set(bytes.subarray(at, at + count), r.buffered); r.buffered += count; r.bytes += count; at += count;
      if (r.buffered === CHUNK) this.flush(r);
    }
  }
  flush(r) {
    if (!r.buffered) return;
    const pcm = r.buffer.slice(0, r.buffered); r.buffered = 0;
    if (this.queuedBytes + pcm.byteLength > MAX_QUEUED) { r.lost += pcm.byteLength; return; }
    const index = r.parts++;
    this.enqueue({ recording: r, route: `pageborne/speech-recordings/${r.id}/chunks/${index}`, pcm, bytes: pcm.byteLength });
  }
  stop(r = this.current, expectedBytes) {
    if (!r || r.metadata.capture) return r;
    if (Number.isFinite(expectedBytes) && expectedBytes !== r.bytes && !r.lost) r.lost = Math.abs(expectedBytes - r.bytes);
    this.flush(r); r.buffer = null;
    if (r.lost) this.incomplete = true;
    r.metadata.capture = { endedAt: new Date(this.now()).toISOString(), bytes: r.bytes, parts: r.parts, droppedBytes: r.lost, complete: r.lost === 0 };
    r.metadata.outcome = 'recognizing'; this.update(r); return r;
  }
  recognition(r, response, formatted, hypotheses = []) {
    if (!r) return;
    // Model outputs are predictions, not human or desktop reference labels.
    const prediction = value => {
      if (!value) return undefined;
      const result = {};
      for (const key of ['text', 'words', 'models', 'model', 'backend', 'seconds', 'transcribeMs', 'loadMs', 'unavailableModels', 'partial']) {
        if (value[key] != null) result[key] = value[key];
      }
      if (result.text) result.text = String(result.text).slice(0, 64000);
      if (Array.isArray(result.words)) result.words = result.words.slice(0, 8000);
      return result;
    };
    r.metadata.recognition = prediction(response); r.metadata.formattedText = String(formatted || '').slice(0, 64000);
    r.metadata.hypotheses = hypotheses.slice(0, 3).map(({ id, ...value }) => ({ id, ...prediction(value) }));
    // Word-level detail can be large on long dictations. Preserve all text;
    // omit confidence arrays before exceeding the metadata transfer budget.
    if (JSON.stringify(r.metadata).length > 120000) {
      delete r.metadata.recognition?.words;
      for (const h of r.metadata.hypotheses) delete h.words;
    }
    if (!['sent', 'discarded'].includes(r.metadata.outcome)) r.metadata.outcome = 'review';
    this.update(r);
  }
  sent(r, text, turnId, sessionId) {
    if (!r) return;
    this.stop(r); r.metadata.sentText = String(text).slice(0, 64000); r.metadata.turnId = turnId;
    if (sessionId) r.metadata.sessionId = sessionId;
    r.metadata.outcome = 'sent'; this.update(r); if (this.current === r) this.current = null;
  }
  cancel(r = this.current) {
    if (!r || r.metadata.outcome === 'sent') return;
    this.stop(r); r.metadata.outcome = 'discarded'; this.update(r); if (this.current === r) this.current = null;
  }
  failed(r) { if (r && !['sent', 'discarded'].includes(r.metadata.outcome)) { this.stop(r); r.metadata.outcome = 'recognition-error'; this.update(r); } }
  hints(r, vocabulary, filenames) {
    if (!r) return;
    r.metadata.vocabulary = structuredClone(vocabulary); r.metadata.filenames = structuredClone(filenames);
  }
  decode(r, id, audio, options, window) {
    if (!r) return () => {};
    const reproduction = r.metadata.reproduction;
    if (reproduction.decodes.length >= 512) { reproduction.truncated = true; return () => {}; }
    const vocabulary = structuredClone(options.vocabulary || []);
    let dictionary = reproduction.dictionaries.findIndex(d => JSON.stringify(d) === JSON.stringify(vocabulary));
    if (dictionary < 0) { dictionary = reproduction.dictionaries.length; reproduction.dictionaries.push(vocabulary); }
    const pass = { model: id, startedAt: new Date(this.now()).toISOString(), inputBytes: audio.size, dictionary,
      options: { partial: options.partial, chunkSeconds: options.chunkSeconds, confidence: structuredClone(options.confidence) }, window };
    reproduction.decodes.push(pass);
    return (response, error) => {
      pass.endedAt = new Date(this.now()).toISOString(); pass.outcome = error ? error.name === 'AbortError' ? 'cancelled' : 'error' : 'complete';
      if (response) { pass.transcribeMs = response.transcribeMs; pass.outputText = String(response.text || '').slice(0, 8000); }
      if (r.metadata.capture) this.update(r);
    };
  }
  update(r) {
    const body = { revision: ++r.revision, metadata: structuredClone(r.metadata) };
    const size = () => new TextEncoder().encode(JSON.stringify(body)).length;
    let bytes = size();
    if (bytes > 900000) {
      // Long overlapping passes can repeat the same text many times. Keep
      // the audio receipt and decoding inputs before intermediate outputs.
      body.metadata.reproduction.truncated = true;
      for (const pass of body.metadata.reproduction.decodes) delete pass.outputText;
      delete body.metadata.recognition?.words;
      for (const h of body.metadata.hypotheses || []) delete h.words;
      bytes = size();
    }
    if (bytes > 950000) {
      body.metadata.reproduction.decodes = [];
      body.metadata.reproduction.dictionaries = [];
      delete body.metadata.vocabulary; delete body.metadata.filenames;
      bytes = size();
    }
    if (bytes > 950000) { this.incomplete = true; this.status = 'incomplete'; this.changed(); return; }
    const prior = this.jobs.find(j => j.recording === r && j.body && j !== this.inflight);
    if (this.queuedBytes + bytes - (prior?.bytes || 0) > MAX_QUEUED || this.jobs.length >= 120) { this.incomplete = true; this.status = 'incomplete'; this.changed(); return; }
    if (prior) { this.queuedBytes += bytes - prior.bytes; prior.body = body; prior.bytes = bytes; return; }
    this.enqueue({ recording: r, route: `pageborne/speech-recordings/${r.id}`, body, bytes });
  }
  enqueue(job) {
    job.createdAt = this.now(); job.attempts = 0; this.jobs.push(job); this.queuedBytes += job.bytes; void this.drain();
  }
  async drain() {
    if (this.inflight || this.retryTimer) return;
    const job = this.jobs[0]; if (!job) return;
    this.inflight = job;
    try {
      await job.recording.client.api(job.route, { body: job.body || { pcm: base64(job.pcm) }, timeoutMs: 15000 });
      if (this.jobs[0] !== job) return;
      this.jobs.shift(); this.queuedBytes -= job.bytes;
      this.status = this.incomplete ? 'incomplete' : this.jobs.length ? 'uploading' : this.current?.buffer ? 'recording' : 'saved';
    } catch (error) {
      if (this.jobs[0] !== job) return;
      if ([400, 401, 403, 404, 409, 413, 507].includes(error.status) || this.now() - job.createdAt > 10 * 60 * 1000) {
        this.incomplete = true;
        this.jobs.shift(); this.queuedBytes -= job.bytes;
        if (job.pcm) job.recording.lost += job.bytes;
        if (job.recording.metadata.capture && job.pcm) {
          job.recording.metadata.capture.complete = false; job.recording.metadata.capture.droppedBytes = job.recording.lost;
          this.update(job.recording);
        }
        this.status = 'incomplete';
      } else {
        this.status = 'retrying';
        this.retryTimer = safeTimeout(() => { this.retryTimer = null; void this.drain(); }, Math.min(30000, 1000 * 2 ** Math.min(++job.attempts, 5)));
      }
    } finally {
      this.inflight = null; this.changed();
      if (!this.retryTimer && this.jobs.length) void this.drain();
    }
  }
}
