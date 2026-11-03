import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadingTracker, ReadingLog, readingDay, mergeReadingEntries } from '../src/reading-activity.js';
import { phoneReadingStorage, ReadingSync } from '../src/reading-storage.js';
import { createReadingActivity } from '../integrations/even-terminal/pageborne-reading-activity.js';
import { glassesReadingUnits } from '../src/reading-view.js';
import { parseDocument } from '../src/document.js';
import { nativeLayout, textWindow } from '../src/native-text.js';
import { AtomicPhoneValue } from '../src/phone-storage.js';
import { groupReadingEntries, readingGroupLocation } from '../src/reading-history-groups.js';

function historyEntry(id, overrides = {}) {
  return { id: String(id), day: '2026-11-02', at: `2026-11-02T12:0${id}:00.000Z`, endedAt: `2026-11-02T12:0${id}:30.000Z`,
    document: { id: 'book.pdf', key: 'book-key', title: 'Book' }, scope: 'library-one',
    words: 100, seconds: 30, page: id + 1, position: id * 10, excerpt: `Passage ${id}`, platform: 'glasses', sessions: [], ...overrides };
}
test('adjacent readings become one display entry with totals, ranges and all conversation links', () => {
  const claude = { agent: 'claude', id: 'chat-one' }, codex = { agent: 'codex', id: 'chat-two' };
  const entries = [historyEntry(2, { platform: 'web', sessions: [claude] }), historyEntry(0, { sessions: [codex] }), historyEntry(1, { sessions: [claude] })];
  const before = structuredClone(entries), [group] = groupReadingEntries(entries);
  assert.equal(group.count, 3); assert.equal(group.words, 300); assert.equal(group.seconds, 90);
  assert.equal(group.startedAt, entries[1].at); assert.equal(group.endedAt, entries[0].endedAt);
  assert.equal(readingGroupLocation(group), 'pages 1–3'); assert.equal(group.excerpt, 'Passage 2');
  assert.deepEqual(group.platforms, ['web', 'glasses']); assert.deepEqual(group.sessions, [claude, codex]);
  assert.deepEqual(entries, before, 'grouping never alters stored events or input ordering');
});
test('a different document, library or day separates reading groups', () => {
  const other = { id: 'other.pdf', key: 'other-key', title: 'Book' };
  const entries = [historyEntry(0), historyEntry(1, { document: other }), historyEntry(2),
    historyEntry(3, { scope: 'library-two' }), historyEntry(4, { day: '2026-11-03' })];
  const groups = groupReadingEntries(entries);
  assert.equal(groups.length, 5, 'same title or a return to an earlier document is not one consecutive run');
  assert.equal(groups.reduce((sum, group) => sum + group.words, 0), 500);
});
test('text position ranges preserve rereading and group whole runs before pagination', () => {
  const entries = Array.from({ length: 60 }, (_, i) => historyEntry(0, { id: String(i), page: undefined, position: i % 3 * 10, words: 1.5 }));
  const groups = groupReadingEntries(entries);
  assert.equal(groups.length, 1); assert.equal(groups[0].words, 90); assert.equal(groups[0].count, 60);
  assert.equal(readingGroupLocation(groups[0]), '0–20%');
  assert.equal(readingGroupLocation(groupReadingEntries([historyEntry(0, { page: undefined, position: 12.2 })])[0]), '12%');
  assert.equal(readingGroupLocation(groupReadingEntries([historyEntry(0)])[0]), 'page 1');
});

