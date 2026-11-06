import { MIN_READING_WPM, MAX_READING_WPM, MAX_VIEW_SECONDS } from './reading-activity.js';

// Derived data only. Changing these filters never changes the stored log.
const cache = new WeakMap();
export function acceptedReadingEntries(entries = [], filters) {
  if (!filters && cache.has(entries)) return cache.get(entries);
  const { minWpm = MIN_READING_WPM, maxWpm = MAX_READING_WPM, maxViewSeconds = MAX_VIEW_SECONDS, maxGapSeconds = 30 } = filters || {};
  const result = new Map(), runs = new Map(), views = new Map(), seen = new Set();
  const validRate = (words, seconds) => seconds > 0 && words > 0 && 60 * words / seconds >= minWpm && 60 * words / seconds <= maxWpm;
  for (const e of entries) {
    if (e.id && seen.has(e.id)) continue; if (e.id) seen.add(e.id);
    if (e.version !== 2) { if (validRate(e.words, e.seconds)) result.set(e.id || e, e); continue; }
    const runKey = `${e.scope}:${e.kind}:${e.document.key}:${e.run}`;
    if (!runs.has(runKey)) runs.set(runKey, []); runs.get(runKey).push(e);
    const key = `${runKey}:${e.viewId}`, view = views.get(key) || { seconds: 0, uncertain: false };
    view.seconds += e.seconds;
    view.uncertain ||= e.platform !== 'glasses' && e.maxGapSeconds > maxGapSeconds || e.reason === 'layout';
    views.set(key, view);
  }
  for (const [runKey, run] of runs) {
    const live = new Map();
    const finish = key => {
      const u = live.get(key); live.delete(key);
      if (u.excluded || !validRate(u.words, u.seconds)) return;
      for (const [e, seconds] of u.parts) {
        if (!seconds) continue;
        let out = result.get(e.id);
        if (!out) { out = { ...e, words: 0, seconds: 0 }; result.set(e.id, out); }
        out.words += u.words * seconds / u.seconds; out.seconds += seconds;
      }
    };
    for (const e of run.sort((a, b) => a.at.localeCompare(b.at) || a.endedAt.localeCompare(b.endedAt))) {
      const next = new Set(e.units.map(u => u[0]));
      for (const key of live.keys()) if (!next.has(key)) finish(key);
      const view = views.get(`${runKey}:${e.viewId}`), excluded = view.uncertain || view.seconds > maxViewSeconds;
      for (const [key, words, seconds] of e.units) {
        const u = live.get(key) || { words, seconds: 0, parts: [], excluded: false };
        u.seconds += seconds; u.excluded ||= excluded; u.parts.push([e, seconds]); live.set(key, u);
      }
    }
    for (const key of live.keys()) finish(key);
  }
  const accepted = [...result.values()];
  if (!filters) cache.set(entries, accepted);
  return accepted;
}

export function readingTotals(entries, { includeAsk = false, kind, day } = {}) {
  let words = 0, seconds = 0;
  for (const e of acceptedReadingEntries(entries)) {
    const source = e.kind || 'document';
    if (day && e.day !== day) continue;
    if (kind ? source !== kind : !includeAsk && source === 'ask') continue;
    words += e.words; seconds += e.seconds;
  }
  return { words, seconds, wpm: seconds ? 60 * words / seconds : null };
}
