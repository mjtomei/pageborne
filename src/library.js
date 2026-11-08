import { base64ToBytes, bytesToBase64 } from './binary.js';
import { libraryTimestamp } from './library-order.js';
import { validWordCount } from './reading-estimates.js';
import { readingWords } from './reading-activity.js';
import { parseDocument } from './document.js';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_LIBRARY_BYTES = 1024 * 1024 * 1024;
export const MAX_DOCUMENTS = 1000;
const encoder = new TextEncoder();
export function countWords(text) {
  let words = 0; const pattern = /\S+/g;
  while (pattern.exec(text)) words++;
  return words;
}

// Keep the old database and snapshot key so an upgrade retains downloaded files.
// positionKey preserves bookmarks/positions without depending on a connection.
export function localSnapshot(saved) {
  return { localVersion: 1, documents: (saved?.documents || []).map(doc => ({
    id: doc.id, title: doc.title, ...(typeof doc.content === 'string' ? { content: doc.content } : {}),
    ...(doc.revision ? { revision: doc.revision } : {}),
    ...(doc.sha256 ? { sha256: doc.sha256 } : {}),
    ...(doc.remote ? { remote: { ...doc.remote } } : {}),
    ...(typeof doc.availableOffline === 'boolean' ? { availableOffline: doc.availableOffline } : {}),
    bytes: doc.bytes ?? encoder.encode(doc.content).length,
    words: doc.words ?? countWords(doc.content),
    ...(validWordCount(doc.readingWords) ? { readingWords: doc.readingWords } : {}),
    positionKey: doc.positionKey || `${saved?.server || 'local'}\n${doc.id}`,
    ...(libraryTimestamp(doc.addedAt) ? { addedAt: doc.addedAt } : {}),
    ...(libraryTimestamp(doc.modifiedAt) ? { modifiedAt: doc.modifiedAt } : {}),
    ...(doc.format === 'pdf' ? { format: 'pdf' } : {}),
  })) };
}