function fixture(start = new Date(2026, 10, 2, 12).getTime()) {
  let time = 0, id = 0; const events = [];
  const tracker = new ReadingTracker(e => events.push(e), { clock: () => time, date: () => new Date(start + time), id: () => `entry-${++id}` });
  const view = (from, end) => ({ scope: 'pageborne:instance:library', platform: 'glasses', document: { id: 'book.txt', key: 'local\nbook.txt', title: 'Book', revision: 'one' },
    position: from, units: Array.from({ length: end - from }, (_, i) => ({ key: String(from + i), words: 1, text: `word${from + i}` })) });
  const tick = (ms, v) => { time += ms; tracker.observe(v); };
  return { tracker, events, view, tick };
}
test('records readable pages once, ignores rapid paging and images', () => {
  const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60)); tick(12000, view(60, 120));
  assert.equal(events.length, 1); assert.equal(events[0].words, 60); assert.ok(Math.abs(events[0].seconds - 12) < 1e-9);
  tick(100, view(120, 180)); assert.equal(events.length, 1);
  tick(12000, view(0, 0)); assert.equal(events.length, 2);
  tick(12000, view(0, 60)); assert.equal(events.length, 2);
  tick(12000, view(60, 120)); assert.equal(events.length, 3, 'intentional rereading counts');
});
test('overlapping pages and continuous scrolling only count departing text', () => {
  const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60)); tick(12000, view(30, 90)); tick(12000, view(60, 120));
  tracker.leave(); assert.equal(events.reduce((n, e) => n + e.words, 0), 90);
  assert.equal(new Set(events.flatMap(e => e.excerpt.split(' '))).size > 0, true);
});
test('menus, Ask and background intervals do not add dwell', () => {
  const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60)); tick(1000, null); tick(20000, null); tick(0, view(0, 60)); tick(1000, view(60, 120));
  assert.equal(events.length, 0, 'two seconds cannot establish 60 words read');
});
test('idle views and suspended timer gaps are excluded', () => {
  const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60));
  for (let i = 0; i < 31; i++) tick(10000, view(0, 60));
  tick(0, { ...view(60, 120), platform: 'web' }); assert.equal(events.length, 0);
  tick(40000, view(120, 180)); assert.equal(events.length, 0);
});
test('acknowledged glasses text remains readable during a delayed phone timer', () => {
  const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60)); tick(40000, view(60, 120));
  assert.equal(events.length, 1); assert.equal(events[0].words, 60);
});
test('speed groups count at human rates and skip implausible rates', () => {
  const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 3)); tick(600, view(3, 6)); tick(20, view(6, 9));
  assert.equal(events.length, 1); assert.equal(events[0].words, 3);
});
test('midnight splits words across local calendar days without duplicating them', () => {
  const date = new Date(2026, 10, 2, 23, 59, 58), { tracker, events, view, tick } = fixture(date.getTime());
  tracker.observe(view(0, 40)); tick(4000, view(40, 80));
  assert.deepEqual(events.map(e => [e.day, Math.round(e.words)]), [[readingDay(date), 20], [readingDay(new Date(date.getTime() + 4000)), 20]]);
});
test('events keep titles and sessions independently of document deletion', () => {
  const { tracker, events, view, tick } = fixture(); const v = view(0, 60);
  v.sessions = [{ agent: 'claude', id: 'session' }]; tracker.observe(v); tick(12000, v); tracker.leave();
  const newer = { ...events[0], words: 900, sessions: [{ agent: 'codex', id: 'other' }] };
  const merged = mergeReadingEntries(events, [newer, newer]);
  assert.equal(merged.length, 1); assert.equal(merged[0].words, 60); assert.equal(merged[0].document.title, 'Book'); assert.equal(merged[0].sessions.length, 2);
});
test('phone reading log survives reload and retries failed writes', async () => {
  const data = new Map(); let fail = false;
  const kv = { get: async k => data.get(k) || '', set: async (k, v) => { if (fail) throw new Error('Full'); data.set(k, v); } };
  const log = new ReadingLog(phoneReadingStorage(kv)); const { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60)); tick(12000, view(60, 120));
  fail = true; await assert.rejects(log.add(events), /Full/); assert.equal(log.pending.size, 1);
  fail = false; await log.flush(); await log.add(events);
  const restored = new ReadingLog(phoneReadingStorage(kv)); await restored.load();
  assert.equal(restored.entries.length, 1); assert.equal(restored.entries[0].words, 60);
});
test('accepted native panes honor byte/line boundaries and exclude Ask and figures', () => {
  const layout = nativeLayout(parseDocument('word '.repeat(600)), 2), window = textWindow(layout, 0);
  const frame = { layout, y: 0, mode: 'page' }, units = glassesReadingUnits(frame);
  assert.equal(units.reduce((n, e) => n + e.words, 0), window.content.trim().split(/\s+/).length);
  assert.deepEqual(glassesReadingUnits({ ...frame, message: { kind: 'ask', body: 'An answer' } }), []);
  assert.deepEqual(glassesReadingUnits({ ...frame, picker: {} }), []);
  const speed = glassesReadingUnits({ ...frame, mode: 'speed', wordFrame: { start: 3, end: 6 } });
  assert.equal(speed.length, 3);
  const pdf = { format: 'pdf', blocks: [{ page: 1, x: 0, y: 0, width: 552, height: 288, drawHeight: 288, text: 'An image with OCR metadata' }], nativeRuns: [] };
  assert.deepEqual(glassesReadingUnits({ layout: pdf, y: 0, mode: 'page' }), []);
});
test('phone log appends bounded shards instead of rewriting all previous events', async () => {
  const data = new Map(), writes = [];
  const kv = { get: async k => data.get(k) || '', set: async (k, v) => { data.set(k, v); writes.push(k); } };
  const storage = phoneReadingStorage(kv);
  const { tracker, events, view, tick } = fixture(); tracker.observe(view(0, 60)); tick(12000, view(60, 120));
  await storage.merge(Array.from({ length: 130 }, (_, i) => ({ ...events[0], id: `entry-${i}` })));
  writes.length = 0;
  await storage.merge([{ ...events[0], id: 'entry-130' }]);
  assert.ok(writes.every(key => key.includes('reading-shard:2026-11-02:2')), writes.join('\n'));
  assert.equal((await phoneReadingStorage(kv).read()).length, 131);
});
test('retry after a shard write fails reuses the discovered empty shards', async () => {
  const data = new Map(); let fail = true;
  const kv = { get: async k => data.get(k) || '', set: async (k, v) => {
    if (fail && k.includes('reading-shard:')) throw new Error('Temporary failure'); data.set(k, v);
  } };
  const storage = phoneReadingStorage(kv), { tracker, events, view, tick } = fixture();
  tracker.observe(view(0, 60)); tick(12000, view(60, 120));
  const entries = Array.from({ length: 130 }, (_, i) => ({ ...events[0], id: `entry-${i}` }));
  await assert.rejects(storage.merge(entries), /Temporary/); fail = false; await storage.merge(entries);
  assert.equal((await new AtomicPhoneValue(kv, 'reading-days').read())[0].shards, 3);
  assert.equal((await phoneReadingStorage(kv).read()).length, 130);
});
test('desktop storage merges concurrent devices, survives source deletion, and isolates libraries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reading-log-'));
  try {
    const identity = async () => ({ instanceId: 'instance', libraryId: 'library' });
    const store = createReadingActivity({ identity, libraryDir: root });
    const { tracker, events, view, tick } = fixture(); tracker.observe(view(0, 60)); tick(12000, view(60, 120));
    const e = events[0];
    await Promise.all([store.update(e.day, { entries: [e] }), store.update(e.day, { entries: [{ ...e, id: 'other-device' }] })]);
    await writeFile(path.join(root, 'book.txt'), 'text'); await rm(path.join(root, 'book.txt'));
    assert.equal((await store.read(e.day)).entries.length, 2);
    await store.update(e.day, { entries: [e] }); assert.equal((await store.index()).days.length, 1);
    await assert.rejects(store.update(e.day, { entries: [{ ...e, scope: 'wrong-library' }] }), /Invalid/);
    await assert.rejects(store.read('../escape'), /Invalid/);
    await assert.rejects(store.update(e.day, { entries: [{ ...e, words: Infinity }] }), /Invalid/);
    const file = path.join(root, '.pageborne/reading-activity/instance', '2026-11-03.json');
    await symlink(path.join(root, '.pageborne/reading-activity/instance', `${e.day}.json`), file);
    await assert.rejects(store.read('2026-11-03'), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('two device syncs merge offline reading without double counting retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'reading-sync-'));
  try {
    const store = createReadingActivity({ libraryDir: root, identity: async () => ({ instanceId: 'instance', libraryId: 'library' }) });
    const client = { api: (route, options) => {
      const day = route.split('/')[2]; return options?.body ? store.update(day, options.body) : day ? store.read(day) : store.index();
    } };
    const memory = () => { let entries = []; return { read: async () => entries, merge: async input => { entries = mergeReadingEntries(entries, input); } }; };
    const a = new ReadingLog(memory()), b = new ReadingLog(memory());
    const { tracker, events, view, tick } = fixture(); tracker.observe(view(0, 60)); tick(12000, view(60, 120));
    await a.add(events); await b.add([{ ...events[0], id: 'device-b' }]);
    const sync = log => new ReadingSync({ log: () => log, client: () => client, scope: () => events[0].scope, sessions: e => e.sessions });
    const sa = sync(a), sb = sync(b); await Promise.all([sa.sync(), sb.sync()]); await Promise.all([sa.sync(), sb.sync()]);
    assert.equal(a.entries.length, 2); assert.equal(b.entries.length, 2);
    assert.equal(a.entries.reduce((n, e) => n + e.words, 0), 120);
    assert.equal((await store.read(events[0].day)).entries.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
