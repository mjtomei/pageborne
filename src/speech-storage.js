import { EnsembleModelStore, ensembleModels, fluidSpeechMini } from '@pageborne/browser-stt';
import { nativeModelCache } from '@pageborne/browser-stt/ensemble-cache';
import { speechModelStorage } from './speech-model-cache.js';
import { safeTimeout, cancelTimeout } from './timers.js';

// A packaged app must never fall back to origin-scoped storage while Even is
// injecting its bridge. Browser previews can still use their own saved files.
export async function waitForSpeechHost({ host = window, document = globalThis.document, timeout = 15000 } = {}) {
  if (typeof host.flutter_inappwebview?.callHandler === 'function') return true;
  if (!host.flutter_inappwebview && !document.querySelector('meta[name="pageborne-host"][content="even"]')) return false;
  return new Promise((resolve, reject) => {
    let timer;
    const done = () => {
      if (typeof host.flutter_inappwebview?.callHandler !== 'function') return;
      cancelTimeout(timer); host.removeEventListener('flutterInAppWebViewPlatformReady', done); resolve(true);
    };
    host.addEventListener('flutterInAppWebViewPlatformReady', done);
    timer = safeTimeout(() => {
      host.removeEventListener('flutterInAppWebViewPlatformReady', done);
      reject(Error('Waiting for the Even app connection. Retry setup on your phone.'));
    }, timeout);
    done();
  });
}

// Retire only the superseded recognizers. Keep the current model and every
// unrelated cache entry. Repeated launches resume cleanup after interruption.
export async function retirePreviousVoiceModels(cache) {
  const keep = new Set(fluidSpeechMini.files.map(file => file.sha256));
  for (const model of ensembleModels) {
    for (const key of [`preparation:${model.id}`, `verification:${model.id}`,
      ...model.files.filter(file => file.text === undefined && !keep.has(file.sha256)).map(file => file.sha256)]) {
      await cache.recover?.(key);
      const saved = await cache.match(key);
      if (saved) { await saved.body?.cancel(); await cache.delete(key); }
    }
  }
}

export function deferredSpeechStore() {
  let choose;
  const storage = new Promise(resolve => { choose = resolve; });
  const store = new EnsembleModelStore({ open: async () => {
    const kv = await storage;
    store.storageKind = kv ? 'phone' : 'browser';
    const cache = kv ? nativeModelCache(kv) : await speechModelStorage.open('pageborne-ensemble-weights-v1');
    await retirePreviousVoiceModels(cache);
    return cache;
  } });
  store.storageKind = 'waiting';
  const fetch = store.fetch;
  // The engine's downloadBytes also counts cache hits. Keep the actual source
  // separate so a saved-file check never looks like another network download.
  store.files = new Map();
  store.stats.networkRequests = 0; store.stats.receivedBytes = 0;
  store.fetch = (...args) => {
    store.stats.networkRequests++;
    const record = [...store.files.values()].find(file => file.url === String(args[0]));
    if (record) { record.state = 'downloading'; record.source = 'network'; record.requests++; }
    return fetch(...args);
  };
  const ensure = store.ensure.bind(store);
  store.ensure = async (file, progress = () => {}) => {
    if (file.text !== undefined || store.pending.has(file.sha256)) return ensure(file, progress);
    const record = store.files.get(file.sha256) || { file: file.file, url: file.url, bytes: file.bytes, requests: 0, receivedBytes: 0 };
    Object.assign(record, { state: 'checking', source: null, availableBytes: 0 });
    store.files.set(file.sha256, record);
    let received = 0;
    try {
      await ensure(file, (bytes, cached) => {
        record.source = cached ? 'saved' : 'network'; record.state = cached ? 'saved' : 'downloading';
        record.availableBytes = bytes;
        if (!cached) {
          const added = Math.max(0, bytes - received); received = bytes;
          record.receivedBytes += added; store.stats.receivedBytes += added;
        }
        progress(bytes, cached);
      });
      record.state = 'saved';
    } catch (error) { record.state = 'error'; throw error; }
  };
  return { store, configure(kv) { choose(kv); } };
}
