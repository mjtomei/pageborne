// Real SDK + display queue, with controlled native acknowledgements. This
// reproduces transport timing; it makes no claim about physical BLE throughput.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

const out = process.env.DISPLAY_RESULTS || 'test-results/display-recovery';
await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'release', cacheDir: '.state/vite-display-recovery',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--disable-gpu', '--js-flags=--max-old-space-size=384'] });
const results = { physicalGlasses: false, errors: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', e => results.errors.push(e.message));
  await page.route('**/display-probe', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Image transport regression</title>' }));
  await page.goto(new URL('display-probe', vite.resolvedUrls.local[0]).href);
  await page.evaluate(async () => {
    const nativeTimeout = window.setTimeout.bind(window);
    window.delay = ms => new Promise(resolve => nativeTimeout(resolve, ms));
    window.transport = { calls: [], active: 0, maximum: 0, delayMs: 0, holdTile: null };
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const m = JSON.parse(payload), t = window.transport;
      const display = ['createStartUpPageContainer', 'rebuildPageContainer', 'textContainerUpgrade', 'updateImageRawData', 'shutDownPageContainer'].includes(m.method);
      if (!display) return true;
      const call = { method: m.method, container: m.data?.containerName, bytes: m.data?.imageData?.length, started: performance.now() };
      t.calls.push(call); t.maximum = Math.max(t.maximum, ++t.active);
      try {
        if (m.method === 'updateImageRawData') {
          if (t.holdTile === m.data.containerName) await new Promise(resolve => { t.release = resolve; });
          else if (t.delayMs) await window.delay(t.delayMs);
        }
        return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
      } finally { t.active--; call.finished = performance.now(); }
    } };
    const { GlassesDisplay } = await import('/src/glasses.js');
    const { Diagnostics } = await import('/src/diagnostics.js');
    window.diagnostics = new Diagnostics();
    window.display = new GlassesDisplay({ diagnostics, onAction() {}, onStatus: value => window.statusText = value });
    await display.connect();
    window.resetTransport = () => Object.assign(transport, { calls: [], maximum: 0, delayMs: 0, holdTile: null, release: null });
    window.imageCalls = () => transport.calls.filter(c => c.method === 'updateImageRawData');
  });
  const sample = process.env.PDF_SAMPLE ? await readFile(process.env.PDF_SAMPLE) : pdfFixture('figure');
  results.pdf = await page.evaluate(async content => {
    const { PdfDocument } = await import('/src/pdf.js');
    const { nativeLayout } = await import('/src/native-text.js');
    const { parseDocument } = await import('/src/document.js');
    window.pdf = new PdfDocument({ diagnostics });
    const layout = await pdf.open(content, 'auto');
    const block = layout.blocks.find(b => !b.reflow);
    if (!block) throw new Error('Fixture must contain an image');
    const bitmap = await pdf.draw(block.y, 258, true, { paging: true, centerImages: true, endAt: block.y + block.drawHeight });
    bitmap.id = 'figure'; document.body.append(bitmap);
    window.imageFrame = { layout, bitmap, y: block.y, mode: 'page', selection: 1 };
    window.textFrame = { layout: nativeLayout(parseDocument('Reading continues after the image.')), mode: 'page', y: 0, selection: 2 };
    return { bytes: atob(content).length, sourcePages: pdf.pdf.numPages, blocks: layout.blocks.length, imagePage: block.page, imageKind: block.kind };
  }, sample.toString('base64'));
  // A healthy four-tile transfer exceeds the former 8-second frame timeout.
  await page.evaluate(() => { resetTransport(); transport.delayMs = 2200; display.submit(imageFrame); });
  await expect.poll(() => page.evaluate(() => display.acceptedFrame === imageFrame), { timeout: 20000 }).toBe(true);
  results.progressing = await page.evaluate(() => ({ tiles: imageCalls().map(c => c.container), elapsedMs: display.lastAccepted.elapsedMs,
    ready: display.ready, stopped: display.queue.stopped, timeouts: diagnostics.counts['bridge-timeout'] || 0, maximum: transport.maximum }));
  assert.deepEqual(results.progressing.tiles, ['pdf-0', 'pdf-1', 'pdf-2', 'pdf-3']);
  assert(results.progressing.elapsedMs > 8000); assert.equal(results.progressing.timeouts, 0); assert.equal(results.progressing.maximum, 1);
  await page.locator('#figure').screenshot({ path: `${out}/first-image.png` });
  const showText = async () => {
    await page.evaluate(() => { transport.delayMs = 0; transport.holdTile = null; display.submit(textFrame); });
    await expect.poll(() => page.evaluate(() => display.acceptedFrame === textFrame)).toBe(true);
  };
  await showText();
  // Each native call still has a deadline. Late tile 4 must retain the lane
  // until acknowledgement, then rebuild the latest page automatically.
  await page.evaluate(() => { resetTransport(); display.lane.timeoutMs = 250; transport.holdTile = 'pdf-3'; display.submit(imageFrame); });
  await expect.poll(() => page.evaluate(() => diagnostics.counts['display-error'] || 0)).toBe(1);
  const blocked = await page.evaluate(async () => {
    display.submit(textFrame); await display.connect(); // A manual retry cannot overlap or disable recovery.
    return { active: transport.active, ready: display.ready, maximum: transport.maximum,
      error: diagnostics.errors.at(-1), calls: transport.calls.length };
  });
  assert.equal(blocked.active, 1); assert.equal(blocked.ready, false); assert.equal(blocked.maximum, 1);
  assert.equal(blocked.error.context.tile, 4); assert.equal(blocked.error.context.container, 'pdf-3'); assert.equal(blocked.error.context.bytes, 18576);
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => transport.calls.length), blocked.calls, 'no rebuild while tile is still in flight');
  await page.evaluate(() => { transport.holdTile = null; transport.release(); });
  await expect.poll(() => page.evaluate(() => display.ready && display.acceptedFrame === textFrame)).toBe(true);
  results.lateFourthTile = await page.evaluate(() => ({ recovered: display.ready, acceptedLatest: display.acceptedFrame === textFrame,
    maximum: transport.maximum, recoveries: diagnostics.counts['display-recovery'], errorContext: diagnostics.errors.at(-1).context }));
  assert.equal(results.lateFourthTile.maximum, 1); assert.equal(results.lateFourthTile.recoveries, 1);

  // New navigation supersedes unfinished tiles between acknowledgements.
  await page.evaluate(() => { resetTransport(); display.lane.timeoutMs = 8000; transport.holdTile = 'pdf-0'; display.submit(imageFrame); });
  await expect.poll(() => page.evaluate(() => !!transport.release)).toBe(true);
  await page.evaluate(() => { display.submit(textFrame); transport.holdTile = null; transport.release(); });
  await expect.poll(() => page.evaluate(() => display.acceptedFrame === textFrame && !display.queue.running)).toBe(true);
  results.skipObsolete = await page.evaluate(() => ({ tiles: imageCalls().length, maximum: transport.maximum }));
  assert.deepEqual(results.skipObsolete, { tiles: 1, maximum: 1 });

  // Status refreshes must not starve the four image tiles.
  await page.evaluate(() => {
    resetTransport(); transport.holdTile = 'pdf-0'; display.submit(imageFrame);
    window.footerFrame = { ...imageFrame, askStatus: 'working' };
  });
  await expect.poll(() => page.evaluate(() => !!transport.release)).toBe(true);
  await page.evaluate(() => { display.submit(footerFrame); transport.holdTile = null; transport.release(); });
  await expect.poll(() => page.evaluate(() => display.acceptedFrame === footerFrame)).toBe(true);
  results.footerRefresh = await page.evaluate(() => ({ tiles: imageCalls().length, maximum: transport.maximum }));
  assert.deepEqual(results.footerRefresh, { tiles: 4, maximum: 1 });
  await showText();

  // The native app's exit must win over a scheduled recovery.
  await page.evaluate(() => { resetTransport(); display.lane.timeoutMs = 250; transport.holdTile = 'pdf-3'; display.submit(imageFrame); });
  await expect.poll(() => page.evaluate(() => diagnostics.counts['bridge-timeout'])).toBe(2);
  const exitedCalls = await page.evaluate(() => {
    display.close(); transport.holdTile = null; transport.release(); return transport.calls.length;
  });
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => display.ready), false, 'manual close also cancels pending recovery');
  await page.evaluate(() => display.handleEvent({ sysEvent: { eventType: 6 } }));
  results.exit = await page.evaluate(() => ({ ready: display.ready, created: display.created, calls: transport.calls.length }));
  assert.deepEqual(results.exit, { ready: false, created: false, calls: exitedCalls });
  // Repeatedly slow acknowledgements stop after two automatic rebuilds.
  await page.evaluate(async () => { display.lastFrame = textFrame; await display.connect(); });
  await expect.poll(() => page.evaluate(() => display.ready && display.acceptedFrame === textFrame)).toBe(true);
  await page.evaluate(() => { resetTransport(); display.lane.timeoutMs = 250; transport.holdTile = 'pdf-3'; display.submit(imageFrame); });
  for (let attempt = 0; attempt < 3; attempt++) {
    await expect.poll(() => page.evaluate(() => diagnostics.counts['bridge-timeout'])).toBe(3 + attempt);
    await page.evaluate(() => { const release = transport.release; transport.release = null; release(); });
  }
  await page.waitForTimeout(400);
  results.boundedRecovery = await page.evaluate(() => ({ ready: display.ready, attempts: display.recoveryAttempts,
    rebuilds: transport.calls.filter(c => c.method === 'rebuildPageContainer').length, maximum: transport.maximum }));
  assert.deepEqual(results.boundedRecovery, { ready: false, attempts: 2, rebuilds: 5, maximum: 1 });
  await page.evaluate(() => { for (let i = 0; i < 200; i++) diagnostics.log('bridge-ok', { name: 'storage-write' }); });
  assert.equal(await page.evaluate(() => diagnostics.summary().errors.at(-1).context.tile), 4, 'tile failure survives the rolling event log');
  assert.deepEqual(results.errors, []);
  results.passed = true;
} finally {
  await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2));
  await browser.close(); await vite.close();
}
console.log(JSON.stringify(results));
