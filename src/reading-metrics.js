import { MIN_READING_WPM, MAX_READING_WPM, MAX_VIEW_SECONDS } from './reading-activity.js';
import { readingSessions, readingPaneKey } from './reading-sessions.js';

// Derived data only. Changing these filters never changes the stored log.
const cache = new WeakMap();
export function acceptedReadingEntries(entries = [], filters) {
  if (!filters && cache.has(entries)) return cache.get(entries);
  const { minWpm = MIN_READING_WPM, maxWpm = MAX_READING_WPM, maxViewSeconds = MAX_VIEW_SECONDS,
    maxGapSeconds = 30, minPanes = 2, maxPauseSeconds = MAX_VIEW_SECONDS } = filters || {};
  const result = new Map(), unique = [], seen = new Set();
  const validRate = (words, seconds) => seconds > 0 && words > 0 && 60 * words / seconds >= minWpm && 60 * words / seconds <= maxWpm;
  for (const e of entries) {
    if (e.id && seen.has(e.id)) continue; if (e.id) seen.add(e.id);
    unique.push(e);
  }
  for (const run of readingSessions(unique, maxPauseSeconds)) {
    const live = new Map(), views = new Map(), accepted = new Map();
    for (const e of run) {
      if (e.version !== 2) { if (validRate(e.words, e.seconds)) accepted.set(e.id || e, e); continue; }
      const view = views.get(e.viewId) || { seconds: 0, uncertain: false, words: new Map() };
      view.seconds += e.seconds;
      for (const [key, words] of e.units) view.words.set(key, words);
      view.uncertain ||= e.platform !== 'glasses' && e.maxGapSeconds > maxGapSeconds || e.reason === 'layout';
      views.set(e.viewId, view);
    }
    const finish = key => {
      const u = live.get(key); live.delete(key);
      if (u.excluded || !validRate(u.words, u.seconds)) return;
      for (const [e, seconds] of u.parts) {
        if (!seconds) continue;
        let out = accepted.get(e.id);
        if (!out) { out = { ...e, words: 0, seconds: 0 }; accepted.set(e.id, out); }
        out.words += u.words * seconds / u.seconds; out.seconds += seconds;
      }
    };
    for (const e of run) {
      if (e.version !== 2) continue;
      const next = new Set(e.units.map(u => u[0]));
      for (const key of live.keys()) if (!next.has(key)) finish(key);
      const view = views.get(e.viewId), excluded = view.uncertain || view.seconds > maxViewSeconds;
      for (const [key, words, seconds] of e.units) {
        const u = live.get(key) || { words, seconds: 0, parts: [], excluded: false };
        u.seconds += seconds; u.excluded ||= excluded; u.parts.push([e, seconds]); live.set(key, u);
      }
    }
    for (const key of live.keys()) finish(key);
    const readableViews = new Set([...views].filter(([, view]) =>
      validRate([...view.words.values()].reduce((n, words) => n + words, 0), view.seconds)).map(([key]) => key));
    // Briefly showing an overlapping pane can inherit some accepted words from
    // the previous pane; it must still have its own plausible reading dwell.
    const panes = new Set([...accepted.values()].filter(e => e.version !== 2 || readableViews.has(e.viewId)).map(readingPaneKey));
    if (panes.size >= minPanes) for (const [key, entry] of accepted) result.set(key, entry);
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
