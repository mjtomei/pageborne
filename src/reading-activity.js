// Reading estimates, not eye tracking. Time is shared between the words on
// screen; overlapping windows retain their share until those words leave.
export const MIN_READING_WPM = 10, MAX_READING_WPM = 900, MAX_VIEW_SECONDS = 300;
export const readingDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const readingWords = text => (String(text || '').match(/\S*[\p{L}\p{N}]\S*/gu) || []).length;

export class ReadingTracker {
  constructor(record, { clock = () => performance.now(), date = () => new Date(), id = () => crypto.randomUUID() } = {}) {
    Object.assign(this, { record, clock, date, id }); this.units = new Map();
  }
  accrue(now) {
    const elapsed = this.last == null ? 0 : (now - this.last) / 1000;
    this.last = now;
    // Accepted glasses text remains readable while phone timers are delayed.
    // Web timer suspension does not establish attention. A stable view left
    // unattended for five minutes is discarded, including its earlier dwell.
    if (!this.visible || elapsed <= 0) return;
    this.dwell += elapsed;
    if (this.dwell > MAX_VIEW_SECONDS || elapsed > 30 && this.units.values().next().value?.view.platform !== 'glasses') {
      for (const unit of this.units.values()) unit.expired = true;
      return;
    }
    const total = [...this.units.values()].reduce((sum, unit) => sum + unit.words, 0);
    if (!total) return;
    const end = this.date().getTime(); let start = end - elapsed * 1000;
    while (start < end) {
      const date = new Date(start), midnight = new Date(date); midnight.setHours(24, 0, 0, 0);
      const until = Math.min(end, midnight.getTime()), day = readingDay(date), seconds = (until - start) / 1000;
      for (const unit of this.units.values()) unit.time[day] = (unit.time[day] || 0) + seconds * unit.words / total;
      start = until;
    }
  }
  observe(view, now = this.clock()) {
    this.accrue(now);
    if (!view) { this.visible = false; return; }
    const identity = `${view.scope || ''}\n${view.document.key}\n${view.document.revision || ''}`;
    if (this.identity !== identity) { this.finish(); this.identity = identity; }
    const next = new Map(view.units.filter(u => u.words > 0).map(u => [u.key, u]));
    const departed = [...this.units.values()].filter(u => !next.has(u.key));
    this.emit(departed);
    for (const unit of departed) this.units.delete(unit.key);
    if (departed.length || next.size !== this.units.size) this.dwell = 0;
    for (const [key, unit] of next) if (!this.units.has(key)) this.units.set(key, { ...unit, time: {}, at: this.date().toISOString(), view });
    this.visible = true; this.last = now; this.dwell ||= 0;
  }
  emit(units) {
    const eligible = units.filter(u => {
      const seconds = Object.values(u.time).reduce((a, b) => a + b, 0), wpm = 60 * u.words / seconds;
      return !u.expired && seconds > 0 && wpm >= MIN_READING_WPM && wpm <= MAX_READING_WPM;
    });
    const days = new Set(eligible.flatMap(u => Object.keys(u.time)));
    for (const day of days) {
      const parts = eligible.filter(u => u.time[day] > 0);
      const first = parts[0], view = first.view;
      const words = parts.reduce((sum, u) => sum + u.words * u.time[day] / Object.values(u.time).reduce((a, b) => a + b, 0), 0);
      const seconds = parts.reduce((sum, u) => sum + u.time[day], 0);
      this.record({ id: this.id(), day, at: first.at, endedAt: this.date().toISOString(),
        words, seconds, document: view.document, scope: view.scope || '', platform: view.platform,
        position: view.position || 0, ...(first.page ? { page: first.page } : {}),
        excerpt: parts.map(u => u.text).join(' ').slice(0, 240), sessions: view.sessions || [] });
    }
  }
  finish() { this.emit([...this.units.values()]); this.reset(); }
  leave(now = this.clock()) { this.accrue(now); this.finish(); }
  reset() { this.units.clear(); this.visible = false; this.last = null; this.identity = null; this.dwell = 0; }
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
