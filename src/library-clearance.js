import { acceptedReadingEntries } from './reading-metrics.js';
import { documentReadingWords, validWordCount } from './reading-estimates.js';

export const CLEARANCE_DAYS = 30;
const DAY = 86400000;
export function validLibraryActivity(value) {
  return value?.version === 1 && typeof value.libraryId === 'string' && Number.isFinite(value.startedAt)
    && Array.isArray(value.events) && value.events.every(event => typeof event.id === 'string'
      && ['added', 'deleted'].includes(event.kind) && Number.isFinite(event.at)
      && typeof event.document?.name === 'string' && (event.document.sha256 === null || typeof event.document.sha256 === 'string')
      && Number.isFinite(event.document.addedAt) && (event.document.words === null || validWordCount(event.document.words)));
}
export function libraryClearance({ documents = [], entries = [], activity, removals = [], scope = '', endpoint = '', now = Date.now() } = {}) {
  const since = now - CLEARANCE_DAYS * DAY;
  const events = new Map((activity?.events || []).map(event => [event.id, event]));
  let pending = 0;
  for (const event of removals) {
    if (event.endpoint && event.endpoint !== endpoint || event.libraryId && activity?.libraryId && event.libraryId !== activity.libraryId) continue;
    const acknowledged = [...events.values()].some(saved => saved.kind === 'deleted' && (saved.operationId === event.id
      || saved.document.name === event.document.name && saved.document.sha256 === event.document.sha256
        && Math.abs(saved.document.addedAt - event.document.addedAt) < 1));
    if (!acknowledged) { events.set(event.id, event); if (event.at >= since && event.at <= now) pending++; }
  }
  // Locally imported texts contribute before their first sync. Downloaded
  // catalog entries inherit the desktop addition date and are not new additions.
  for (const doc of documents) if (!doc.remote && doc.addedAt >= since && doc.addedAt <= now) {
    const known = [...events.values()].some(event => event.kind === 'added' && event.document.name === doc.id
      && (Math.abs(event.at - doc.addedAt) < 1 || doc.sha256 && event.document.sha256 === doc.sha256));
    if (!known) events.set(`local-add:${doc.id}:${doc.addedAt}`, { kind: 'added', at: doc.addedAt,
      document: { name: doc.id, words: documentReadingWords(doc) } });
  }
  // A locally added-then-deleted text is no longer in documents.
  for (const event of removals) if (!event.libraryId && !event.endpoint && event.document.addedAt >= since
    && ![...events.values()].some(saved => saved.kind === 'added' && saved.document.name === event.document.name
      && Math.abs(saved.at - event.document.addedAt) < 1)) {
    events.set(`local-add:${event.id}`, { kind: 'added', at: event.document.addedAt, document: event.document });
  }
  const recent = [...events.values()].filter(event => event.at >= since && event.at <= now);
  const deleted = recent.filter(event => event.kind === 'deleted');
  const added = recent.filter(event => event.kind === 'added');
  let readWords = 0;
  for (const entry of acceptedReadingEntries(entries)) {
    const at = Date.parse(entry.at);
    if (entry.kind === 'ask' || (entry.scope || '') !== scope || at < since || at > now || !Number.isFinite(at)) continue;
    // Once a deletion has a full count it replaces reading from that
    // incarnation. Until then, retain the reading words we already know.
    if (deleted.some(event => event.document.words !== null && event.document.name === entry.document.id
      && at >= event.document.addedAt && at <= event.at)) continue;
    readWords += entry.words;
  }
  const sum = values => values.reduce((n, item) => n + (item.document.words ?? 0), 0);
  const deletedWords = sum(deleted), addedWords = sum(added), clearedWords = readWords + deletedWords;
  const missingDeleted = deleted.filter(event => event.document.words === null).length;
  const missingAdded = added.filter(event => event.document.words === null).length;
  const words = documents.reduce((n, doc) => n + (documentReadingWords(doc) ?? 0), 0);
  const missingCurrent = documents.filter(doc => documentReadingWords(doc) === null).length;
  const available = !!activity, wordsPerDay = clearedWords / CLEARANCE_DAYS;
  return { available, pending, readWords, deletedWords, addedWords, clearedWords, wordsPerDay,
    missingDeleted, missingAdded, missingCurrent,
    daysPartial: missingCurrent + missingDeleted > 0,
    ratioPartial: missingAdded + missingDeleted > 0,
    preliminary: !activity || activity.startedAt > since,
    // Pending counts contribute nothing yet, without hiding known totals.
    // An entirely uncounted library must not look like an empty one.
    days: available && (words > 0 || !missingCurrent) ? words === 0 ? 0 : clearedWords > 0 ? words * CLEARANCE_DAYS / clearedWords : null : null,
    ratio: available && clearedWords > 0 ? addedWords / clearedWords : null };
}
