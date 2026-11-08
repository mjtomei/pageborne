import { addDocument, replaceDocument, updateDocumentDates, assertDocumentUnchanged, localSnapshot, documentMetadata, hashDocument, MAX_DOCUMENTS } from './library.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';

export const STORAGE_PREFIX = 'even-reader:phone:v1';
export const CHUNK_CHARS = 32000;
// Encoded document-body budget, separate from voice models and PDF layouts.
export const DOCUMENT_CACHE_CHARS = 32 * 1024 * 1024;
const JOURNAL = `${STORAGE_PREFIX}:pending`;
const bridgeHealth = new WeakMap();
export const storageUnavailable = error => error?.code === 'phone-storage-unavailable'
  || error?.code === 'bridge-timeout' && error.operation?.startsWith('storage-');
const remoteBacked = doc => doc.remote && doc.remote.name === doc.id && doc.remote.sha256 === doc.sha256
  && /^[a-f0-9]{64}$/.test(doc.sha256) && typeof doc.remote.libraryId === 'string' && doc.remote.libraryId
  && typeof doc.remote.endpoint === 'string' && doc.remote.endpoint;

function checksum(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export function chunksOf(text) {
  const chunks = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + CHUNK_CHARS);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}
export function descriptor(prefix, text, chunks) { return { prefix, count: chunks.length, length: text.length, checksum: checksum(text) }; }
export function validateDescriptor(value, { largeValue = false } = {}) {
  if (!value || typeof value.prefix !== 'string' || !value.prefix.startsWith(STORAGE_PREFIX + ':')
    || !Number.isSafeInteger(value.count) || value.count < 0 || (!largeValue && value.count > 4096)
    || !Number.isSafeInteger(value.length) || value.length < 0 || (!largeValue && value.length > 128 * 1024 * 1024)
    || (largeValue && (value.count < Math.ceil(value.length / CHUNK_CHARS)
      || value.count > Math.ceil(value.length / (CHUNK_CHARS - 1))))
    || typeof value.checksum !== 'string') throw new Error('Saved phone data is invalid. No files were changed.');
}
export async function readChunks(kv, ref, { signal, largeValue = false } = {}) {
  validateDescriptor(ref, { largeValue });
  const chunks = [];
  for (let i = 0; i < ref.count; i++) { signal?.throwIfAborted(); chunks.push(await kv.get(`${ref.prefix}:${i}`)); }
  signal?.throwIfAborted();
  const text = chunks.join('');
  if (text.length !== ref.length || checksum(text) !== ref.checksum) throw new Error('Saved phone data is incomplete. No files were changed.');
  return text;
}

// Write into the inactive slot, then commit one small pointer last. A failed
// chunk write never replaces the last complete index or preferences value.
export class AtomicPhoneValue {
  constructor(kv, name) { this.kv = kv; this.key = `${STORAGE_PREFIX}:${name}`; this.head = null; }
  async read() {
    const raw = await this.kv.get(this.key);
    this.head = raw ? JSON.parse(raw) : null;
    if (!this.head) return null;
    if (![`${this.key}:a`, `${this.key}:b`].includes(this.head.prefix)) throw new Error('Saved phone data is invalid.');
    return JSON.parse(await readChunks(this.kv, this.head));
  }
  async write(value) {
    const text = JSON.stringify(value); const chunks = chunksOf(text);
    const prefix = `${this.key}:${this.head?.prefix === `${this.key}:a` ? 'b' : 'a'}`;
    const next = descriptor(prefix, text, chunks);
    for (let i = 0; i < chunks.length; i++) await this.kv.set(`${prefix}:${i}`, chunks[i]);
    await this.kv.set(this.key, JSON.stringify(next));
    this.head = next;
  }
  async releaseInactive() {
    if (!this.head) return 0;
    const prefix = `${this.key}:${this.head.prefix === `${this.key}:a` ? 'b' : 'a'}`;
    let cleared = 0;
    // Only the pointed-to slot is committed. Discard the unused copy before
    // a shrinking transaction needs space for its journal/replacement index.
    for (let i = 0; i < this.head.count; i++) {
      const key = `${prefix}:${i}`, value = await this.kv.get(key);
      if (value) { await this.kv.set(key, ''); cleared += value.length; }
    }
    return cleared;
  }
}

