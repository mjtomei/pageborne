import packageInfo from '../package.json' with { type: 'json' };
import { restoreSetupHistory, resolveSetupHistory } from './diagnostic-setup-history.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';
export const VERSION = packageInfo.version;
const key = 'even-reader:diagnostics:v1';
const limited = (value, size) => String(value ?? '').slice(0, size);
export function errorDetails(error, depth = 0) {
  const result = {
    name: limited(error?.name || 'Error', 100),
    message: limited(error?.message ?? error ?? 'Unknown error', 2000),
    stack: limited(error?.stack, 12000),
  };
  if (error?.cause && error.cause !== error && depth < 2) result.cause = errorDetails(error.cause, depth + 1);
  return result;
}
function environment() {
  return {
    userAgent: globalThis.navigator?.userAgent || 'test',
    language: globalThis.navigator?.language, platform: globalThis.navigator?.platform,
    viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight, pixelRatio: globalThis.devicePixelRatio },
    evenHost: !!globalThis.flutter_inappwebview?.callHandler,
    capabilities: {
      worker: typeof Worker, wasm: typeof WebAssembly, offscreenCanvas: typeof OffscreenCanvas,
      imageDecoder: typeof ImageDecoder, imageBitmap: typeof createImageBitmap, domMatrix: typeof DOMMatrix,
      promiseWithResolvers: typeof Promise.withResolvers, arrayToSorted: typeof Array.prototype.toSorted,
      arrayFromAsync: typeof Array.fromAsync, iterator: typeof globalThis.Iterator,
      iteratorMap: typeof globalThis.Iterator?.prototype?.map,
      mapGroupBy: typeof Map.groupBy, uint8ArrayFromBase64: typeof Uint8Array.fromBase64,
      arrayBufferTransfer: typeof ArrayBuffer.prototype.transfer, structuredClone: typeof globalThis.structuredClone,
      readableStreamGetReader: typeof globalThis.ReadableStream?.prototype?.getReader,
      readableStreamAsyncIterator: typeof globalThis.ReadableStream?.prototype?.[Symbol.asyncIterator],
      share: typeof globalThis.navigator?.share, fileShare: typeof globalThis.navigator?.canShare,
    },
  };
}
export class Diagnostics {
  constructor(storage, { enabled = true } = {}) {
    this.enabled = enabled; this.active = null;
    this.events = []; this.counts = {}; this.errors = []; this.previous = null; this.unfinishedSetups = [];
    // active still tracks pending bridge operations for display scheduling.
    // Release builds do not access storage, record errors or collect events.
    if (!enabled) return;
    if (storage === undefined) { try { storage = globalThis.localStorage; } catch {} }
    this.storage = storage;
    this.startedAt = new Date().toISOString();
    try { this.previous = JSON.parse(storage.getItem(key) || 'null'); } catch { this.previous = null; }
    this.unfinishedSetups = restoreSetupHistory(this.previous);
    this.errors = Array.isArray(this.previous?.errors) ? this.previous.errors.filter(item => item?.error && typeof item.at === 'string').slice(-12) : [];
    this.log('boot', { version: VERSION, previousRun: this.previous?.startedAt || null });
  }
  persist() { if (this.enabled) { try { this.storage.setItem(key, JSON.stringify(this.summary(40))); } catch {} } }
  restore(previous) {
    if (!this.enabled || !previous) return;
    this.unfinishedSetups = restoreSetupHistory(previous, this.unfinishedSetups);
    if (!this.previous || previous.startedAt > this.previous.startedAt) this.previous = previous;
    for (const error of Array.isArray(previous.errors) ? previous.errors : []) {
      if (error?.error && typeof error.at === 'string' && !this.errors.some(item => item.at === error.at && item.type === error.type)) this.errors.push(error);
    }
    this.errors.sort((a, b) => a.at.localeCompare(b.at)); this.errors = this.errors.slice(-12);
    this.persist();
  }
  error(type, error, context = {}) {
    if (!this.enabled) return;
    const details = errorDetails(error);
    // Repeated failed preview draws must not erase the original failure.
    const existing = this.errors.find(item => item.startedAt === this.startedAt && item.type === type
      && item.error.name === details.name && item.error.message === details.message
      && JSON.stringify(item.context) === JSON.stringify(context));
    if (existing) { existing.occurrences++; existing.lastAt = new Date().toISOString(); this.persist(); return; }
    const entry = { at: new Date().toISOString(), type, version: VERSION, startedAt: this.startedAt,
      error: details, context, environment: environment(), occurrences: 1 };
    this.errors.push(entry); this.errors = this.errors.slice(-12);
    this.log(type, { error: details, context });
    // Optional phone storage backup. Logging failures must never hide the PDF error.
    try { this.onError?.(); } catch {}
  }
  log(type, data = {}) {
    if (!this.enabled) return;
    if (type === 'speech-model-state') this.unfinishedSetups = resolveSetupHistory(this.unfinishedSetups, this.speech, this.startedAt);
    const entry = { at: new Date().toISOString(), type, ...data };
    this.events.push(entry); if (this.events.length > 100) this.events.shift();
    this.counts[type] = (this.counts[type] || 0) + 1;
    this.persist();
    console.info('[even-reader]', JSON.stringify(entry));
    // These transitions matter if the host kills the WebView without a JS
    // exception. Bridge storage logs are deliberately excluded to avoid a
    // checkpoint recursively scheduling more checkpoints.
    if (['ask-state', 'speech-model-state', 'display-frame'].includes(type)
      || ['bridge-error', 'bridge-timeout'].includes(type) && !data.name?.startsWith('storage-')) {
      try { this.onCheckpoint?.(); } catch {}
    }
  }
  summary(limit = 12) {
    if (!this.enabled) return { version: VERSION, enabled: false };
    return { version: VERSION, renderer: this.renderer || 'native-text', startedAt: this.startedAt, active: this.active,
      userAgent: globalThis.navigator?.userAgent || 'test', environment: environment(),
      pdf: this.pdf || null, ask: this.ask || null, speech: this.speech || null, display: this.display || null, library: this.library || null, errors: this.errors,
      counts: { ...this.counts }, events: this.events.slice(-limit),
      unfinishedSetups: this.unfinishedSetups,
      previousRun: this.previous ? { version: this.previous.version, startedAt: this.previous.startedAt, active: this.previous.active, pdf: this.previous.pdf,
        ask: this.previous.ask, speech: this.previous.speech, display: this.previous.display,
        events: this.previous.events?.slice(-12) } : null };
  }
}

