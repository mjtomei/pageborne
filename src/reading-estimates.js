import { readingWords } from './reading-activity.js';

import { readingTotals } from './reading-metrics.js';

export const DEFAULT_READING_WPM = 200;
export const validWordCount = value => Number.isSafeInteger(value) && value >= 0;

// Use the same accepted document-reading events as the daily word count.
// Weight by time, rather than giving a three-word heading a whole page's vote.
export function averageReadingSpeed(entries = [], options) {
  return readingTotals(entries, options).wpm;
}
export const readingSpeedLabel = average => average == null
  ? `No average yet · estimates use ${DEFAULT_READING_WPM} wpm`
  : `Your average: ${Math.round(average).toLocaleString()} wpm`;

export function documentReadingWords(doc) {
  if (validWordCount(doc.readingWords)) return doc.readingWords;
  // A PDF's legacy words:0 means unprocessed, not an empty document.
  return doc.format !== 'pdf' && validWordCount(doc.words) ? doc.words : null;
}
export function preparedReadingWords(layout) {
  if (!layout?.blocks || layout.preparation?.complete === false) return null;
  let words = 0;
  for (const block of layout.blocks) {
    if (!block.reflow || block.annotation || block.annotationLabel) continue;
    let text = '', previous;
    for (const row of block.reflow.rows) {
      if (text && (!previous || row.label || previous.label || row.start !== previous.end)) text += ' ';
      text += row.text; previous = row;
    }
    words += readingWords(text);
  }
  return words;
}
export function readingDuration(words, average) {
  if (words == null) return '—';
  const minutes = Math.ceil(words / (average || DEFAULT_READING_WPM));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}
export function libraryReadingEstimate(documents, average) {
  let words = 0, unknown = 0;
  for (const doc of documents) {
    const count = documentReadingWords(doc);
    if (count == null) unknown++; else words += count;
  }
  return { words, unknown, duration: readingDuration(unknown === documents.length && unknown ? null : words, average) };
}
