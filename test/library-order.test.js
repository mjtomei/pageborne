import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedDocuments, recordDocumentOpen } from '../src/library-order.js';
import { addDocument, replaceDocument, localSnapshot, updateDocumentDates } from '../src/library.js';

const ids = (docs, prefs) => orderedDocuments(docs, prefs).map(doc => doc.id);
test('recent activity interleaves additions, modifications and explicit opens', () => {
  const docs = [{ id: 'older.md', addedAt: 10 }, { id: 'new.pdf', addedAt: 30, modifiedAt: 1 }];
  const prefs = {}; recordDocumentOpen(prefs, 'older.md', 20);
  assert.deepEqual(ids(docs, prefs), ['new.pdf', 'older.md']);
  recordDocumentOpen(prefs, 'older.md', 40);
  assert.deepEqual(ids(docs, prefs), ['older.md', 'new.pdf']);
  docs[1].modifiedAt = 50;
  assert.deepEqual(ids(docs, prefs), ['new.pdf', 'older.md']);
  assert.deepEqual(ids(docs, { ...prefs, librarySort: 'added' }), ['new.pdf', 'older.md']);
});
test('legacy undated files keep stable order without fabricated current timestamps', () => {
  const docs = [{ id: 'chapter10.md' }, { id: 'chapter2.md' }, { id: 'last.md' }];
  assert.deepEqual(ids(docs, { recent: ['chapter10.md'] }), ['chapter10.md', 'last.md', 'chapter2.md']);
  assert.deepEqual(ids(docs, { librarySort: 'name' }), ['chapter2.md', 'chapter10.md', 'last.md']);
  assert.deepEqual(localSnapshot({ documents: docs }).documents.map(d => d.addedAt), [undefined, undefined, undefined]);
});
test('reading time orders known text lengths first, including zero, and updates when PDF counts arrive', () => {
  const docs = [
    { id: 'chapter10.pdf', format: 'pdf', words: 0 },
    { id: 'long.md', words: 500 },
    { id: 'chapter2.pdf', format: 'pdf', words: 0 },
    { id: 'short.txt', words: 100 },
    { id: 'empty.pdf', format: 'pdf', readingWords: 0 },
    { id: 'prepared.pdf', format: 'pdf', words: 0, readingWords: 300 },
  ];
  const prefs = { librarySort: 'time', recent: ['long.md'] };
  assert.deepEqual(ids(docs, prefs), ['empty.pdf', 'short.txt', 'prepared.pdf', 'long.md', 'chapter2.pdf', 'chapter10.pdf']);
  docs[0].readingWords = 50;
  assert.deepEqual(ids(docs, prefs), ['empty.pdf', 'chapter10.pdf', 'short.txt', 'prepared.pdf', 'long.md', 'chapter2.pdf']);
});
test('saved dates survive replacement and metadata updates never overwrite concurrent content', () => {
  const original = { id: 'book.txt', title: 'Book', content: 'First', bytes: 5, addedAt: 10, modifiedAt: 8 };
  const added = addDocument(null, original);
  const replaced = replaceDocument(added.snapshot, { ...original, content: 'Second', addedAt: 40, modifiedAt: 50 }, added.document);
  assert.equal(replaced.document.addedAt, 10);
  assert.equal(localSnapshot(replaced.snapshot).documents[0].modifiedAt, 50);
  const updated = updateDocumentDates(replaced.snapshot, [{ id: original.id, expected: original, addedAt: 1, modifiedAt: 2 }]);
  assert.deepEqual(updated.snapshot, localSnapshot(replaced.snapshot));
});
