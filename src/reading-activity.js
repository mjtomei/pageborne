// Reading estimates, not eye tracking. Time is shared between the words on
// screen; overlapping windows retain their share until those words leave.
export const MIN_READING_WPM = 10, MAX_READING_WPM = 900, MAX_VIEW_SECONDS = 300;
export const readingDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const readingWords = text => (String(text || '').match(/\S*[\p{L}\p{N}]\S*/gu) || []).length;

// Store observations before applying any reading-speed/idle filter. Each raw
// pane retains per-word exposure, so overlapping windows can be re-evaluated
// without counting their shared words twice. A pause ends an exposure interval.
// Compact word identities avoid copying long URLs or command arguments into
// every view record. This hash is only a local identity, not a security hash.
export function readingUnitKey(prefix, offset, word) {
  let hash = 2166136261;
  for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619);
  return `${prefix}:${offset}:${word.length}:${hash >>> 0}`;
}

export class ReadingTracker {
  constructor(record, { clock = () => performance.now(), date = () => new Date(), id = () => crypto.randomUUID() } = {}) {
    Object.assign(this, { record, clock, date, id }); this.units = new Map();
  }
  start(view, at) {
    this.pane = { id: this.id(), version: 2, kind: view.kind || 'document', run: this.run, viewId: this.viewId,
      day: readingDay(new Date(at)), at, endedAt: at, words: 0, seconds: 0, maxGapSeconds: 0,
      document: { ...view.document }, scope: view.scope || '', platform: view.platform,
      position: view.position || 0, ...(view.page ? { page: view.page } : {}),
      excerpt: view.units.map(u => u.text || '').join(' ').slice(0, 240), sessions: view.sessions || [] };
    this.exposures = new Map();
    this.includeUnits();
  }
  includeUnits() {
    for (const u of this.units.values()) if (!this.exposures.has(u.key)) this.exposures.set(u.key, [u.key, u.words, 0]);
  }
  accrue(now) {
    const elapsed = this.last == null ? 0 : Math.max(0, (now - this.last) / 1000); this.last = now;
    if (!this.pane || !elapsed) return;
    const end = this.date().getTime(); let start = end - elapsed * 1000;
    const total = [...this.units.values()].reduce((n, u) => n + u.words, 0);
    while (start < end) {
      if (this.pane.day !== readingDay(new Date(start))) { this.emit('midnight'); this.start(this.view, new Date(start).toISOString()); }
      const midnight = new Date(start); midnight.setHours(24, 0, 0, 0);
      const until = Math.min(end, midnight.getTime()), seconds = (until - start) / 1000;
      this.pane.seconds += seconds; this.pane.maxGapSeconds = Math.max(this.pane.maxGapSeconds, elapsed);
      for (const u of this.units.values()) this.exposures.get(u.key)[2] += total ? seconds * u.words / total : 0;
      this.pane.endedAt = new Date(until).toISOString();
      if (until < end) { this.emit('midnight'); this.start(this.view, new Date(until).toISOString()); }
      start = until;
    }
  }
  observe(view, now = this.clock()) {
    this.accrue(now);
    if (!view) { this.emit('pause'); return; }
    const identity = `${view.kind || 'document'}\n${view.scope || ''}\n${view.document.key}\n${view.document.revision || ''}\n${view.platform}\n${view.surface || ''}`;
    const paneKey = String(view.pane ?? view.position ?? 0);
    if (this.identity !== identity) { this.emit('source'); this.run = this.id(); this.identity = identity; this.paneKey = null; }
    if (this.paneKey !== paneKey) { this.emit('page'); this.viewId = this.id(); this.paneKey = paneKey; }
    this.view = view;
    this.units = new Map(view.units.filter(u => u.words > 0).map(u => [u.key, u]));
    if (!this.pane) this.start(view, this.date().toISOString()); else this.includeUnits();
    this.last = now;
  }
  emit(reason) {
    if (!this.pane) return;
    const units = [...this.exposures.values()];
    this.record({ ...this.pane, words: units.reduce((n, u) => n + u[1], 0), units, reason });
    this.pane = null;
  }
  finish(reason = 'leave') { this.emit(reason); this.units.clear(); this.last = null; this.identity = null; this.paneKey = null; }
  leave(now = this.clock(), reason = 'leave') { this.accrue(now); this.finish(reason); }
  reset() { this.leave(this.clock(), 'layout'); }
}

export function mergeReadingEntries(previous = [], incoming = []) {
  const entries = new Map(previous.map(entry => [entry.id, entry]));
  for (const entry of incoming) {
    const old = entries.get(entry.id);
    // Events are immutable except for discovering a conversation later.
    const sessions = new Map([...(old?.sessions || []), ...(entry.sessions || [])].map(s => [`${s.agent}:${s.id}`, s]));
    entries.set(entry.id, { ...(old || entry), sessions: [...sessions.values()] });
  }
  return [...entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export class ReadingLog {
  constructor(storage, changed = () => {}) { this.storage = storage; this.changed = changed; this.entries = []; this.pending = new Map(); this.queue = Promise.resolve(); }
  async load() { this.entries = await this.storage.read(); this.changed(); }
  add(entries) {
    const previous = new Map(this.entries.map(e => [e.id, e]));
    this.entries = mergeReadingEntries(this.entries, entries); this.changed();
    const ids = new Set(entries.map(e => e.id));
    for (const entry of this.entries) if (ids.has(entry.id) && JSON.stringify(previous.get(entry.id)) !== JSON.stringify(entry)) this.pending.set(entry.id, entry);
    return this.flush();
  }
  flush() {
    const work = this.queue.catch(() => {}).then(async () => {
      const entries = [...this.pending.values()]; if (!entries.length) return;
      // Merge against durable state, including writes by another browser tab.
      await this.storage.merge(entries);
      for (const entry of entries) if (this.pending.get(entry.id) === entry) this.pending.delete(entry.id);
    });
    this.queue = work; return work;
  }
}