export async function readLocalFile(file, onProgress = () => {}, { deferReadingWords = false, signal } = {}) {
  signal?.throwIfAborted();
  if (!/\.(md|markdown|txt|pdf)$/i.test(file.name)) throw new Error('Choose a Markdown, PDF or plain-text file.');
  if (/[\x00-\x1f\x7f/\\]/.test(file.name) || encoder.encode(file.name).length > 220) throw new Error('Choose a file with a shorter, valid filename.');
  const pdf = /\.pdf$/i.test(file.name); const limit = pdf ? MAX_PDF_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) throw new Error(`File exceeds ${pdf ? 16 : 4} MiB.`);
  // Retain a UTF-8 BOM in stored originals so sync does not silently rewrite
  // a desktop file or report an unchanged download as a new phone edit.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const parts = []; let loaded = 0;
  onProgress({ phase: 'reading', loaded, total: file.size });
  for (let offset = 0; offset < file.size; offset += 128 * 1024) {
    signal?.throwIfAborted();
    const bytes = await file.slice(offset, offset + 128 * 1024).arrayBuffer();
    signal?.throwIfAborted();
    loaded += bytes.byteLength;
    if (loaded > limit) throw new Error(`File exceeds ${pdf ? 16 : 4} MiB.`);
    try { parts.push(pdf ? new Uint8Array(bytes) : decoder.decode(bytes, { stream: true })); }
    catch { throw new Error('File is not UTF-8 text.'); }
    onProgress({ phase: 'reading', loaded, total: file.size });
  }
  if (pdf) {
    const bytes = new Uint8Array(loaded); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('File does not contain a PDF header.');
    onProgress({ phase: 'checking' });
    return { id: file.name, title: file.name.replace(/\.pdf$/i, ''), format: 'pdf', content: bytesToBase64(bytes), bytes: loaded, words: 0 };
  }
  try { parts.push(decoder.decode()); }
  catch { throw new Error('File is not UTF-8 text.'); }
  onProgress({ phase: 'checking' });
  const content = parts.join('');
  if (content.includes('\0')) throw new Error('File contains binary data.');
  const title = (!/\.txt$/i.test(file.name) && content.replace(/^\uFEFF/, '').match(/^#{1,6}\s+(.+?)\s*#*\s*$/m)?.[1]) || file.name.replace(/\.[^.]+$/, '');
  // Desktop downloads already carry counts for these exact bytes. Do not parse
  // a whole book on the UI thread merely to recount it before the reader's
  // cancellable background preparation. Missing counts are filled by the reader.
  return { id: file.name, title, content, bytes: loaded, words: countWords(content),
    ...(!deferReadingWords ? { readingWords: parseDocument(content).blocks.reduce((sum, block) => sum + readingWords(block.text), 0) } : {}) };
}

export function addDocument(saved, document) {
  const snapshot = localSnapshot(saved);
  if (snapshot.documents.length >= MAX_DOCUMENTS) throw new Error('Library limit reached (1,000 files). Delete a file first.');
  if (snapshot.documents.reduce((sum, doc) => sum + (doc.remote ? 0 : doc.bytes), 0) + (document.remote ? 0 : document.bytes) > MAX_LIBRARY_BYTES) {
    throw new Error(`Library exceeds ${MAX_LIBRARY_BYTES / 1024 / 1024} MiB. Delete some files first.`);
  }
  const used = new Set(snapshot.documents.map(doc => doc.id));
  const dot = document.id.lastIndexOf('.');
  let id = document.id;
  for (let n = 2; used.has(id); n++) id = `${document.id.slice(0, dot)} (${n})${document.id.slice(dot)}`;
  const added = { ...document, id, positionKey: `local\n${id}`,
    addedAt: libraryTimestamp(document.addedAt) || Date.now() };
  snapshot.documents.push(added);
  return { snapshot, document: added };
}

// Sync replaces a named file atomically, preserving its reading identity.
// A stale snapshot must not overwrite an edit made by another browser tab.
export function replaceDocument(saved, document, expected) {
  const snapshot = localSnapshot(saved), prior = snapshot.documents.find(doc => doc.id === document.id);
  assertDocumentUnchanged(prior, expected);
  const documents = snapshot.documents.filter(doc => doc.id !== document.id);
  const result = addDocument({ documents }, document);
  result.document.positionKey = prior?.positionKey || document.positionKey || `local\n${document.id}`;
  if (prior) {
    // Replacing content is not a new addition, including legacy undated files.
    result.document.addedAt = Math.min(libraryTimestamp(prior.addedAt) || Infinity,
      libraryTimestamp(document.addedAt) || Infinity);
    if (!Number.isFinite(result.document.addedAt)) delete result.document.addedAt;
    result.snapshot.documents = snapshot.documents.map(doc => doc.id === prior.id ? result.document : doc);
  }
  return result;
}
export function updateDocumentMetadata(saved, updates) {
  const snapshot = localSnapshot(saved);
  for (const update of updates) {
    const doc = snapshot.documents.find(doc => doc.id === update.id);
    if (!doc || !sameDocument(doc, update.expected)) continue;
    if (libraryTimestamp(update.addedAt)) doc.addedAt = Math.min(libraryTimestamp(doc.addedAt) || Infinity, update.addedAt);
    if (libraryTimestamp(update.modifiedAt)) doc.modifiedAt = update.modifiedAt;
    if (validWordCount(update.readingWords)) doc.readingWords = update.readingWords;
  }
  return { snapshot };
}
export const updateDocumentDates = updateDocumentMetadata;
export function sameDocument(prior, expected) {
  if (!prior || !expected) return !prior && !expected;
  if (prior.format !== expected.format) return false;
  // A missing body is not evidence that two revisions have the same content.
  if (prior.revision || expected.revision) return !!prior.revision && prior.revision === expected.revision;
  return typeof prior.content === 'string' && prior.content === expected.content;
}
export function assertDocumentUnchanged(prior, expected) {
  if (!sameDocument(prior, expected)) {
    throw new Error('The phone library changed during sync. Sync again to preserve those changes.');
  }
}
export function documentRevision() {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16).padStart(8, '0')).join('');
}
export function documentMetadata({ content, ...meta }) { return meta; }
export async function hashDocument(doc) {
  if (typeof doc.content !== 'string') throw new Error('Load the document before reading its contents.');
  const bytes = doc.format === 'pdf' ? base64ToBytes(doc.content) : encoder.encode(doc.content);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}

