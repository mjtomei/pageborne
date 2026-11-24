// Real built app, PDF rendering and durable native storage. Speech is mocked.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { PhoneLibrary, PhonePreferences, AtomicPhoneValue } from '../src/phone-storage.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary, showTool, waitForPdfReady } from './ui-helpers.mjs';

const out = 'test-results/pdf-startup'; await mkdir(out, { recursive: true });
const engine = process.env.STARTUP_BROWSER === 'webkit' ? webkit : chromium;
const values = new Map(), errors = [];
const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
const library = new PhoneLibrary(kv); await library.read();
const bytes = pdfFixture('mixed');
await library.save({ id: 'saved.pdf', title: 'Saved PDF', format: 'pdf', content: bytes.toString('base64'), bytes: bytes.length, words: 100 });
const positions = { 'local\nsaved.pdf': { percent: 25 } };
const chats = { preserved: 'Existing conversation' };
await new AtomicPhoneValue(kv, 'preferences').write({ updatedAt: 100, selected: { id: 'saved.pdf' }, positions, bookmarks: {}, chats });
const server = createApp({ distDir: process.cwd() + '/dist' }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const browser = await engine.launch({ executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true });
const context = await browser.newContext({ viewport: { width: 440, height: 806 } });
await context.exposeFunction('__storage', m => {
  if (m.method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(m.data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
  return m.method === 'getLocalStorage' ? kv.get(m.data.key) : kv.set(m.data.key, m.data.value).then(() => true);
});
await context.addInitScript(() => {
  window.__readingWorkers = 0;
  const NativeWorker = window.Worker;
  window.Worker = class {
    constructor(url, options) { if (!String(url).includes('ensemble-worker')) { window.__readingWorkers++; return new NativeWorker(url, options); } }
    postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
    terminate() {}
  };
  window.flutter_inappwebview = { async callHandler(_, payload) {
    const m = JSON.parse(payload);
    if (m.method.endsWith('LocalStorage')) return __storage(m);
    return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
  } };
});
await context.route('**/api/**', route => route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' }));
const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('crash', () => errors.push('Page crashed'));
const report = { engine: engine.name(), errors };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#library-panel')).toBeVisible();
  await expect(page.locator('#library-sync')).toBeEnabled();
  await expect(page.locator('#title')).toHaveText('Choose something good.');
  assert.equal(await page.evaluate(() => window.__readingWorkers), 0, 'startup must not decode the saved PDF');
  const saved = await new PhonePreferences(kv).read({});
  assert.deepEqual(saved.positions, positions); assert.deepEqual(saved.chats, chats);
  await page.locator('[data-document-id="saved.pdf"] .document-card').click();
  await waitForPdfReady(page, 60000);
  await page.locator('#position').evaluate(input => { input.value = '500'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#bookmark-quick').click();
  const position = await page.locator('#position').inputValue();
  await expect.poll(async () => Object.values((await new PhonePreferences(kv).read({})).bookmarks || {}).flat().length).toBe(1);
  await page.reload();
  // Reload can interrupt the independent idle voice preload. Its recovery
  // dialog must still allow entering the library without resuming the PDF.
  await expect.poll(async () => {
    const skip = page.locator('#speech-setup-skip');
    if (await skip.isVisible() && await skip.isEnabled()) { await skip.click(); report.voiceRecoveryReachable = true; }
    return page.locator('#import').isEnabled();
  }, { timeout: 30000 }).toBe(true);
  await expect(page.locator('#library-panel')).toBeVisible();
  await expect(page.locator('#library-sync')).toBeEnabled();
  assert.equal(await page.evaluate(() => window.__readingWorkers), 0, 'a subsequent launch must also stay out of the PDF');
  await page.locator('[data-document-id="saved.pdf"] .document-card').click();
  await waitForPdfReady(page, 60000);
  await expect(page.locator('#position')).toHaveValue(position);
  await showTool(page, 'bookmarks'); await expect(page.locator('#bookmarks .bookmark-row')).toHaveCount(1);
  await showLibrary(page);
  const restored = await new PhoneLibrary(kv).read();
  assert.equal(restored.documents.length, 1); assert.equal(restored.documents[0].content, bytes.toString('base64'));
  assert.deepEqual((await new PhonePreferences(kv).read({})).chats, chats);
  assert.deepEqual(errors, []);
  Object.assign(report, { passed: true, coldStartAvoidsPdf: true, syncReachable: true, explicitResume: true, bookmarkRestored: true, originalAndChatPreserved: true });
  console.log(JSON.stringify(report));
} catch (error) { report.error = error.stack; await page.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); throw error; }
finally { await writeFile(`${out}/${engine.name()}.json`, JSON.stringify(report, null, 2)); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
