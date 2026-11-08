import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../src/document.js';
import { nativeLayout, textWindow, VISIBLE_LINES, LINE_HEIGHT, byteLength, titleText,
  pageOverlap, setPageOverlap, pageTurnY } from '../src/native-text.js';
import { Diagnostics, BridgeLane } from '../src/diagnostics.js';
import { Reader } from '../src/reader.js';

test('page swipes keep the selected overlap after arbitrary jumps', () => {
  const layout = nativeLayout(parseDocument('```\n' + Array.from({ length: 160 }, (_, i) => `Row ${i}: reading text.`).join('\n') + '\n```'));
  for (let overlap = 0; overlap < VISIBLE_LINES; overlap++) {
    setPageOverlap(layout, overlap);
    const seen = new Set();
    for (const y of layout.pages) {
      const page = textWindow(layout, y, 'page');
      for (let row = page.start; row < page.end; row++) seen.add(row);
    }
    assert.equal(seen.size, layout.rows.length, `overlap ${overlap}: no omitted rows`);
    assert.equal(layout.pages.at(-1), layout.maxY);
    const reader = new Reader();
    reader.setDocument(layout.maxY, 37 * LINE_HEIGHT + 10, layout.pages, (y, direction) => pageTurnY(layout, y, direction));
    const before = textWindow(layout, reader.y, 'page');
    reader.scroll(1);
    const after = textWindow(layout, reader.y, 'page');
    assert.equal(after.start - before.start, VISIBLE_LINES - overlap, `overlap ${overlap}: full step from phone jump`);
    assert.equal(before.end - after.start, overlap);
    if (overlap) assert.deepEqual(before.content.split('\n').slice(-overlap), after.content.split('\n').slice(0, overlap));
    reader.scroll(-1);
    assert.equal(reader.y, 37 * LINE_HEIGHT);
    assert.equal(pageTurnY(layout, 0, -1), 0);
    assert.equal(pageTurnY(layout, layout.maxY, 1), layout.maxY);
  }
  assert.equal(pageOverlap(undefined), 1);
  assert.equal(pageOverlap('bad'), 1);
  assert.equal(pageOverlap(-1), 0);
  assert.equal(pageOverlap(100), VISIBLE_LINES - 1);
  assert.equal(pageOverlap(2.9), 2);
});

test('native text windows obey pixel/byte limits and never omit rows', () => {
  assert.ok(byteLength(titleText('𝕩'.repeat(10000))) <= 800);
  for (const text of ['# English\n\n' + 'Words to read. '.repeat(1000), '# 中文\n\n' + '这是中文文字。'.repeat(200), '𝕩'.repeat(2000)]) {
    const layout = nativeLayout(parseDocument(text));
    assert.equal(layout.pageOverlap, 0, 'reader layouts default to full pages');
    const seen = new Set();
    for (const y of layout.pages) {
      const page = textWindow(layout, y, 'page');
      assert.ok(byteLength(page.content) <= 900);
      assert.ok(page.end - page.start <= VISIBLE_LINES);
      for (let i = page.start; i < page.end; i++) seen.add(i);
    }
    assert.equal(seen.size, layout.rows.length);
    let y = 0;
    for (let iterations = 0; ; iterations++) {
      assert.ok(iterations < layout.rows.length);
      const chunk = textWindow(layout, y);
      assert.ok(byteLength(chunk.content) <= 900);
      assert.ok(chunk.end > chunk.start);
      if (y >= layout.maxY) { assert.equal(chunk.end, layout.rows.length); break; }
      assert.ok(chunk.nextY > y); y = chunk.nextY;
      if (y < layout.maxY) assert.equal(textWindow(layout, y).start, chunk.end, 'no repeated rows on a full page turn');
    }
  }
});
test('an SDK timeout never allows exit or reconnect to overlap the pending call', async () => {
  const events = []; const diagnostics = { active: null, log: (type, details) => events.push({ type, ...details }) };
  const lane = new BridgeLane(diagnostics, 30);
  let release;
  const frame = lane.run('frame', () => new Promise(r => { release = r; }));
  await assert.rejects(frame, /timed out/);
  assert.equal(lane.busy, true);
  let exited = false;
  const exit = lane.run('exit', async () => { exited = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(exited, false);
  release(); await exit;
  assert.equal(exited, true); assert.equal(lane.busy, false);
  assert.equal(diagnostics.active, null);
  assert.deepEqual(events.filter(e => e.type === 'bridge-start').map(e => e.name), ['frame', 'exit']);
});
test('storage queued behind a hung display expires without ever executing late', async () => {
  const lane = new BridgeLane({ log() {} }, 25); let release, writes = 0;
  const frame = lane.run('text-frame', () => new Promise(resolve => { release = resolve; }));
  const queued = lane.run('storage-write', () => { writes++; });
  await Promise.all([assert.rejects(frame, { code: 'bridge-timeout' }), assert.rejects(queued, { code: 'bridge-timeout', queued: true })]);
  assert.equal(lane.busy, true); assert.equal(writes, 0);
  release(); await lane.tail; assert.equal(writes, 0, 'expired writes must not commit stale state');
  await lane.run('storage-write', () => { writes++; }); assert.equal(writes, 1);
});
test('diagnostic history is bounded and preserves a prior unfinished operation', () => {
  let value = JSON.stringify({ startedAt: 'before', active: { name: 'text-frame' }, events: [] });
  const storage = { getItem: () => value, setItem: (_key, data) => { value = data; } };
  const original = console.info; console.info = () => {};
  try {
    const diagnostics = new Diagnostics(storage);
    for (let i = 0; i < 1000; i++) diagnostics.log('gesture', { action: 'next' });
    assert.equal(diagnostics.events.length, 100);
    assert.equal(JSON.parse(value).events.length, 40);
    assert.equal(diagnostics.summary().previousRun.active.name, 'text-frame');
    assert.ok(value.length < 10000);
  } finally { console.info = original; }
});
