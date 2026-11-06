import { safeTimeout as setTimeout, cancelTimeout } from './timers.js';

const megabytes = bytes => `${((bytes || 0) / 1e6).toFixed(1)} MB`;
export function modelFileStatus(entry, store) {
  const files = (entry.model.files || []).filter(file => file.text === undefined);
  const records = files.map(file => store?.files?.get(file.sha256));
  const downloading = records.some(file => file?.state === 'downloading');
  const saved = entry.verified || (files.length ? records.every(file => file?.state === 'saved') : entry.downloadBytes >= entry.totalBytes);
  const received = records.reduce((n, file) => n + (file?.receivedBytes || 0), 0);
  const value = entry.verified ? 1 : files.length ? records.reduce((n, file) => n + (file?.availableBytes || 0), 0) / Math.max(1, entry.totalBytes)
    : (entry.downloadBytes || 0) / Math.max(1, entry.totalBytes || 0);
  return { downloading, saved, value, text: downloading ? `Downloading · ${megabytes(received)}`
    : saved ? `Saved ${store?.storageKind === 'phone' ? 'on phone' : 'locally'}`
      : entry.state === 'idle' ? 'Not checked yet' : entry.state === 'error' ? 'Needs retry' : 'Checking saved files…' };
}

export function modelDownloadSummary(store, verified = false) {
  const stats = store?.stats || {};
  if (stats.networkRequests) return `Downloaded this run: ${megabytes(stats.receivedBytes)}. Saved files are reused.`;
  const cached = verified || [...(store?.files?.values() || [])].some(file => file.source === 'saved');
  return `${cached ? 'Using saved files' : 'Checking saved files'}. Downloaded this run: 0 MB.`;
}

export function speechSetupFrame(entries, error = '', store) {
  const ready = entries.filter(entry => entry.verified || entry.state === 'ready' && entry.ready?.verified).length;
  const description = entry => entry.state === 'ready' ? 'Ready' : entry.state === 'idle' && entry.verified ? 'Saved check passed' : entry.state === 'error' ? 'Needs retry on phone'
    : entry.state === 'downloading' ? modelFileStatus(entry, store).text
      : entry.state === 'loading' ? ({ runtime: 'Starting model…', loading: 'Loading saved files…', initializing: 'Initializing model…', checking: 'Checking transcription…' })[entry.setup.stage] || 'Preparing…'
        : 'Waiting';
  return { kind: 'loading', body: [error ? 'Voice setup needs attention' : 'Preparing voice models', '',
    ...entries.flatMap(entry => [entry.model.name, description(entry)])].join('\n'),
    status: error ? 'Open phone to retry setup' : `${ready}/${entries.length} ready · Waiting for voice setup` };
}