export function bridgeStorage(bridge, lane) {
  if (!bridgeHealth.has(bridge)) bridgeHealth.set(bridge, { write: 'unknown', populatedReads: 0 });
  const health = bridgeHealth.get(bridge);
  // Keep payloads, document names and model keys out of diagnostics.
  const context = (key, value) => ({ area: key.startsWith('pageborne:models:v1:') ? 'models'
    : key.startsWith(`${STORAGE_PREFIX}:pdf-cache:`) ? 'pdf-cache'
    : key.slice(STORAGE_PREFIX.length + 1).split(':')[0], ...(value === undefined ? {} : { characters: value.length }) });
  return {
    health,
    async get(key) {
      return lane.run('storage-read', async () => {
        const value = await bridge.getLocalStorage(key);
        if (typeof value !== 'string') throw Object.assign(new Error('Even app storage is unavailable. Close and reopen the reader.'), { code: 'phone-storage-unavailable' });
        if (value) health.populatedReads++;
        return value;
      }, { quiet: key.startsWith('pageborne:models:v1:'), context: context(key) });
    },
    async set(key, value) {
      return lane.run('storage-write', async () => {
        // SDK convenience methods map an empty native response to false.
        const result = typeof bridge.callEvenApp === 'function'
          ? await bridge.callEvenApp('setLocalStorage', { key, value }) : await bridge.setLocalStorage(key, value);
        health.write = result === true ? 'ok' : result === false ? 'rejected' : 'unavailable';
        if (result !== true && result !== false) throw Object.assign(
          new Error('Even app storage did not acknowledge the save. Close and reopen the Even app to reconnect.'),
          { code: 'phone-storage-unavailable', storage: { ...context(key, value), response: result == null ? 'empty' : typeof result } });
        if (result !== true) throw Object.assign(
          new Error('Even app storage rejected the save. Its storage may be full or unavailable.'),
          { code: 'phone-storage-write', storage: context(key, value) });
      }, { quiet: key.startsWith('pageborne:models:v1:'), context: context(key, value) });
    },
  };
}