export class LocalLibrary {
  async open() {
    if (!this.opening) this.opening = new Promise((resolve, reject) => {
      // Closing old-version connections prevents older tabs from writing the
      // former all-in-one snapshot over the new per-document catalog.
      const request = indexedDB.open('even-reader', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('data')) request.result.createObjectStore('data');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.opening = null; };
        resolve(db);
      };
      request.onerror = () => { this.opening = null; reject(request.error); };
    });
    return this.opening;
  }
  constructor({ lazy = false } = {}) { this.lazy = lazy; }
  async catalog(change = null) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('data', 'readwrite'), store = transaction.objectStore('data');
      let result, failure;
      const request = store.get('snapshot');
      request.onsuccess = () => {
        try {
          const saved = request.result;
          const snapshot = localSnapshot(saved);
          if (saved?.localVersion !== 2) {
            // One atomic upgrade: metadata and per-file records replace the
            // old all-in-one value only when every write succeeds.
            snapshot.documents = snapshot.documents.map(doc => {
              const next = { ...doc, revision: documentRevision() };
              store.put(next.content, `document:${next.id}`);
              return documentMetadata(next);
            });
          }
          result = change ? change(snapshot, store) : { snapshot };
          if (change || saved?.localVersion !== 2) store.put({ ...result.snapshot, localVersion: 2 }, 'snapshot');
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = transaction.onabort = () => reject(failure || transaction.error || new Error('Could not save the library on this phone.'));
    });
  }
  async read() {
    const { snapshot } = await this.catalog();
    if (this.lazy) return snapshot;
    return { ...snapshot, documents: await Promise.all(snapshot.documents.map(doc => this.loadDocument(doc))) };
  }
  async loadDocument(expected, { signal } = {}) {
    signal?.throwIfAborted();
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('data'), store = transaction.objectStore('data');
      let result, failure;
      const request = store.get('snapshot');
      request.onsuccess = () => {
        try {
          signal?.throwIfAborted();
          const meta = request.result?.documents.find(doc => doc.id === expected.id);
          assertDocumentUnchanged(meta, expected);
          const body = store.get(`document:${expected.id}`);
          body.onsuccess = () => {
            if (typeof body.result !== 'string') failure = new Error('Saved document is incomplete. No files were changed.');
            else result = { ...meta, content: body.result };
          };
        } catch (error) { failure = error; transaction.abort(); }
      };
      transaction.oncomplete = () => {
        if (signal?.aborted) reject(signal.reason);
        else if (failure) reject(failure); else resolve(result);
      };
      transaction.onerror = transaction.onabort = () => reject(failure || transaction.error);
    });
  }
  async cacheHash(expected, sha256) {
    return this.catalog(snapshot => {
      const doc = snapshot.documents.find(doc => doc.id === expected.id);
      assertDocumentUnchanged(doc, expected); doc.sha256 = sha256;
      return { snapshot };
    });
  }
  async result(work) {
    const result = await work;
    return this.lazy ? result : { ...result, snapshot: await this.read() };
  }
  async add(file) { return this.save(await readLocalFile(file)); }
  async save(document) {
    const next = { ...document, revision: documentRevision(), sha256: crypto.subtle ? await hashDocument(document) : undefined };
    return this.result(this.catalog((snapshot, store) => {
      const result = addDocument(snapshot, next);
      store.put(next.content, `document:${result.document.id}`);
      result.snapshot.documents = result.snapshot.documents.map(documentMetadata);
      return result;
    }));
  }
  async put(document, expected) {
    const next = { ...document, revision: documentRevision(), sha256: crypto.subtle ? await hashDocument(document) : undefined };
    return this.result(this.catalog((snapshot, store) => {
      const result = replaceDocument(snapshot, next, expected);
      store.put(next.content, `document:${result.document.id}`);
      result.snapshot.documents = result.snapshot.documents.map(documentMetadata);
      return result;
    }));
  }
  async updateDates(updates) { return this.result(this.catalog(snapshot => updateDocumentDates(snapshot, updates))); }
  async updateMetadata(updates) { return this.result(this.catalog(snapshot => updateDocumentMetadata(snapshot, updates))); }
  async remove(id, expected = undefined) {
    return this.result(this.catalog((snapshot, store) => {
      if (expected !== undefined) assertDocumentUnchanged(snapshot.documents.find(doc => doc.id === id), expected);
      store.delete(`document:${id}`);
      return { snapshot: { ...snapshot, documents: snapshot.documents.filter(doc => doc.id !== id) } };
    }));
  }
}
