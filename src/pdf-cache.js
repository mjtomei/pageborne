import { AtomicPhoneValue, STORAGE_PREFIX, chunksOf, descriptor, readChunks, validateDescriptor } from './phone-storage.js';
import { preparePdfNative } from './pdf-native.js';
import { pdfPageTurn } from './pdf-layout.js';
import { MAX_PDF_PAGES } from './pdf-limits.js';

// Increment only when preparation geometry/recognition changes, not on every
// app release. The full source hash and every PDF formatting option also match.
export const PDF_PREPARATION_VERSION = 19;
export async function pdfPreparationKey(bytes, options, pdfjsVersion) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return JSON.stringify([PDF_PREPARATION_VERSION, pdfjsVersion,
    Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join(''), options]);
}

export function packPdfPreparation(layout, marginMasks, pageScales) {
  if (layout.preparation?.complete === false) throw new Error('PDF preparation is still incomplete.');
  const { blocks, headings, blockY, lineStarts, height, maxY, pages, size, annotations = [], navigation, reflowSanity } = layout;
  return { version: PDF_PREPARATION_VERSION, marginMasks: [...marginMasks], pageScales: [...pageScales],
    layout: { blocks: blocks.map(block => ({ ...block, ...(block.reflow ? { reflow: { ...block.reflow,
      rows: block.reflow.rows.map(({ items, ...row }) => row) } } : {}) })), headings, blockY, lineStarts, height, maxY, pages, size, annotations,
      ...(navigation ? { navigation } : {}), ...(reflowSanity ? { reflowSanity } : {}) } };
}
export function validatePdfPreparation(saved) {
  const layout = saved?.layout;
  const positive = n => Number.isFinite(n) && n > 0;
  const positions = xs => Array.isArray(xs) && xs.every((n, i) => Number.isFinite(n) && n >= 0 && (!i || n >= xs[i - 1]));
  const validTurn = block => !block.turn || ([90,270].includes(block.turn) && [0,90,180,270].includes(block.pageRotation)
    && Array.isArray(block.sourceTransform) && block.sourceTransform.length === 6 && block.sourceTransform.every(Number.isFinite)
    && Math.abs(block.sourceTransform[0]*block.sourceTransform[3]-block.sourceTransform[1]*block.sourceTransform[2]) > 1e-8);
  if (saved?.version !== PDF_PREPARATION_VERSION || !layout || !positive(layout.height) || layout.height > 50_000_000
    || !Number.isFinite(layout.maxY) || layout.maxY < 0 || layout.maxY > layout.height
    || !positions(layout.pages) || layout.pages[0] !== 0 || !Array.isArray(layout.blockY) || !layout.blockY.every(n => Number.isFinite(n) && n >= 0) || !positions(layout.lineStarts)
    || !Array.isArray(layout.headings) || !Array.isArray(layout.blocks) || !layout.blocks.length
    || !Array.isArray(saved.marginMasks) || !Array.isArray(saved.pageScales) || !saved.pageScales.length
    || !saved.pageScales.every(([page, scale]) => Number.isInteger(page) && page > 0 && page <= MAX_PDF_PAGES && positive(scale))
    || !layout.blocks.every(block => positive(block.width) && positive(block.height) && positive(block.scale) && positive(block.drawHeight)
      && Number.isFinite(block.x) && Number.isFinite(block.y) && Number.isFinite(block.sourceY)
      && saved.pageScales.some(([page]) => page === block.page) && typeof block.text === 'string' && Array.isArray(block.lines)
      && validTurn(block)
      && (!block.originalPage || (block.digitizationCredit === true && positive(block.originalPage.width) && positive(block.originalPage.height)))
      && (!block.reflow || (positive(block.reflow.fontSize) && positive(block.reflow.lineHeight)
        && Array.isArray(block.reflow.rows) && block.reflow.rows.every(row => typeof row.text === 'string' && Number.isFinite(row.y)))))) {
    throw new Error('Saved PDF preparation is incomplete.');
  }
  const annotations = layout.annotations ?? [];
  if (!Array.isArray(annotations) || !annotations.every(block => block.annotation?.kind === 'handwriting'
    && positive(block.width) && positive(block.height) && positive(block.scale) && positive(block.drawHeight)
    && [block.x, block.y, block.sourceY].every(Number.isFinite) && validTurn(block) && saved.pageScales.some(([page]) => page === block.page))) {
    throw new Error('Saved PDF annotations are incomplete.');
  }
}
export function unpackPdfPreparation(saved) {
  validatePdfPreparation(saved);
  const layout = saved.layout;
  layout.format = 'pdf'; layout.rows = [];
  layout.annotations ||= [];
  for (let y = 0; y < layout.height; y += 27) layout.rows.push({ y, height: 27 });
  preparePdfNative(layout); // Restore derived runs, including their Infinity endpoints.
  // Page boundaries are cheap derived data: update old overlap behavior without
  // invalidating the prepared text, figures or OCR in the cache.
  layout.pages = [0];
  while (layout.pages.at(-1) < layout.maxY) layout.pages.push(pdfPageTurn(layout, layout.pages.at(-1), 1));
  return { layout, marginMasks: new Map(saved.marginMasks), pageScales: new Map(saved.pageScales), desktopEngine: saved.desktopEngine };
}

// Use the same durable SDK storage as original files on the phone; IndexedDB
// backs this adapter in a standalone browser. Never rely on WebView storage.
export function browserPdfStorage(library) {
  return {
    async get(key) {
      const db = await library.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('data').objectStore('data').get(key);
        request.onsuccess = () => resolve(request.result || ''); request.onerror = () => reject(request.error);
      });
    },
    async set(key, value) {
      const db = await library.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('data', 'readwrite');
        if (value) tx.objectStore('data').put(value, key); else tx.objectStore('data').delete(key);
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error);
      });
    },
  };
}

