import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { libraryClearance, validLibraryActivity } from '../src/library-clearance.js';
import { libraryManifest, libraryRemove, libraryActivity, libraryUploadChunk, libraryCommit } from '../integrations/even-terminal/pageborne-library.js';
import { PhoneLibrary } from '../src/phone-storage.js';
import { readLocalFile, localSnapshot, replaceDocument } from '../src/library.js';
import { documentDescriptor, documentBytes, syncLibrary } from '../src/library-sync.js';

const DAY = 86400000, now = Date.parse('2026-11-10T12:00:00Z'), at = now - DAY;
const event = (id, kind, words, name = 'book.md', time = at, addedAt = now - 20 * DAY) => ({ id, kind, at: time,
  document: { name, sha256: 'a'.repeat(64), words, addedAt } });
const activity = events => ({ version: 1, libraryId: 'library', startedAt: now - 30 * DAY, events });
function views(name, words = 100, start = at - 3600000, scope = '') {
  return [0, 1].map(i => ({ id: `${name}-${start}-${i}`, platform: 'glasses', position: i, scope,
    document: { id: name, key: `local\n${name}` }, words, seconds: 60,
    at: new Date(start + i * 60000).toISOString(), endedAt: new Date(start + (i + 1) * 60000).toISOString() }));
}
test('clearance counts reading or full deletion once, excludes Ask, and compares additions over the same 30 days', () => {
  const entries = [...views('book.md', 150), ...views('kept.md', 100, at - 1800000), ...views('ask', 200, at - 900000).map(e => ({ ...e, kind: 'ask' }))];
  const input = { now, entries, documents: [{ id: 'kept.md', words: 2400 }],
    activity: activity([event('d', 'deleted', 1000), event('a', 'added', 600)]) };
  const before = JSON.stringify(input), result = libraryClearance(input);
  assert.equal(result.readWords, 200); assert.equal(result.deletedWords, 1000);
  assert.equal(result.wordsPerDay, 1200 / 30); assert.equal(result.days, 60); assert.equal(result.ratio, 0.5);
  assert.equal(JSON.stringify(input), before);
});
test('re-added filenames count their new reading; pending and acknowledged deletions deduplicate across restarts', () => {
  const removed = { ...event('offline', 'deleted', 1000), libraryId: 'library', endpoint: 'desktop' };
  const saved = { ...event('server', 'deleted', 1000), operationId: 'offline' };
  const base = { now, endpoint: 'desktop', activity: activity([saved, saved]), removals: [removed],
    entries: [...views('book.md', 100, at - 3600000), ...views('book.md', 100, at + 3600000)] };
  const result = libraryClearance(base);
  assert.equal(result.deletedWords, 1000); assert.equal(result.readWords, 200); assert.equal(result.pending, 0);
  assert.equal(libraryClearance({ ...base, activity: activity([]) }).deletedWords, 1000);
  assert.equal(libraryClearance({ ...base, endpoint: 'different', activity: activity([]) }).deletedWords, 0);
});
test('rolling window, scope, slow-reading filters and single-pane exclusion remain intact', () => {
  const entries = [...views('slow', 10), ...views('fast', 901, at - 1800000), ...views('other', 100, at - 900000, 'other'),
    ...views('old', 100, now - 31 * DAY), views('one', 100, at - 600000)[0]];
  const result = libraryClearance({ now, entries, activity: activity([event('old', 'deleted', 2000, 'old', now - 31 * DAY)]) });
  assert.equal(result.readWords, 20); assert.equal(result.deletedWords, 0);
});
test('the 30-day window includes older reading, additions and deletions', () => {
  const events = [event('d', 'deleted', 1000, 'deleted.md', now - 30 * DAY),
    event('a', 'added', 600, 'added.md', now - 20 * DAY),
    event('expired', 'deleted', 5000, 'expired.md', now - 30 * DAY - 1)];
  const result = libraryClearance({ now, documents: [{ words: 2000 }], activity: activity(events),
    entries: views('kept.md', 100, now - 20 * DAY) });
  assert.equal(result.readWords, 200); assert.equal(result.deletedWords, 1000);
  assert.equal(result.addedWords, 600); assert.equal(result.wordsPerDay, 40);
  assert.equal(result.days, 50); assert.equal(result.ratio, .5);
});
test('no known library words or clearance does not invent a finite days estimate', () => {
  const doc = [{ id: 'current.pdf', format: 'pdf' }];
  assert.equal(libraryClearance({ now, activity: activity([]), documents: [{ words: 50 }] }).days, null);
  assert.equal(libraryClearance({ now, activity: activity([]) }).days, 0);
  const result = libraryClearance({ now, documents: doc, activity: activity([event('d', 'deleted', null), event('a', 'added', null)]) });
  assert.equal(result.days, null); assert.equal(result.ratio, null); assert.equal(result.missingDeleted, 1);
  assert.equal(libraryClearance({ now, activity: { ...activity([]), startedAt: now } }).preliminary, true);
  assert.equal(validLibraryActivity(activity([event('d', 'deleted', 10)])), true);
  assert.equal(validLibraryActivity(activity([event('d', 'deleted', -1)])), false);
});
test('pending current and addition counts leave known estimates visible and clear when counted', () => {
  const documents = [{ id: 'known.md', words: 2000 }, { id: 'pending.pdf', format: 'pdf' }];
  const events = [event('d', 'deleted', 1000), event('a', 'added', 500), event('pending', 'added', null, 'pending.pdf')];
  const partial = libraryClearance({ now, documents, activity: activity(events) });
  assert.equal(partial.days, 60); assert.equal(partial.ratio, .5);
  assert.equal(partial.daysPartial, true); assert.equal(partial.ratioPartial, true);
  documents[1].readingWords = 1000; events[2].document.words = 1000;
  const complete = libraryClearance({ now, documents, activity: activity(events) });
  assert.equal(complete.days, 90); assert.equal(complete.ratio, 1.5);
  assert.equal(complete.daysPartial, false); assert.equal(complete.ratioPartial, false);
});
test('an uncounted deletion retains known reading until its full count replaces that reading', () => {
  const documents = [{ id: 'remaining.md', words: 2000 }], entries = views('book.md');
  const events = [event('d', 'deleted', null), event('a', 'added', 500)];
  const partial = libraryClearance({ now, documents, entries, activity: activity(events) });
  assert.equal(partial.readWords, 200); assert.equal(partial.deletedWords, 0);
  assert.equal(partial.days, 300); assert.equal(partial.ratio, 2.5);
  assert.equal(partial.daysPartial, true); assert.equal(partial.ratioPartial, true);
  events[0].document.words = 1000;
  const complete = libraryClearance({ now, documents, entries, activity: activity(events) });
  assert.equal(complete.readWords, 0); assert.equal(complete.deletedWords, 1000);
  assert.equal(complete.days, 60); assert.equal(complete.ratio, .5);
  assert.equal(complete.daysPartial, false); assert.equal(complete.ratioPartial, false);
});
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'library-clearance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { libraryDir: root } };
}
test('desktop activity serves the full month plus a day of margin without truncating the permanent ledger', async t => {
  const { root, options } = await fixture(t);
  await libraryManifest({}, options);
  const file = path.join(root, '.pageborne/activity.json'), saved = JSON.parse(await readFile(file));
  const current = Date.now();
  saved.events = [event('twenty', 'deleted', 1000, 'twenty.md', current - 20 * DAY),
    event('thirty', 'added', 500, 'thirty.md', current - 30 * DAY),
    event('older', 'deleted', 2000, 'older.md', current - 32 * DAY)];
  await writeFile(file, JSON.stringify(saved));
  const result = await libraryActivity({}, options);
  assert.deepEqual(result.events.map(e => e.id), ['twenty', 'thirty']);
  assert.equal(JSON.parse(await readFile(file)).events.length, 3);
});
test('phone deletion audit survives failed cleanup and restart, and sync preserves its offline date', async t => {
  const { root, options } = await fixture(t), data = new Map();
  const kv = { async get(k) { return data.get(k) || ''; }, async set(k, v) { data.set(k, v); } };
  const store = new PhoneLibrary(kv); await store.read();
  const doc = await readLocalFile(new File(['one two three'], 'book.md'));
  const added = await store.save(doc);
  await store.saveLibraryActivity({ ...activity([]), endpoint: 'desktop' });
  const set = kv.set.bind(kv); let interrupted = false;
  kv.set = async (key, value) => {
    if (!interrupted && key.endsWith(':pending') && value === '' && store.catalog.documents.length === 0) {
      interrupted = true; throw Error('Power loss after committing deletion');
    }
    await set(key, value);
  };
  const deleted = await store.remove('book.md');
  assert.equal(interrupted, true);
  assert.equal(deleted.snapshot.libraryRemovals[0].document.words, 3);
  assert.equal((await new PhoneLibrary(kv).read()).libraryRemovals.length, 1);
  const old = deleted.snapshot.libraryRemovals[0];
  assert.equal(localSnapshot(deleted.snapshot).libraryRemovals[0].id, old.id);
  assert.equal(replaceDocument(deleted.snapshot, doc, undefined).snapshot.libraryRemovals[0].id, old.id);
  await writeFile(path.join(root, 'book.md'), 'one two three');
  const remote = await libraryManifest({}, options), calls = [];
  const client = { config: { endpoint: 'desktop' }, async api(route, arg = {}) {
    if (route === 'pageborne/library') return libraryManifest({ reading: true }, options);
    if (route.endsWith('/remove')) { calls.push(arg.body); return libraryRemove(arg.body, options); }
    throw Error(route);
  } };
  await syncLibrary({ client, snapshot: deleted.snapshot, store, saved: { id: remote.id, files: { 'book.md': remote.files[0].sha256 } },
    saveState: async () => {}, changed: () => {} });
  assert.equal(calls[0].deletedAt, old.at); assert.equal(calls[0].operationId, old.id);
  assert.equal(added.document.words, 3);
});
