import { speechBackend, speechLabel } from './local-speech.js';
import { EnsembleSpeech, EnsembleStream } from '@pageborne/browser-stt';
import { speechDeviceIdentity } from './speech-device.js';
import { deferredSpeechStore } from './speech-storage.js';
import { vocabularyWords } from './speech-vocabulary.js';
import { speechVocabulary, speechFilenames } from './speech-vocabulary-ranking.js';
import { SpeechSetup, modelFileStatus, modelDownloadSummary } from './speech-setup.js';
import { helpPopup } from './help-popups.js';

const $ = id => document.getElementById(id);
export class SpeechUI {
  constructor({ read, save, changed, diagnostics, readVocabulary = () => '', saveVocabulary = () => {}, readContextVocabulary = () => true, saveContextVocabulary = () => {}, vocabularyContext = () => ({}) }) {
    Object.assign(this, { read, save, changed, diagnostics, readVocabulary, readContextVocabulary, vocabularyContext });
    this.storage = deferredSpeechStore();
    this.models = new EnsembleSpeech({ store: this.storage.store, verificationDevice: speechDeviceIdentity(),
      checkpoint: () => this.diagnostics?.flushCheckpoint?.(),
      changed: () => this.renderModels(), failure: (error, backend, model) => this.failure(error, backend, model) });
    this.setup = new SpeechSetup(this.models);
    $('speech-backend').onchange = () => { changed(); save(speechBackend($('speech-backend').value)); this.load(); };
    $('speech-vocabulary').onchange = () => { saveVocabulary(vocabularyWords($('speech-vocabulary').value).join('\n')); this.load(); };
    $('speech-context-vocabulary').onchange = () => saveContextVocabulary($('speech-context-vocabulary').checked);
    this.vocabularyDialog = helpPopup([$('speech-vocabulary-details')], { button: $('speech-vocabulary-show'), title: 'Vocabulary hints' });
    $('speech-vocabulary-show').addEventListener('click', () => this.previewVocabulary());
    $('speech-vocabulary-refresh').onclick = () => this.previewVocabulary();
    $('speech-retry').onclick = () => this.setup.suspended ? this.retrySetup() : this.open({ retry: true });
  }
  get backend() { return speechBackend(this.read()); }
  open({ retry = false } = {}) {
    if (this.setup.suspended) return;
    this.idleGeneration = (this.idleGeneration || 0) + 1;
    this.opened = true;
    if (this.backend !== 'remote' && !this.setup.blocked) void this.models.open({ retry });
  }
  retrySetup() { return this.setup.begin(this.setup.initialize, { retry: true }); }
  async recoverDownloads() {
    const cache = await this.models.store.cache();
    let cleared = 0;
    for (const entry of Object.values(this.models.entries)) {
      for (const key of [`preparation:${entry.model.id}`, `verification:${entry.model.id}`,
        ...entry.model.files.filter(file => file.text === undefined).map(file => file.sha256)]) {
        cleared += await cache.recover?.(key) || 0;
      }
    }
    return cleared;
  }
  transcribe(id, audio, options = {}) {
    // Snapshot the exact normalized array at dispatch, not a later recomputation
    // after the reader has moved. Keep it in memory, outside diagnostic exports.
    const vocabulary = vocabularyWords(options.vocabulary || []);
    this.lastVocabulary = { terms: vocabulary, at: new Date().toLocaleTimeString() };
    if (this.vocabularyDialog.open) this.renderLastVocabulary();
    return this.models.transcribe(id, audio, { ...options, vocabulary });
  }
  setStorage(kv) { this.storage.configure(kv); }
  async releaseForReading() {
    const generation = this.idleGeneration = (this.idleGeneration || 0) + 1;
    // Finish a shared preparation before unloading so its durable interrupted
    // marker is not stranded. A new recording revokes this release.
    await this.models.loading.catch(() => {});
    if (generation === this.idleGeneration) this.models.close();
  }
  stream(options) { return new EnsembleStream({ ...options, models: { entries: this.models.entries,
    prepare: (id, options) => this.models.prepare(id, options), transcribe: (id, audio, options) => this.transcribe(id, audio, options) } }); }
  vocabulary(context, history) { return vocabularyWords(speechVocabulary(this.readVocabulary(), this.readContextVocabulary() !== false ? context : null, history)); }
  filenames(context, history) { return speechFilenames(this.readVocabulary(), this.readContextVocabulary() !== false ? context : null, history); }
  previewVocabulary() {
    const remote = this.backend === 'remote';
    const { context, history } = remote ? {} : this.vocabularyContext();
    const terms = remote ? [] : this.vocabulary(context, history);
    $('speech-vocabulary-source').textContent = remote ? 'Vocabulary hints are only used by on-device speech recognition. None are sent to the speech provider.'
      : context ? `Preview for ${context.title || 'this document'} at your current place. Refresh after moving.` : 'No readable document selected. Showing custom terms only.';
    $('speech-vocabulary-count').textContent = `Next recording · ${terms.length} hint${terms.length === 1 ? '' : 's'}`;
    $('speech-vocabulary-preview').value = terms.join('\n');
    $('speech-vocabulary-preview').placeholder = 'No vocabulary hints.';
    this.renderLastVocabulary();
  }
  renderLastVocabulary() {
    const last = this.lastVocabulary;
    $('speech-vocabulary-last-status').textContent = last ? `${last.terms.length} hint${last.terms.length === 1 ? '' : 's'} sent at ${last.at}. This snapshot lasts until the app closes.` : 'No local transcription in this app session yet.';
    $('speech-vocabulary-last-terms').value = last?.terms.join('\n') || '';
    $('speech-vocabulary-last-terms').placeholder = 'No vocabulary hints.';
  }
  load() {
    $('speech-backend').value = this.backend;
    $('speech-vocabulary').value = this.readVocabulary();
    $('speech-context-vocabulary').checked = this.readContextVocabulary() !== false;
    $('speech-vocabulary').disabled = $('speech-context-vocabulary').disabled = this.backend === 'remote';
    this.renderModels();
  }
  renderModels() {
    if (!this.models) return;
    this.setup?.render();
    const entries = Object.values(this.models.entries);
    if (this.diagnostics?.enabled) {
      const snapshot = { backend: this.backend, ensemble: true,
        storage: { kind: this.models.store.storageKind, ...this.models.store.stats,
          files: [...this.models.store.files.values()].map(({ url, ...file }) => ({ ...file })) },
        models: Object.fromEntries(entries.map(e => [e.model.id, { state: e.state, progress: e.progress.slice(0, 200), downloadBytes: e.downloadBytes, totalBytes: e.totalBytes, setup: { ...e.setup }, verified: e.verified, verification: e.ready?.verification, wasmBytes: e.ready?.wasmBytes }])) };
      this.diagnostics.speech = snapshot;
      const phase = entries.map(e => `${e.state}:${e.setup.stage}:${e.setup.file || ''}:${e.setup.component || ''}:${Math.floor(e.setup.loadedBytes / 8e6)}`).join(',');
      if (phase !== this.loggedModelPhase) { this.loggedModelPhase = phase; this.diagnostics.log('speech-model-state', snapshot); }
      // Byte progress between logged milestones still needs a trailing durable
      // checkpoint if loading stops here. Phone writes are coalesced separately.
      else this.diagnostics.onCheckpoint?.();
    }
    const describe = e => `${e.model.name}: ${e.state === 'ready' ? 'ready' : e.state === 'error' ? e.error.message
      : e.state === 'downloading' ? modelFileStatus(e, this.models.store).text : e.state === 'loading' ? e.progress : e.verified ? 'saved and checked' : 'waiting for setup'}`;
    const text = this.backend === 'remote' ? 'Uses the speech endpoint in connection settings.' : this.setup.suspended
      ? 'Voice is paused after setup failed. Reading and typed Ask remain available. Choose Retry voice to prepare speech again.'
      : entries.map(describe).join(' · ') + '. ' + modelDownloadSummary(this.models.store, entries.every(e => e.verified));
    this.status(text);
    $('speech-retry').hidden = this.backend === 'remote' || !this.setup.suspended && !entries.some(e => e.state === 'error' || e.state === 'idle' && !e.verified);
    $('speech-retry').textContent = this.setup.suspended || entries.some(e => e.state === 'error') ? 'Retry voice' : 'Prepare voice';
    $('ask-voice-models').textContent = text;
  }
  status(text) { $('speech-status').textContent = text; }
  dispose() { this.models.close(); }
  result(result) {
    const { text, words, confidence, ...metrics } = result;
    // Audio and recognized text never enter diagnostic exports.
    this.diagnostics?.log('local-speech', metrics);
    const timing = result.transcribeMs == null ? `loaded in ${(result.loadMs / 1000).toFixed(2)}s`
      : `${result.seconds.toFixed(1)}s audio → ${(result.transcribeMs / 1000).toFixed(2)}s transcription`;
    const label = `${result.unavailableModels?.length ? `${3 - result.unavailableModels.length}/3 recognizers · ` : ''}${speechLabel(result.backend)} · ${timing} · ${result.model || 'Speech ensemble'}${result.adapter?.fallback ? ' · software GPU' : ''}`;
    $('ask-voice-metrics').textContent = label;
    return label;
  }
  failure(error, backend = this.backend, model = 'Speech ensemble') {
    if (error.name !== 'AbortError') this.diagnostics?.error('local-speech-error', error, { backend, model,
      ...(error.code === 'phone-storage-write' ? { failure: error.code, storage: error.storage } : {}) });
  }
}
