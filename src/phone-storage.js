import { addDocument, replaceDocument, updateDocumentDates, assertDocumentUnchanged, localSnapshot, documentMetadata, hashDocument, MAX_DOCUMENTS } from './library.js';

export const STORAGE_PREFIX = 'even-reader:phone:v1';
export const CHUNK_CHARS = 32000;
const JOURNAL = `${STORAGE_PREFIX}:pending`;

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
}

export function bridgeStorage(bridge, lane) {
  return {
    async get(key) {
      const value = await lane.run('storage-read', () => bridge.getLocalStorage(key), { quiet: key.startsWith('pageborne:models:v1:') });
      if (typeof value !== 'string') throw new Error('Phone storage is unavailable. Close and reopen the reader.');
      return value;
    },
    async set(key, value) {
      if (await lane.run('storage-write', () => bridge.setLocalStorage(key, value), { quiet: key.startsWith('pageborne:models:v1:') }) !== true) {
        throw new Error('Could not save to phone storage. Free some space and try again.');
      }
    },
  };
}

export class PhoneLibrary {
  constructor(kv, { lazy = false } = {}) {
    this.lazy = lazy; this.kv = kv; this.index = new AtomicPhoneValue(kv, 'library');
    this.catalog = { version: 1, migrated: false, documents: [] };
    this.snapshot = localSnapshot(null); this.tail = Promise.resolve(); this.uncertain = false;
  }
  serialize(work) {
    const result = this.tail.catch(() => {}).then(() => {
      if (this.uncertain) throw new Error('The last phone save could not be confirmed. Close and reopen the reader before changing files.');
      return work();
    });
    // The queue must not retain the last loaded/saved document body.
    this.tail = result.then(() => {}, () => {}); return result;
  }
  async recover() {
    const raw = await this.kv.get(JOURNAL);
    if (!raw) return;
    const ref = JSON.parse(raw); validateDescriptor(ref);
    if (!this.catalog.documents.some(doc => doc.body.prefix === ref.prefix)) {
      for (let i = 0; i < ref.count; i++) await this.kv.set(`${ref.prefix}:${i}`, '');
    }
    await this.kv.set(JOURNAL, '');
  }
  async commit(catalog) {
    try { await this.index.write(catalog); }
    // A timed-out host call could still commit later. Do not start another
    // mutation against an uncertain index; reopening reads the actual pointer.
    catch (error) { this.uncertain = true; throw error; }
    this.catalog = catalog;
  }
  async read(legacy = null, onProgress = () => {}) {
    const saved = await this.index.read();
    if (saved) {
      if (saved.version !== 1 || !Array.isArray(saved.documents) || saved.documents.length > MAX_DOCUMENTS) throw new Error('Saved phone library is invalid. No files were changed.');
      this.catalog = saved;
    }
    const documents = [];
    for (const meta of this.catalog.documents) {
      onProgress(`Opening saved documents (${documents.length + 1}/${this.catalog.documents.length})…`);
      const { body, ...doc } = meta;
      validateDescriptor(body);
      documents.push({ ...doc, revision: body.prefix, ...(this.lazy ? {} : { content: await readChunks(this.kv, body) }) });
    }
    this.snapshot = localSnapshot({ documents });
    await this.recover();
    if (!this.catalog.migrated) {
      const old = localSnapshot(typeof legacy === 'function' ? await legacy() : legacy);
      for (const doc of old.documents) {
        if (this.snapshot.documents.some(saved => saved.id === doc.id)) continue;
        onProgress(`Saving ${doc.id} to phone storage…`);
        await this.save(doc, () => {}, true);
      }
      await this.commit({ ...this.catalog, migrated: true });
    }
    return this.snapshot;
  }
  loadDocument(expected, { signal } = {}) {
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const meta = this.catalog.documents.find(doc => doc.id === expected.id);
      assertDocumentUnchanged(meta && { ...meta, revision: meta.body.prefix }, expected);
      const { body, ...doc } = meta;
      return { ...doc, revision: body.prefix, content: await readChunks(this.kv, body, { signal }) };
    });
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
      await this.commit({ ...this.catalog, documents: this.catalog.documents.map(meta => {
        const { content, ...doc } = result.snapshot.documents.find(doc => doc.id === meta.id);
        return { ...meta, ...doc };
      }) });
      this.snapshot = result.snapshot;
      return result;
    });
  }
  updateMetadata(updates) { return this.updateDates(updates); }
  save(document, onProgress = () => {}, migrating = false, expected = undefined) {
    return this.serialize(async () => {
      await this.recover();
      const old = expected !== undefined ? this.catalog.documents.find(doc => doc.id === document.id) : null;
      const result = expected !== undefined ? replaceDocument(this.snapshot, document, expected) : addDocument(this.snapshot, document);
      if (migrating) {
        result.document.positionKey = document.positionKey;
        if (!document.addedAt) delete result.document.addedAt;
      }
      result.document.sha256 = crypto.subtle ? await hashDocument(result.document) : undefined;
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
      onProgress({ loaded: chunks.length + 1, total: chunks.length + 1 });
      // The index is committed. A failed cleanup must not report this file as
      // unsaved; the journal is retried before the next operation or at boot.
      await this.recover().catch(() => {});
      // The new body/index is committed. Cleanup may be retried at next boot.
      if (old) {
        await this.kv.set(JOURNAL, JSON.stringify(old.body)).then(() => this.recover()).catch(() => {});
      }
      return result;
    });
  }
  remove(id, expected = undefined) {
    return this.serialize(async () => {
      await this.recover();
      if (expected !== undefined) assertDocumentUnchanged(this.snapshot.documents.find(doc => doc.id === id), expected);
      const meta = this.catalog.documents.find(doc => doc.id === id);
      if (!meta) return { snapshot: this.snapshot };
      await this.kv.set(JOURNAL, JSON.stringify(meta.body));
      await this.commit({ ...this.catalog, documents: this.catalog.documents.filter(doc => doc.id !== id) });
      this.snapshot = { ...this.snapshot, documents: this.snapshot.documents.filter(doc => doc.id !== id) };
      await this.recover().catch(() => {});
      return { snapshot: this.snapshot };
    });
  }
}

export class PhonePreferences {
  constructor(kv, onError, delay = 500) {
    this.value = new AtomicPhoneValue(kv, 'preferences'); this.onError = onError; this.delay = delay;
    this.pending = null; this.saved = null; this.running = null; this.timer = null;
  }
  async read(fallback) {
    const saved = await this.value.read();
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
    if (!this.timer && !this.running) this.timer = setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.running) return this.running;
    if (this.pending == null) return Promise.resolve();
    this.running = (async () => {
      try {
        while (this.pending != null) {
          const text = this.pending; this.pending = null;
          await this.value.write(JSON.parse(text)); this.saved = text;
        }
      } catch (error) {
        // Read the committed pointer before another write after an uncertain
        // failure; the previous complete value remains available on restart.
        try { await this.value.read(); } catch {}
        this.onError(error);
      } finally { this.running = null; }
    })();
    return this.running;
  }
}
