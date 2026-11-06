import { documentReadingWords } from './reading-estimates.js';

export const librarySort = value => ['recent', 'added', 'name', 'time'].includes(value) ? value : 'recent';
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const libraryTimestamp = value => Number.isFinite(value) && value > 0 ? value : 0;
export function recordDocumentOpen(preferences, id, now = Date.now()) {
  preferences.openedAt ||= {};
  preferences.openedAt[id] = now;
  preferences.recent = [id, ...(preferences.recent || []).filter(item => item !== id)].slice(0, 200);
}

// Old installations have only an ordered recent list. Keep that order as a
// tie-breaker; never invent today's timestamps while restoring an old library.
export function orderedDocuments(documents = [], preferences = {}) {
  const order = librarySort(preferences.librarySort);
  const recent = new Map((Array.isArray(preferences.recent) ? preferences.recent : []).map((id, i) => [id, i]));
  return (documents || []).map((doc, index) => ({ doc, index, words: documentReadingWords(doc) ?? Infinity })).sort((a, b) => {
    if (order === 'name') return names.compare(a.doc.id, b.doc.id) || a.index - b.index;
    // Every estimate uses the same WPM, so word count gives exact duration order
    // without rounding to minutes. Unknown counts belong after known readings.
    if (order === 'time') return a.words - b.words || names.compare(a.doc.id, b.doc.id) || a.index - b.index;
    const activity = doc => Math.max(libraryTimestamp(doc.addedAt),
      order === 'recent' ? libraryTimestamp(doc.modifiedAt) : 0,
      order === 'recent' ? libraryTimestamp(preferences.openedAt?.[doc.id]) : 0);
    const time = activity(b.doc) - activity(a.doc);
    if (time) return time;
    if (order === 'recent') {
      const rank = (recent.get(a.doc.id) ?? Infinity) - (recent.get(b.doc.id) ?? Infinity);
      if (rank) return rank;
    }
    return b.index - a.index;
  }).map(({ doc }) => doc);
}