// A native modal makes the entire phone interface inert. The app also gates
// glasses gestures and library/PDF restoration until this promise resolves.
export class SpeechSetup {
  constructor(models, { dialog = document.getElementById('speech-setup') } = {}) {
    this.models = models; this.dialog = dialog; this.blocked = true;
    this.rows = new Map();
    const list = dialog.querySelector('.speech-setup-models');
    for (const entry of Object.values(models.entries)) {
      const row = document.createElement('section'); row.className = 'speech-setup-model'; row.dataset.model = entry.model.id;
      const title = document.createElement('h3'); title.textContent = entry.model.name; row.append(title);
      const bars = {};
      for (const [key, label] of [['download', 'Model files'], ['setup', 'Setup & check']]) {
        const header = document.createElement('div'); header.className = 'speech-setup-label';
        const name = document.createElement('span'); name.textContent = label;
        const status = document.createElement('span'); status.dataset.stage = key;
        const bar = document.createElement('progress'); bar.max = 1; bar.value = 0; bar.setAttribute('aria-label', `${entry.model.name}: ${label}`);
        header.append(name, status); row.append(header, bar); bars[key] = { status, bar };
      }
      const detail = document.createElement('p'); detail.className = 'speech-setup-detail';
      row.append(detail); this.rows.set(entry.model.id, { row, detail, ...bars }); list.append(row);
    }
    dialog.addEventListener('cancel', event => event.preventDefault());
    dialog.querySelector('#speech-setup-retry').onclick = () => this.attempt(true);
    dialog.querySelector('#speech-setup-free-space').onclick = () => this.freeSpace();
    dialog.querySelector('#speech-setup-skip').onclick = () => this.continueWithoutVoice();
    this.render();
  }
  frame() { return speechSetupFrame(Object.values(this.models.entries), this.error, this.models.store); }
  start(initialize) { return this.begin(initialize); }
  begin(initialize, { retry = false } = {}) {
    if (this.pending) return this.pending;
    this.blocked = true; this.initialize = initialize;
    this.pending = new Promise(resolve => { this.resolve = resolve; });
    const tick = () => { this.render(); if (this.blocked) this.timer = setTimeout(tick, 1000); };
    this.timer = setTimeout(tick, 1000);
    void this.attempt(retry);
    return this.pending;
  }
  async attempt(retry) {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.recoveryStatus = ''; this.render();
    // Restore a small receipt before deciding whether a setup modal is needed.
    await new Promise(resolve => setTimeout(resolve, 25));
    try {
      const restored = await this.initialize({ retry });
      this.initialized = true;
      if (!retry && restored?.recoveredSetup) throw Error('Previous voice setup did not finish. Export the saved log below, or choose Retry setup.');
      const verified = await this.models.restoreVerification();
      if (!verified || retry) { this.dialog.showModal(); this.dialog.querySelector('h2').focus(); }
      // Prepare Moonshine's larger runtime before retaining the other models.
      // Keep the display order stable and still require every real voice check.
      const preparation = Object.values(this.models.entries).sort((a, b) => Number(b.model.id === 'moonshine') - Number(a.model.id === 'moonshine'));
      for (const entry of preparation) if (!entry.verified || retry) await this.models.prepare(entry.model.id, { retry });
      if (!Object.values(this.models.entries).every(entry => entry.verified)) throw Error('All three voice checks must pass before continuing.');
      this.render();
      if (this.dialog.open) await new Promise(resolve => setTimeout(resolve, 350));
      // Reading does not need resident speech heaps. Load them on speaking;
      // the saved checks remain valid and weights remain on the phone.
      this.suspended = false;
      this.models.close();
      this.blocked = false; cancelTimeout(this.timer); this.dialog.close(); this.resolve(); this.pending = null;
    } catch (error) {
      this.storageFailure = error.code === 'phone-storage-write' || error.name === 'QuotaExceededError' || /(?:phone|app) storage|quota/i.test(error.message);
      this.error = error.message || 'Voice setup could not finish. Retry when connected.';
      if (!this.dialog.open) this.dialog.showModal();
    } finally { this.busy = false; this.render(); }
  }
  async freeSpace() {
    if (this.busy || !this.recoverStorage) return;
    this.busy = true; this.recoveryStatus = 'Freeing cached space…'; this.render();
    try {
      const chars = await this.recoverStorage();
      this.recoveryStatus = chars ? `Cleared ${(chars / 1e6).toFixed(1)} MB of cached data. Retry setup to check whether there is enough room.`
        : 'No disposable cached data to clear. You can continue without voice to access your library.';
    } catch (error) { this.recoveryStatus = `Could not clear cached data: ${error.message}`; }
    finally { this.busy = false; this.render(); }
  }
  continueWithoutVoice() {
    if (this.busy || !this.initialized || !this.error) return;
    this.suspended = true; this.models.close();
    this.blocked = false; cancelTimeout(this.timer); this.dialog.close();
    this.resolve?.(); this.pending = null;
  }
  render() {
    const entries = Object.values(this.models.entries);
    for (const entry of entries) {
      const { row, detail, download, setup } = this.rows.get(entry.model.id);
      row.dataset.state = entry.state;
      const files = modelFileStatus(entry, this.models.store);
      download.bar.value = Math.min(1, files.value);
      download.status.textContent = files.text;
      const stage = entry.setup.stage;
      const component = entry.setup.component;
      setup.status.textContent = entry.state === 'idle' && entry.verified ? 'Passed' : entry.state === 'error' ? 'Needs retry' : stage === 'initializing' && component ? `Initializing ${component}` : ({ waiting: 'Waiting', runtime: 'Starting', loading: 'Loading saved files', initializing: 'Initializing', checking: 'Testing transcription', ready: 'Passed' })[stage];
      const elapsed = Math.max(0, Math.floor((Date.now() - (entry.setup.stageStartedAt || Date.now())) / 1000));
      const idle = Math.max(0, Math.floor((Date.now() - (entry.setup.lastProgressAt || Date.now())) / 1000));
      detail.hidden = !['loading', 'error'].includes(entry.state);
      detail.textContent = stage === 'loading' && entry.setup.file
        ? `${entry.setup.file.split('/').at(-1)} · ${((entry.setup.fileLoadedBytes || 0) / 1e6).toFixed(1)} / ${((entry.setup.fileBytes || 0) / 1e6).toFixed(1)} MB · ${elapsed}s${idle >= 10 ? ` · No progress for ${idle}s` : ''}`
        : `${elapsed}s${idle >= 10 && entry.state === 'loading' ? ` · Waiting for ${stage === 'initializing' ? 'model initialization' : 'model response'}` : ''}`;
      if (['runtime', 'initializing', 'checking'].includes(stage) && entry.state !== 'error') setup.bar.removeAttribute('value');
      else setup.bar.value = entry.verified || stage === 'ready' ? 1 : stage === 'loading' ? Math.min(1, entry.setup.loadedBytes / Math.max(1, entry.setup.totalBytes)) : 0;
    }
    const ready = entries.every(entry => entry.verified);
    this.dialog.querySelector('#speech-setup-help').textContent = modelDownloadSummary(this.models.store, ready)
      + ' Successful checks are saved on this device. Checks repeat if the models, device or speech runtime change; models load when you speak.';
    const status = this.dialog.querySelector('[role=status]');
    const text = this.recoveryStatus || (this.storageFailure && this.error
      ? 'Even could not save Pageborne data. Its app storage may be full or unavailable. Free cached space, then retry, or continue without voice.'
      : this.error) || (ready ? 'All three models passed. Opening Pageborne…' : 'Keep Pageborne open while voice is prepared.');
    if (status.textContent !== text) status.textContent = text;
    const retry = this.dialog.querySelector('#speech-setup-retry'); retry.hidden = !this.error; retry.disabled = this.busy;
    const free = this.dialog.querySelector('#speech-setup-free-space');
    free.hidden = !(this.error && this.storageFailure && this.recoverStorage); free.disabled = this.busy;
    this.dialog.querySelector('#speech-setup-recovery-help').hidden = free.hidden;
    const skip = this.dialog.querySelector('#speech-setup-skip'); skip.hidden = !(this.error && this.initialized); skip.disabled = this.busy;
  }
}
