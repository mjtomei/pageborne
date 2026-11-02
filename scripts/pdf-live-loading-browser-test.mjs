// Exercise the real phone UI and accepted glasses frames while scanned pages
// are preparing. An optional local sample is never copied into the repository.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { displayProbe } from './display-probe.mjs';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, waitForPdfReady } from './ui-helpers.mjs';
const dir = path.resolve(process.env.PDF_LIVE_RESULTS || 'test-results/pdf-live-loading'); await mkdir(dir, { recursive: true });
const server = await createServer({ mode: 'release', cacheDir: '.state/vite-pdf-live', plugins: [displayProbe(), {
  name: 'pdf-live-fixture', transform(code, id) {
    if (id.endsWith('/src/main.js')) return code.replace('enabled: DEBUG', 'enabled: true').replace('const opening = pdfDocument;', 'const opening = pdfDocument; window.__pdfForTest = opening;');
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
    if (!process.env.PDF_SAMPLE && id.endsWith('/src/pdf.js')) return code.replace('const extracted = await this.readPageText', 'await new Promise(resolve => setTimeout(resolve, 250)); const extracted = await this.readPageText');
  },
}], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await server.listen();
const engine = process.env.PDF_BROWSER || 'chromium';
const browser = await (engine === 'webkit' ? webkit.launch({ executablePath: process.env.WEBKIT_PATH }) : chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] }));
const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const result = { engine, passed: false, errors: [] }; let page;
const phoneStorage = new Map();
await context.exposeFunction('__phoneStorage', m => {
  if (m.method === 'getLocalStorage') return phoneStorage.get(m.data.key) || '';
  phoneStorage.set(m.data.key, m.data.value); return true;
});
await context.addInitScript(() => {
  window.flutter_inappwebview = { async callHandler(_, payload) {
    const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return __phoneStorage(m);
    return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
  } };
  // Suppress animation frames just as a hidden WebView does. PDF rendering and
  // OCR must finish on return without creating a new document or losing place.
  const raf = window.requestAnimationFrame.bind(window);
  window.__background = false;
  Object.defineProperty(document, 'hidden', { get: () => window.__background });
  Object.defineProperty(document, 'visibilityState', { get: () => window.__background ? 'hidden' : 'visible' });
  window.requestAnimationFrame = callback => window.__background ? 0 : raf(callback);
  window.__visibility = hidden => { window.__background = hidden; document.dispatchEvent(new Event('visibilitychange')); };
});
try {
  page = await context.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
  const pixels = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 600, 800); ctx.fillStyle = 'black';
    ctx.font = 'bold 42px sans-serif'; ctx.fillText('THE OPEN BOOK', 90, 160);
    ctx.fillRect(180, 270, 240, 200); ctx.fillStyle = 'white'; ctx.fillRect(200, 290, 200, 160);
    ctx.fillStyle = 'black'; ctx.font = '26px sans-serif'; ctx.fillText('An original test cover', 170, 620);
    const data = ctx.getImageData(0, 0, 600, 800).data;
    const rgb = []; for (let i = 0; i < data.length; i += 4) rgb.push(data[i], data[i + 1], data[i + 2]); return rgb;
  });
  const bytes = process.env.PDF_SAMPLE ? await readFile(process.env.PDF_SAMPLE) : scannedPdfFixture(600, 800, Buffer.from(pixels), { pages: 12 });
  await page.locator('#file-picker').setInputFiles({ name: 'live.pdf', mimeType: 'application/pdf', buffer: bytes });
  await showLibrary(page); await page.locator('[data-document-id="live.pdf"] .document-card').click();
  await expect.poll(() => page.evaluate(() => window.__displayFrame?.layout?.format), { timeout: 120000 }).toBe('pdf');
  await expect.poll(() => page.evaluate(() => __pdfForTest.layout.preparation.readyPages), { timeout: 120000 }).toBeGreaterThanOrEqual(3);
  assert.equal(await page.evaluate(() => __pdfForTest.layout.preparation.complete), false);
  await page.locator('#next').evaluate(button => button.click());
  await expect.poll(() => page.evaluate(() => window.__displayFrame?.y), { timeout: 60000 }).toBeGreaterThan(0);
  result.firstAcceptedPageTurn = await page.evaluate(() => window.__displayFrame.y);
  // Navigate and scroll repeatedly during OCR, cancelling old display and phone
  // tiles while snapshots grow. Record the work backlog rather than just final UI.
  result.movement = await page.evaluate(async () => {
    const doc = __pdfForTest; let maxQueued = 0, partialMoves = 0; const positions = new Set(), notices = new Set();
    for (let i = 0; i < 90; i++) {
      document.getElementById(i % 4 === 3 ? 'previous' : 'next').click();
      const preview = document.getElementById('pdf-passage');
      preview.dispatchEvent(new Event('wheel')); preview.scrollTop = i % 2 ? preview.scrollHeight : 0;
      preview.dispatchEvent(new Event('scroll'));
      maxQueued = Math.max(maxQueued, doc.work.jobs.length);
      if (!doc.layout.preparation.complete) partialMoves++;
      positions.add(document.getElementById('position').value);
      notices.add(document.getElementById('notice-text').textContent);
      if (i === 15) __visibility(true);
      if (i === 40) __visibility(false);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    __visibility(false);
    return { maxQueued, partialMoves, positions: positions.size, progressUpdates: notices.size, sameDocument: doc === __pdfForTest };
  });
  assert.ok(result.movement.partialMoves >= 10); assert.ok(result.movement.maxQueued < 30);
  assert.ok(result.movement.positions >= 2);
  assert.ok(result.movement.progressUpdates >= 2);
  assert.ok(result.movement.sameDocument);
  await waitForPdfReady(page, 240000);
  await expect.poll(() => page.evaluate(() => __pdfForTest.work.jobs.length), { timeout: 60000 }).toBe(0);
  result.pages = await page.evaluate(() => __pdfForTest.layout.preparation);
  result.images = await page.evaluate(async () => {
    const layout = __pdfForTest.layout;
    const { pdfGalleryItems } = await import('/src/pdf-captions.js');
    const image = pdfGalleryItems(layout).find(item => item.block.page === 1);
    if (!image?.block.fullPage || image.block.drawHeight > 258) throw new Error('Cover was fragmented');
    const full = await layout.pdf.drawFigure(image.block, { maxWidth: 1000, maxHeight: 1500 });
    full.id = 'inspection-test'; full.style.cssText = 'width:500px;height:auto;aspect-ratio:auto'; document.body.append(full);
    return { fullPages: layout.blocks.filter(block => block.fullPage).map(block => block.page),
      previewWidth: full.width, previewHeight: full.height, coverBlocks: layout.blocks.filter(block => block.page === 1).length,
      nativeBody: layout.blocks.some(block => block.reflow) };
  });
  assert.equal(result.images.coverBlocks, 1); assert.ok(result.images.previewHeight > 900);
  if (process.env.PDF_SAMPLE) assert.ok(result.images.nativeBody, 'scanned prose must still reflow');
  await page.locator('#inspection-test').screenshot({ path: path.join(dir, 'whole-page-inspection.png') });
  await page.setViewportSize({ width: 440, height: 806 });
  await page.locator('#pdf-gallery .figure-thumbnail').first().evaluate(button => button.click());
  await expect(page.locator('#figure-dialog .figure-image canvas')).toBeVisible({ timeout: 60000 });
  await expect(page.locator('#figure-dialog .figure-title')).toContainText('Page image');
  await page.locator('#figure-dialog').screenshot({ path: path.join(dir, 'phone-page-image.png') });
  const diagnostics = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')));
  result.pdfErrors = (diagnostics.errors || []).filter(error => error.startedAt === diagnostics.startedAt && error.type.startsWith('pdf-'));
  assert.deepEqual(result.pdfErrors, []); assert.deepEqual(result.errors, []);
  result.passed = true; console.log(JSON.stringify(result));
} catch (error) {
  result.error = error.stack; if (page) await page.screenshot({ path: path.join(dir, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally { await writeFile(path.join(dir, 'result.json'), JSON.stringify(result, null, 2)); await browser.close(); await server.close(); }