export class PhoneLibrary {
  constructor(kv, { lazy = false, onDemand = false, cacheChars = DOCUMENT_CACHE_CHARS, download, cacheChanged = () => {} } = {}) {
    this.lazy = lazy; this.kv = kv; this.index = new AtomicPhoneValue(kv, 'library');
    Object.assign(this, { onDemand, cacheChars, download, cacheChanged });
    this.readOnly = false; this.syncBaselineTrusted = false;
    this.catalog = { version: 1, migrated: false, documents: [] };
    this.snapshot = localSnapshot(null); this.tail = Promise.resolve(); this.uncertain = false;
  }
  serialize(work) {
    const result = this.tail.catch(() => {}).then(async () => {
      if (this.uncertain && !this.readOnly) throw Object.assign(new Error('The last phone save could not be confirmed. Close and reopen the reader before changing files.'), { code: 'phone-storage-unavailable' });
      if (!this.readOnly) await this.recover();
      return work();
    });
    // The queue must not retain the last loaded/saved document body.
    this.tail = result.then(() => {}, () => {}); return result;
  }
  async recover() {
    const raw = await this.kv.get(JOURNAL);
    if (!raw) return;
    const pending = JSON.parse(raw);
    if (Array.isArray(pending)) {
      // A tiny durable deletion intent fits after discarding the unused index
      // slot. It allows freeing the selected body BEFORE writing a new index.
      // The old index remains the recovery record until the pointer commits.
      const [kind, length, index] = pending;
      if (pending.length !== 3 || kind !== 'delete' || !Number.isSafeInteger(length) || length <= 0
        || !Number.isSafeInteger(index) || index < 0 || !this.index.head || this.index.head.length > length) {
        throw new Error('Invalid pending deletion. No files were changed.');
      }
      if (this.index.head.length === length) {
        const meta = this.catalog.documents[index];
        if (!meta) throw new Error('Invalid pending deletion. No files were changed.');
        if (meta.body) {
          validateDescriptor(meta.body);
          if (!meta.body.prefix.startsWith(`${STORAGE_PREFIX}:doc:`)) throw new Error('Invalid pending deletion. No files were changed.');
          for (let i = 0; i < meta.body.count; i++) await this.kv.set(`${meta.body.prefix}:${i}`, '');
        }
        await this.commit({ ...this.catalog, documents: this.catalog.documents.filter((_, i) => i !== index) });
        this.snapshot = { ...this.snapshot, documents: this.snapshot.documents.filter(doc => doc.id !== meta.id) };
      }
      // Removing a metadata record strictly shrinks the index. A shorter
      // committed head means deletion already finished; never delete by the
      // old array position in the replacement catalog.
      await this.kv.set(JOURNAL, '');
      return;
    }
    const refs = pending.kind === 'bodies' && Array.isArray(pending.bodies) ? pending.bodies : [pending];
    for (const ref of refs) { validateDescriptor(ref); if (!ref.prefix.startsWith(`${STORAGE_PREFIX}:doc:`)) throw Error('Invalid document cleanup journal.'); }
    for (const ref of refs) if (!this.catalog.documents.some(doc => doc.body?.prefix === ref.prefix)) {
      for (let i = 0; i < ref.count; i++) await this.kv.set(`${ref.prefix}:${i}`, '');
    }
    await this.kv.set(JOURNAL, '');
  }
  async commit(catalog) {
    this.requireWritable();
    try { await this.index.write(catalog); }
    // A timed-out host call could still commit later. Do not start another
    // mutation against an uncertain index; reopening reads the actual pointer.
    catch (error) { this.uncertain = !storageWriteRejected(error); throw error; }
    this.catalog = catalog;
    this.syncBaselineTrusted = true;
  }
  requireWritable() {
    if (this.readOnly) throw Object.assign(Error('Even storage is unavailable. The desktop library is read-only until you reopen the app.'), { code: 'phone-storage-unavailable' });
  }
  metadata(meta) {
    const { body, cachedAt, ...doc } = meta;
    return { ...doc, revision: doc.revision || body?.prefix, ...(this.onDemand ? { availableOffline: !!body } : {}) };
  }
  refreshSnapshot() { this.snapshot = localSnapshot({ documents: this.catalog.documents.map(meta => this.metadata(meta)) }); }
  get cacheUsage() { return this.catalog.documents.reduce((sum, doc) => sum + (remoteBacked(doc) ? doc.body?.length || 0 : 0), 0); }
  async read(legacy = null, onProgress = () => {}) {
    const saved = await this.index.read();
    if (saved) {
      if (![1, 2].includes(saved.version) || !Array.isArray(saved.documents) || saved.documents.length > MAX_DOCUMENTS) throw new Error('Saved phone library is invalid. No files were changed.');
      this.catalog = saved;
      this.syncBaselineTrusted = true;
    }
    await this.recover();
    const documents = [];
    for (const meta of this.catalog.documents) {
      onProgress(`Opening saved documents (${documents.length + 1}/${this.catalog.documents.length})…`);
      const { body } = meta;
      if (body) validateDescriptor(body);
      else if (!remoteBacked(meta)) throw new Error('Saved phone document has no original or desktop reference. No files were changed.');
      documents.push({ ...this.metadata(meta), ...(!this.lazy && body ? { content: await readChunks(this.kv, body) } : {}) });
    }
    this.snapshot = localSnapshot({ documents });
    if (!this.catalog.migrated) {
      const old = localSnapshot(typeof legacy === 'function' ? await legacy() : legacy);
      for (const doc of old.documents) {
        if (this.snapshot.documents.some(saved => saved.id === doc.id)) continue;
        onProgress(`Saving ${doc.id} to phone storage…`);
        await this.save(doc, () => {}, true);
      }
      // Opening an empty library must not depend on a successful write. A
      // missing index is not evidence of deliberate local deletions either.
      if (saved || old.documents.length) await this.commit({ ...this.catalog, migrated: true });
      else this.catalog.migrated = true;
    }
    return this.snapshot;
  }
  async loadDocument(expected, { signal, progress = () => {}, backgroundCache = false } = {}) {
    const cached = await this.serialize(async () => {
      signal?.throwIfAborted();
      const meta = this.catalog.documents.find(doc => doc.id === expected.id);
      assertDocumentUnchanged(meta && this.metadata(meta), expected);
      if (!meta.body) return null;
      try {
        const content = await readChunks(this.kv, meta.body, { signal });
        if (!backgroundCache && this.onDemand && remoteBacked(meta) && !this.readOnly) {
          try { await this.commit({ ...this.catalog, documents: this.catalog.documents.map(d => d.id === meta.id ? { ...d, cachedAt: Date.now() } : d) }); }
          catch (error) { this.cacheError = error; this.cacheChanged(); }
        }
        return { ...this.metadata(meta), content };
      } catch (error) { if (signal?.aborted || !remoteBacked(meta)) throw error; return null; }
    }).catch(error => {
      if (signal?.aborted || !remoteBacked(expected) || !(storageUnavailable(error) || storageWriteRejected(error))) throw error;
      this.readOnly = true; this.cacheError = error; this.cacheChanged(); return null;
    });
    if (cached) {
      if (backgroundCache && this.onDemand && remoteBacked(expected) && !this.readOnly) {
        void this.serialize(async () => {
          if (this.readOnly || signal?.aborted) return;
          const meta = this.catalog.documents.find(d => d.id === expected.id);
          if (!meta?.body || meta.sha256 !== expected.sha256) return;
          await this.commit({ ...this.catalog, documents: this.catalog.documents.map(d => d.id === meta.id ? { ...d, cachedAt: Date.now() } : d) });
        }).catch(error => { this.cacheError = error; this.cacheChanged(); });
      }
      return cached;
    }
    if (!remoteBacked(expected) || !this.download) throw Error('This document needs a desktop connection. Connect and try again.');
    const doc = await this.download(expected, { signal, progress });
    signal?.throwIfAborted();
    if (doc.id !== expected.id || await hashDocument(doc) !== expected.sha256) throw Error('Downloaded document does not match the catalog. Sync and try again.');
    assertDocumentUnchanged(this.snapshot.documents.find(d => d.id === expected.id), expected);
    if (!this.readOnly && doc.content.length <= this.cacheChars) {
      const cache = this.cacheDocument(doc, expected, signal).catch(error => {
        if (signal?.aborted) { if (!backgroundCache) throw error; return; }
        this.cacheError = error; this.cacheChanged();
      });
      if (!backgroundCache) await cache;
    }
    signal?.throwIfAborted();
    assertDocumentUnchanged(this.snapshot.documents.find(d => d.id === expected.id), expected);
    return { ...expected, ...doc, revision: expected.revision, remote: expected.remote,
      availableOffline: !!this.catalog.documents.find(d => d.id === expected.id)?.body && !this.cacheError };
  }
  clearCachedDocuments() {
    return this.serialize(async () => {
      this.requireWritable(); const before = this.cacheUsage;
      await this.pruneCache(this.cacheChars); this.refreshSnapshot(); this.cacheChanged();
      return before - this.cacheUsage;
    });
  }
  async pruneCache(needed = 0, protect) {
    for (const doc of [...this.catalog.documents].filter(d => d.id !== protect && d.body && remoteBacked(d))
      .sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0))) {
      if (this.cacheUsage + needed <= this.cacheChars) break;
      await this.index.releaseInactive();
      await this.kv.set(JOURNAL, JSON.stringify(doc.body));
      const { body, cachedAt, ...meta } = doc; meta.revision ||= body.prefix;
      await this.commit({ ...this.catalog, documents: this.catalog.documents.map(d => d.id === doc.id ? meta : d) });
      this.refreshSnapshot(); await this.recover();
    }
  }
  cacheDocument(document, expected, signal) {
    return this.serialize(async () => {
      this.requireWritable(); signal?.throwIfAborted();
      const meta = this.catalog.documents.find(d => d.id === expected.id);
      assertDocumentUnchanged(meta && this.metadata(meta), expected);
      await this.pruneCache(document.content.length - (meta.body?.length || 0), meta.id);
      signal?.throwIfAborted();
      const chunks = chunksOf(document.content), body = descriptor(`${STORAGE_PREFIX}:doc:${crypto.randomUUID()}`, document.content, chunks);
      await this.kv.set(JOURNAL, JSON.stringify({ kind: 'bodies', bodies: [body, ...(meta.body ? [meta.body] : [])] }));
      for (let i = 0; i < chunks.length; i++) { signal?.throwIfAborted(); await this.kv.set(`${body.prefix}:${i}`, chunks[i]); }
      signal?.throwIfAborted();
      await this.commit({ ...this.catalog, documents: this.catalog.documents.map(d => d.id === meta.id
        ? { ...d, title: document.title, words: document.words, ...(document.readingWords == null ? {} : { readingWords: document.readingWords }), body, cachedAt: Date.now() } : d) });
      this.cacheError = null; this.refreshSnapshot(); await this.recover().catch(() => {});
      this.cacheChanged();
    });
  }
  confirmRemote(files, source) {
    return this.serialize(async () => {
      this.requireWritable();
      const documents = this.catalog.documents.map(doc => files.some(f => f.name === doc.id && f.sha256 === doc.sha256)
        ? { ...doc, revision: doc.revision || doc.body?.prefix, remote: { ...source, name: doc.id, sha256: doc.sha256 } } : doc);
      if (JSON.stringify(documents) !== JSON.stringify(this.catalog.documents)) {
        await this.index.releaseInactive();
        await this.commit({ ...this.catalog, version: 2, documents });
      }
      await this.pruneCache(); this.refreshSnapshot();
      return { snapshot: this.snapshot };
    });
  }
  putRemote(file, source, expected) {
    return this.serialize(async () => {
      this.requireWritable();
      const old = this.catalog.documents.find(doc => doc.id === file.name);
      assertDocumentUnchanged(old && this.metadata(old), expected);
      const result = replaceDocument(this.snapshot, remoteDocument(file, source), expected);
      await this.index.releaseInactive();
      if (old?.body) await this.kv.set(JOURNAL, JSON.stringify(old.body));
      await this.commit({ ...this.catalog, version: 2, documents: [...this.catalog.documents.filter(d => d.id !== file.name), result.document] });
      this.refreshSnapshot();
      if (old?.body) await this.recover().catch(() => {});
      return { snapshot: this.snapshot, document: result.document };
    });
  }
  browseRemote(remote, source) {
    // No writes, uploads or deletions. Inaccessible phone state must never
    // become a three-way-sync deletion. Keep readable local edits as well.
    if (remote.files.length > MAX_DOCUMENTS) throw Error('Desktop catalog exceeds the document limit. No files were changed.');
    this.readOnly = true;
    const documents = new Map(this.catalog.documents.map(d => [d.id, d]));
    for (const file of remote.files) {
      const old = documents.get(file.name);
      if (!old || remoteBacked(old) && !old.body) documents.set(file.name, remoteDocument(file, source));
    }
    this.catalog = { ...this.catalog, documents: [...documents.values()] }; this.refreshSnapshot();
    return { snapshot: this.snapshot };
  }
  cacheHash(expected, sha256) {
    return this.serialize(async () => {
      assertDocumentUnchanged(this.snapshot.documents.find(doc => doc.id === expected.id), expected);
      await this.commit({ ...this.catalog, documents: this.catalog.documents.map(doc => doc.id === expected.id ? { ...doc, sha256 } : doc) });
      this.snapshot = { ...this.snapshot, documents: this.snapshot.documents.map(doc => doc.id === expected.id ? { ...doc, sha256 } : doc) };
      return { snapshot: this.snapshot };
    });
  }
  put(document, expected) { return this.save(document, () => {}, false, expected); }
  updateDates(updates) {
    return this.serialize(async () => {
      const result = updateDocumentDates(this.snapshot, updates);
      const catalog = { ...this.catalog, documents: this.catalog.documents.map(meta => {
        const { content, ...doc } = result.snapshot.documents.find(doc => doc.id === meta.id);
        return { ...meta, ...doc };
      }) };
      if (this.readOnly) this.catalog = catalog; else await this.commit(catalog);
      this.snapshot = result.snapshot;
      return result;
    });
  }
  updateMetadata(updates) { return this.updateDates(updates); }
  save(document, onProgress = () => {}, migrating = false, expected = undefined) {
    return this.serialize(async () => {
      this.requireWritable();
      const old = expected !== undefined ? this.catalog.documents.find(doc => doc.id === document.id) : null;
      const result = expected !== undefined ? replaceDocument(this.snapshot, document, expected) : addDocument(this.snapshot, document);
      if (migrating) {
        result.document.positionKey = document.positionKey;
        if (!document.addedAt) delete result.document.addedAt;
      }
      result.document.sha256 = crypto.subtle ? await hashDocument(result.document) : undefined;
      if (!remoteBacked(result.document)) delete result.document.remote;
      const chunks = chunksOf(result.document.content);
      const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
      const body = descriptor(`${STORAGE_PREFIX}:doc:${nonce}`, result.document.content, chunks);
      result.document.revision = body.prefix;
      await this.kv.set(JOURNAL, JSON.stringify(body));
      onProgress({ loaded: 0, total: chunks.length + 1 });
      for (let i = 0; i < chunks.length; i++) {
        await this.kv.set(`${body.prefix}:${i}`, chunks[i]);
        onProgress({ loaded: i + 1, total: chunks.length + 1 });
      }
      const { content, ...meta } = result.document;
      await this.commit({ ...this.catalog, documents: old
        ? this.catalog.documents.map(doc => doc.id === document.id ? { ...meta, body } : doc)
        : [...this.catalog.documents, { ...meta, body }] });
      if (this.lazy) result.snapshot.documents = result.snapshot.documents.map(documentMetadata);
      this.snapshot = result.snapshot;
      if (this.onDemand) { this.refreshSnapshot(); result.snapshot = this.snapshot; }
      onProgress({ loaded: chunks.length + 1, total: chunks.length + 1 });
      // The index is committed. A failed cleanup must not report this file as
      // unsaved; the journal is retried before the next operation or at boot.
      await this.recover().catch(() => {});
      // The new body/index is committed. Cleanup may be retried at next boot.
      if (old?.body) {
        await this.kv.set(JOURNAL, JSON.stringify(old.body)).then(() => this.recover()).catch(() => {});
      }
      return result;
    });
  }
  remove(id, expected = undefined) {
    return this.serialize(async () => {
      this.requireWritable();
      if (expected !== undefined) assertDocumentUnchanged(this.snapshot.documents.find(doc => doc.id === id), expected);
      const meta = this.catalog.documents.find(doc => doc.id === id);
      if (!meta) return { snapshot: this.snapshot };
      await this.index.releaseInactive();
      await this.kv.set(JOURNAL, JSON.stringify(['delete', this.index.head.length, this.catalog.documents.indexOf(meta)]));
      try { await this.recover(); }
      catch (error) { if (this.catalog.documents.some(doc => doc.id === id)) throw Object.assign(error, { deletionPending: true }); }
      return { snapshot: this.snapshot };
    });
  }
}

