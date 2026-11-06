import test from 'node:test';
import assert from 'node:assert/strict';
import { averageReadingSpeed, readingSpeedLabel, documentReadingWords, preparedReadingWords, readingDuration, libraryReadingEstimate } from '../src/reading-estimates.js';
import { localSnapshot, replaceDocument, updateDocumentMetadata } from '../src/library.js';

test('average uses accepted word/time totals, excludes fast paging and invalid samples, and deduplicates sync', () => {
  const accepted = [{ id: 'short', words: 100, seconds: 60 }, { id: 'long', words: 900, seconds: 180 }];
  assert.equal(averageReadingSpeed([...accepted, accepted[0], { words: 100, seconds: 1 }, { words: 1, seconds: 10 },
    { words: 0, seconds: 5 }, { words: NaN, seconds: 1 }, { words: 50, seconds: 0 }]), 250);
  assert.equal(averageReadingSpeed([{ words: 10, seconds: 60 }]), 10);
  assert.equal(averageReadingSpeed([{ words: 900, seconds: 60 }]), 900);
  assert.equal(averageReadingSpeed([]), null);
  assert.match(readingSpeedLabel(null), /No average yet.*200 wpm/);
});
test('full document and library estimates preserve unknown PDFs, zero-word images, and hour rounding', () => {
  const docs = [{ words: 401 }, { format: 'pdf', words: 0 }, { format: 'pdf', readingWords: 0 }];
  assert.equal(documentReadingWords(docs[1]), null);
  assert.deepEqual(libraryReadingEstimate(docs, null), { words: 401, unknown: 1, duration: '3 min' });
  assert.equal(readingDuration(401, 250), '2 min');
  assert.equal(readingDuration(11999, 200), '1 h');
  assert.equal(readingDuration(12001, 200), '1 h 1 min');
  assert.equal(readingDuration(0, 200), '0 min');
  assert.equal(libraryReadingEstimate([docs[1]], 250).duration, '—');
  assert.deepEqual(libraryReadingEstimate([], 250), { words: 0, unknown: 0, duration: '0 min' });
});
test('prepared counts use readable text, join wrapped words, and never treat partial books as complete', () => {
  const layout = { blocks: [
    { text: 'hidden OCR inside figure' },
    { annotationLabel: true, reflow: { rows: [{ text: 'Handwriting label' }] } },
    { reflow: { rows: [{ text: 'A long', start: 0, end: 6 }, { text: 'word.', start: 6, end: 11 }, { text: 'Another line', start: 12, end: 24 }] } },
  ] };
  assert.equal(preparedReadingWords(layout), 4);
  assert.equal(preparedReadingWords({ ...layout, preparation: { complete: false } }), null);
});
test('counts survive catalog reload but cannot attach to a changed document revision', () => {
  const doc = { id: 'book.pdf', format: 'pdf', revision: 'one', words: 0, content: 'data', bytes: 4 };
  const saved = updateDocumentMetadata({ documents: [doc] }, [{ id: doc.id, expected: doc, readingWords: 1234 }]).snapshot;
  assert.equal(localSnapshot(saved).documents[0].readingWords, 1234);
  const replaced = replaceDocument(saved, { ...doc, revision: 'two' }, doc).snapshot;
  assert.equal(documentReadingWords(replaced.documents[0]), null);
  const stale = updateDocumentMetadata(replaced, [{ id: doc.id, expected: doc, readingWords: 9999 }]);
  assert.equal(documentReadingWords(stale.snapshot.documents[0]), null);
});