const PREFIX = `${STORAGE_PREFIX}:pdf-cache`;
const JOURNAL = `${PREFIX}:pending`;
export class PdfPreparationCache {
  constructor(kv, { maxChars = 16 * 1024 * 1024, maxEntryChars = Infinity } = {}) {
    this.kv = kv; this.maxChars = maxChars; this.maxEntryChars = maxEntryChars;
    this.index = new AtomicPhoneValue(kv, 'pdf-cache:index'); this.tail = Promise.resolve(); this.generations = new Map(); this.epoch = 0;
  }
  serialize(fn) { const task = this.tail.catch(() => {}).then(fn); this.tail = task.then(() => {}, () => {}); return task; }
  async recover() {
    // Reload the committed pointer even after a failed/uncertain write.
    this.entries = (await this.index.read())?.entries || [];
    const raw = await this.kv.get(JOURNAL);
    if (!raw) return;
    const bodies = JSON.parse(raw);
    for (const body of bodies) {
      if (!body.prefix?.startsWith(`${PREFIX}:body:`)) throw new Error('Invalid PDF cache journal.');
      validateDescriptor(body, { largeValue: true });
      if (this.entries.some(entry => entry.body.prefix === body.prefix)) continue;
      for (let i = 0; i < body.count; i++) await this.kv.set(`${body.prefix}:${i}`, '');
    }
    await this.kv.set(JOURNAL, '');
  }
  forDocument(id) {
    const generation = this.generations.get(id) || 0;
    const epoch = this.epoch;
    const current = () => epoch === this.epoch && generation === (this.generations.get(id) || 0);
    return {
      read: key => this.serialize(async () => {
        await this.recover();
        if (!current()) return null;
        const entry = this.entries.find(entry => entry.id === id && entry.key === key);
        return entry ? JSON.parse(await readChunks(this.kv, entry.body, { largeValue: true })) : null;
      }),
      write: (key, value, alive = () => true) => this.serialize(async () => {
        await this.recover();
        if (!current() || !alive()) return false;
        const text = JSON.stringify(value);
        if (text.length > this.maxEntryChars) throw new Error('Prepared PDF exceeds the cache size limit.');
        const chunks = chunksOf(text);
        const body = descriptor(`${PREFIX}:body:${crypto.randomUUID()}`, text, chunks);
        let entries = this.entries.filter(entry => entry.id !== id);
        // The total is an eviction target, not a book-size restriction. A
        // larger current book occupies the cache alone and still works offline.
        while (entries.length && entries.reduce((n, entry) => n + entry.body.length, text.length) > this.maxChars) entries.shift();
        const discarded = this.entries.filter(entry => !entries.includes(entry)).map(entry => entry.body);
        await this.kv.set(JOURNAL, JSON.stringify([body, ...discarded]));
        for (let i = 0; i < chunks.length; i++) {
          if (!current() || !alive()) { await this.recover(); return false; }
          await this.kv.set(`${body.prefix}:${i}`, chunks[i]);
        }
        if (!current() || !alive()) { await this.recover(); return false; }
        await this.index.write({ entries: [...entries, { id, key, body }] });
        await this.recover().catch(() => {}); // A committed cache survives interrupted cleanup.
        return true;
      }),
    };
  }
  clear() {
    this.epoch++;
    return this.serialize(async () => {
      // At quota, even writing an empty replacement index can fail. Reclaim
      // disposable bodies first using the existing index/journal as the resume
      // record. Originals, preferences, voice weights and reading logs are in
      // separate namespaces and must never be targets of this operation.
      const entries = (await this.index.read())?.entries || [];
      const journal = await this.kv.get(JOURNAL);
      const pending = JSON.parse(journal || '[]');
      if (!Array.isArray(entries) || !Array.isArray(pending)) throw new Error('Invalid PDF cache index. No files were changed.');
      const bodies = [...entries.map(entry => entry.body), ...pending];
      for (const body of bodies) {
        validateDescriptor(body, { largeValue: true });
        if (!body.prefix.startsWith(`${PREFIX}:body:`) || !/^[\w-]+$/.test(body.prefix.slice(`${PREFIX}:body:`.length))) {
          throw new Error('Invalid PDF cache entry. No files were changed.');
        }
      }
      let cleared = 0;
      const seen = new Set();
      for (const body of bodies) {
        for (let i = 0; i < body.count; i++) {
          const key = `${body.prefix}:${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const value = await this.kv.get(key);
          if (value) { await this.kv.set(key, ''); cleared += value.length; }
        }
      }
      // Clearing the journal before the pointer is safe: all pending bodies
      // are already gone. An interruption leaves the committed list to retry.
      if (journal) await this.kv.set(JOURNAL, '');
      if (this.index.head) await this.kv.set(this.index.key, '');
      this.index.head = null; this.entries = [];
      return cleared;
    });
  }
  remove(id) {
    this.generations.set(id, (this.generations.get(id) || 0) + 1);
    return this.serialize(async () => {
      await this.recover();
      const removed = this.entries.filter(entry => entry.id === id);
      if (!removed.length) return;
      await this.kv.set(JOURNAL, JSON.stringify(removed.map(entry => entry.body)));
      await this.index.write({ entries: this.entries.filter(entry => entry.id !== id) });
      await this.recover();
    });
  }
  async retain(ids) {
    const stale = await this.serialize(async () => { await this.recover(); return this.entries.filter(entry => !ids.includes(entry.id)).map(entry => entry.id); });
    for (const id of stale) await this.remove(id);
  }
}