function remoteDocument(file, source) {
  return { id: file.name, title: file.title || file.name.replace(/\.[^.]+$/, ''), bytes: file.bytes, words: file.words || 0,
    ...(file.readingWords == null ? {} : { readingWords: file.readingWords }),
    ...(file.addedAt ? { addedAt: file.addedAt } : {}), ...(file.modifiedAt ? { modifiedAt: file.modifiedAt } : {}),
    ...(/\.pdf$/i.test(file.name) ? { format: 'pdf' } : {}), sha256: file.sha256,
    revision: `desktop:${source.libraryId}:${file.sha256}`, remote: { ...source, name: file.name, sha256: file.sha256 },
    positionKey: `local\n${file.name}`, availableOffline: false };
}

// A confirmed rejection can be retried after reclaiming disposable data. A
// timeout cannot: the uncancellable native write might still commit later.
export const storageWriteRejected = error => error?.code === 'phone-storage-write' || error?.name === 'QuotaExceededError';
export async function retryAfterStorageRecovery(work, recover) {
  try { return await work(); }
  catch (error) {
    if (!storageWriteRejected(error)) throw error;
    try {
      if (!(await recover())) throw error;
      return await work();
    } catch (retryError) {
      if (error.deletionPending) retryError.deletionPending = true;
      throw retryError;
    }
  }
}