// Timeouts report failure without releasing the lane before the uncancellable
// SDK call settles. Reconnect/exit therefore cannot overlap a pending update.
export class BridgeLane {
  constructor(diagnostics, timeoutMs = 8000) { this.diagnostics = diagnostics; this.timeoutMs = timeoutMs; this.tail = Promise.resolve(); this.busy = false; }
  run(name, operation, { quiet = false, context = {} } = {}) {
    let timer; let rejectTimeout; let expired = false, started = false;
    const timeout = new Promise((_, reject) => { rejectTimeout = reject; });
    // A hung display call also blocks queued storage. Bound the queue wait,
    // and never execute an expired write later against newer application state.
    timer = setTimeout(() => {
      expired = true;
      this.diagnostics.log('bridge-timeout', { name, ...context, queued: !started });
      rejectTimeout(Object.assign(new Error(`${name} timed out. Close and reopen the reader if it stays pending.`),
        { code: 'bridge-timeout', operation: name, context, queued: !started }));
    }, this.timeoutMs);
    const original = this.tail.catch(() => {}).then(async () => {
      if (expired) return;
      started = true;
      this.busy = true; const startedAt = performance.now();
      this.diagnostics.active = { name, ...context, at: new Date().toISOString() };
      if (!quiet) this.diagnostics.log('bridge-start', { name, ...context });
      try {
        const result = await operation();
        this.diagnostics.active = null;
        if (!quiet) this.diagnostics.log('bridge-ok', { name, ...context, ms: Math.round(performance.now() - startedAt) });
        return result;
      } catch (error) {
        this.diagnostics.active = null;
        this.diagnostics.log('bridge-error', { name, ...context, code: error.code, message: String(error.message).slice(0, 300) });
        throw error;
      } finally { this.busy = false; this.diagnostics.active = null; clearTimeout(timer); }
    });
    this.tail = original;
    return Promise.race([original, timeout]);
  }
}
