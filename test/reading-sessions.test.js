import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedReadingEntries, readingTotals } from '../src/reading-metrics.js';
import { averageReadingSpeed } from '../src/reading-estimates.js';

const start = Date.parse('2026-11-02T12:00:00Z');
function pane(index, extra = {}) {
  return { version: 2, id: `entry-${index}`, run: 'run', viewId: `view-${index}`,
    kind: 'document', scope: 'library', document: { id: 'book', key: 'book', revision: 'one' },
    platform: 'glasses', day: '2026-11-02', at: new Date(start + index * 30000).toISOString(),
    endedAt: new Date(start + (index + 1) * 30000).toISOString(),
    page: 1, position: index, words: 60, seconds: 30, units: [[`pane-${index}`, 60, 30]],
    reason: 'page', ...extra };
}

test('single-pane sessions retain raw data but contribute no words, time or WPM', () => {
  const entries = [pane(0)], before = structuredClone(entries);
  assert.deepEqual(readingTotals(entries), { words: 0, seconds: 0, wpm: null });
  assert.equal(averageReadingSpeed(entries, { includeAsk: true }), null);
  assert.deepEqual(entries, before);
  assert.equal(acceptedReadingEntries(entries, { minPanes: 1 }).length, 1, 'raw data can be re-filtered later');
  assert.deepEqual(readingTotals([...entries, pane(1)]), { words: 120, seconds: 60, wpm: 120 },
    'a second qualifying pane includes the first, even on the same source PDF page');
});

test('rapid flips, empty panes and duplicate sync records cannot qualify a single-page visit', () => {
  const entries = [pane(0), pane(1, { seconds: 0.1, units: [['fast', 60, 0.1]] }),
    pane(2, { words: 0, units: [] }), pane(0)];
  assert.equal(readingTotals(entries).words, 0);
  const overlap = [pane(0, { units: [['first', 30, 15], ['shared', 30, 15]] }),
    pane(1, { seconds: 0.1, units: [['shared', 30, 0.05], ['last', 30, 0.05]] })];
  assert.ok(acceptedReadingEntries(overlap, { minPanes: 1 }).length === 2, 'shared words have accumulated reading time');
  assert.equal(readingTotals(overlap).words, 0, 'a fast overlapping scroll cannot qualify the session');
});

test('pauses, repeated locations and midnight pieces of one pane are still one page', () => {
  for (const extra of [{ viewId: 'view-0' }, { viewId: 'new-view' }, { day: '2026-11-03', reason: 'midnight' }]) {
    const entries = [pane(0, { reason: 'pause' }), pane(1, { units: [['pane-0', 60, 30]], ...extra })];
    assert.equal(readingTotals(entries).words, 0);
  }
});

test('session qualification happens before the daily filter, including across midnight', () => {
  const a = pane(0, { day: '2026-11-02', at: '2026-11-02T23:59:45Z', endedAt: '2026-11-03T00:00:00Z',
    seconds: 15, units: [['pane-0', 60, 15]], reason: 'midnight' });
  const b = pane(1, { day: '2026-11-03', at: '2026-11-03T00:00:00Z', endedAt: '2026-11-03T00:00:15Z',
    seconds: 15, viewId: a.viewId, units: [['pane-0', 60, 15]] });
  const c = pane(2, { day: '2026-11-03', at: b.endedAt, endedAt: '2026-11-03T00:00:45Z' });
  assert.equal(readingTotals([a, b]).words, 0);
  assert.equal(readingTotals([a, b, c], { day: a.day }).words, 30);
  assert.equal(readingTotals([a, b, c], { day: c.day }).words, 90);
});

test('separate visits, documents, revisions, devices and Ask sources cannot qualify one another', () => {
  for (const extra of [{ run: 'other' }, { scope: 'other' }, { platform: 'web' }, { kind: 'ask' },
    { document: { id: 'other', key: 'other' } }, { document: { id: 'book', key: 'book', revision: 'two' } },
    { at: new Date(start + 360000).toISOString(), endedAt: new Date(start + 390000).toISOString() }]) {
    assert.equal(readingTotals([pane(0), pane(1, extra)], { includeAsk: true }).words, 0);
  }
  assert.equal(readingTotals([pane(0), pane(1, { seconds: 310 }), pane(2)], { includeAsk: true }).words, 0,
    'an idle pane cannot bridge isolated visits');
});

test('document and Ask metrics use independently qualified sessions', () => {
  const doc = [pane(0), pane(1)], ask = [pane(2, { kind: 'ask', units: [['ask-1', 120, 30]], words: 120 }),
    pane(3, { kind: 'ask', units: [['ask-2', 120, 30]], words: 120 })];
  assert.equal(averageReadingSpeed([...doc, ask[0]], { includeAsk: true }), 120);
  assert.deepEqual(readingTotals([...doc, ...ask]), { words: 120, seconds: 60, wpm: 120 });
  assert.deepEqual(readingTotals([...doc, ...ask], { includeAsk: true }), { words: 360, seconds: 120, wpm: 180 });
  assert.equal(readingTotals([...doc, ...ask], { kind: 'ask' }).wpm, 240);
});

test('legacy history uses consecutive locations and time gaps without rewriting events', () => {
  const a = pane(0, { version: undefined }), b = pane(1, { version: undefined });
  assert.equal(readingTotals([a]).words, 0);
  assert.equal(readingTotals([b, a, a]).words, 120);
  assert.equal(readingTotals([a, { ...b, position: a.position }]).words, 0);
  assert.equal(readingTotals([a, { ...b, at: '2026-11-02T13:00:00Z', endedAt: '2026-11-02T13:00:30Z' }]).words, 0);
  assert.equal(readingTotals([a, { ...b, document: { id: 'other', key: 'other' } }, pane(2, { version: undefined })]).words, 0);
});