const positionFields = ['positions', 'selected', 'recent', 'openedAt', 'updatedAt'];
const stablePreferences = value => Object.fromEntries(Object.entries(value).filter(([key]) => !positionFields.includes(key)));
export class PhonePreferences {
  constructor(kv, onError = () => {}, delay = 500, { recover = async () => 0 } = {}) {
    this.value = new AtomicPhoneValue(kv, 'preferences'); this.onError = onError; this.delay = delay;
    this.position = new AtomicPhoneValue(kv, 'reading-position'); this.recover = recover;
    this.pending = null; this.saved = null; this.running = null; this.timer = null;
  }
  async read(fallback) {
    let saved = await this.value.read();
    const position = await this.position.read();
    this.stable = saved && JSON.stringify(stablePreferences(saved));
    if (saved && position?.version === 1 && Number(position.updatedAt) > Number(saved.updatedAt || 0)) {
      saved = { ...saved }; for (const key of positionFields) delete saved[key];
      Object.assign(saved, position.state);
    }
    this.saved = saved ? JSON.stringify(saved) : null;
    // A WebView can close before its async phone-storage write commits. Its
    // synchronous local copy must not be replaced by an older phone save.
    if ((Number(fallback?.updatedAt) || 0) > (Number(saved?.updatedAt) || 0)) return fallback;
    return saved || fallback;
  }
  schedule(value) {
    const text = JSON.stringify(value);
    if (text === this.saved && !this.running) { this.pending = null; clearTimeout(this.timer); this.timer = null; return; }
    this.pending = text;
    if (!this.suspended && !this.timer && !this.running) this.timer = setTimeout(() => this.flush(), this.delay);
  }
  suspend() { this.suspended = true; clearTimeout(this.timer); this.timer = null; }
  resume() { this.suspended = false; this.recovered = false; return this.flush(); }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.running) return this.running;
    if (this.pending == null || this.suspended) return Promise.resolve();
    this.running = (async () => {
      try {
        while (this.pending != null) {
          const text = this.pending; this.pending = null;
          const value = JSON.parse(text), stable = JSON.stringify(stablePreferences(value));
          const write = () => stable === this.stable && Number.isFinite(value.updatedAt) && value.updatedAt > 0
            ? this.position.write({ version: 1, updatedAt: value.updatedAt, state: Object.fromEntries(positionFields.filter(key => key in value).map(key => [key, value[key]])) })
            : this.value.write(value);
          try {
            await retryAfterStorageRecovery(write, async () => {
              if (this.recovered) return 0;
              this.recovered = true; return this.recover();
            });
          } catch (error) { this.pending ??= text; throw error; }
          this.stable = stable; this.saved = text;
        }
      } catch (error) {
        // Read the committed pointer before another write after an uncertain
        // failure; the previous complete value remains available on restart.
        try { await this.value.read(); await this.position.read(); } catch {}
        if (storageWriteRejected(error) || storageUnavailable(error)) this.suspend();
        this.onError(error);
      } finally { this.running = null; }
    })();
    return this.running;
  }
}
