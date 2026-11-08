import { AtomicPhoneValue, storageUnavailable, storageWriteRejected } from './phone-storage.js';
import { mergeReadingEntries } from './reading-activity.js';

// Separate from library/preferences: removing an original never removes events.
export function browserReadingStorage(library) {
  const prefix = 'reading-activity:';
  return {
    async read() {
      const db = await library.open();
      return new Promise((resolve, reject) => {
        const request = db.transaction('data').objectStore('data').getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        request.onsuccess = () => resolve(request.result.flat()); request.onerror = () => reject(request.error);
      });
    },
    async merge(entries) {
      const db = await library.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('data', 'readwrite'), store = tx.objectStore('data');
        for (const entry of entries) {
          const key = `${prefix}${entry.day}:${entry.id}`, request = store.get(key);
          request.onsuccess = () => store.put(mergeReadingEntries(request.result ? [request.result] : [], [entry])[0], key);
        }
        tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error || new Error('Reading history could not be saved.'));
      });
    },
  };
}

export function phoneReadingStorage(kv, { writable = () => true } = {}) {
  const index = new AtomicPhoneValue(kv, 'reading-days');
  const buckets = new Map(), values = new Map(), locations = new Map(); let catalog;
  const bucket = key => { if (!buckets.has(key)) buckets.set(key, new AtomicPhoneValue(kv, `reading-shard:${key}`)); return buckets.get(key); };
  async function load() {
    if (catalog) return;
    const saved = await index.read() || [];
    for (const { day, shards } of saved) for (let i = 0; i < shards; i++) {
      const key = `${day}:${i}`, entries = await bucket(key).read() || [];
      values.set(key, entries); for (const entry of entries) locations.set(entry.id, key);
    }
    catalog = saved;
  }
  return {
    async read() {
      await load(); return [...values.values()].flat();
    },
    async merge(entries) {
      if (!writable()) throw Object.assign(Error('Even storage is unavailable. Keep this page open until history syncs to the desktop.'), { code: 'phone-storage-unavailable' });
      await load();
      const next = structuredClone(catalog), changed = new Map(), locating = new Map(locations);
      for (const entry of entries) {
        let key = locating.get(entry.id), record = next.find(d => d.day === entry.day);
        if (!record) { record = { day: entry.day, shards: 1 }; next.push(record); }
        if (!key) {
          let shard = 0;
          while (shard < record.shards && (changed.get(`${entry.day}:${shard}`) || values.get(`${entry.day}:${shard}`) || []).length >= 64) shard++;
          record.shards = Math.max(record.shards, shard + 1); key = `${entry.day}:${shard}`;
        }
        changed.set(key, mergeReadingEntries(changed.get(key) || values.get(key), [entry])); locating.set(entry.id, key);
      }
      // Small append shards avoid rewriting an entire day's history on the
      // glasses bridge after every page. Discover shards before committing them.
      if (JSON.stringify(next) !== JSON.stringify(catalog)) { await index.write(next); catalog = next; }
      for (const [key, saved] of changed) {
        await bucket(key).write(saved); values.set(key, saved);
        for (const entry of saved) locations.set(entry.id, key);
      }
    },
  };
}

export class ReadingSync {
  constructor({ log, client, scope, sessions, changed = () => {} }) {
    Object.assign(this, { log, client, scope, sessions, changed }); this.synced = new Map();
  }
  async sync() {
    if (this.busy) return this.busy;
    this.busy = this.run().finally(() => { this.busy = null; }); return this.busy;
  }
  async run() {
    try {
      const log = this.log(), client = this.client(), scope = this.scope();
      if (!log || !client || !scope) return;
      const index = await client.api('pageborne/reading-activity', { timeoutMs: 10000 });
      if (index.observations !== 2 && log.entries.some(e => e.version === 2 && e.scope === scope)) {
        this.status = 'Saved on this device · desktop extension needs updating'; this.changed(); return;
      }
      const remote = new Map(index.days.map(day => [day.day, day.revision]));
      const local = log.entries.filter(e => e.scope === scope);
      const days = new Set([...remote.keys(), ...local.map(e => e.day)]);
      for (const day of days) {
        const own = local.filter(e => e.day === day).map(e => ({ ...e, sessions: this.sessions(e) }));
        const signature = JSON.stringify(own), key = `${scope}:${day}`, old = this.synced.get(key);
        if (old?.local === signature && old.remote === remote.get(day)) continue;
        const result = remote.has(day) ? await client.api(`pageborne/reading-activity/${day}`, { timeoutMs: 10000, query: { observations: 2 } }) : { entries: [] };
        const merged = mergeReadingEntries(result.entries, own);
        const byId = new Map(result.entries.map(e => [e.id, JSON.stringify(e)]));
        const upload = merged.filter(e => byId.get(e.id) !== JSON.stringify(e));
        let revision = remote.get(day);
        for (let i = 0; i < upload.length; i += 50) {
          const saved = await client.api(`pageborne/reading-activity/${day}`, { body: { entries: upload.slice(i, i + 50) }, timeoutMs: 10000 });
          revision = saved.revision;
        }
        // A concurrent device can append between our GET and POST. Read back
        // the acknowledged revision so we never mark unseen events as synced.
        const confirmed = upload.length ? await client.api(`pageborne/reading-activity/${day}`, { timeoutMs: 10000, query: { observations: 2 } }) : result;
        if (confirmed.revision) revision = confirmed.revision;
        try { await log.add(mergeReadingEntries(merged, confirmed.entries)); }
        catch (error) { if (!storageUnavailable(error) && !storageWriteRejected(error)) throw error; }

        this.synced.set(key, { local: JSON.stringify(log.entries.filter(e => e.scope === scope && e.day === day).map(e => ({ ...e, sessions: this.sessions(e) }))), remote: revision });
      }
      this.status = log.pending?.size ? 'Synced with desktop · device save unavailable' : 'Synced with desktop';
    } catch (error) {
      this.status = this.log()?.pending?.size ? 'Not saved on this device · keep open until desktop sync succeeds' : error.status === 404 ? 'Saved on this device · desktop extension needs updating' : 'Saved on this device · sync will retry';
    }
    this.changed();
  }
}
