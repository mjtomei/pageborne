// Real UI/SDK, rejected native writes and touch input; no OCR or speech models.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { PhoneLibrary, AtomicPhoneValue } from '../src/phone-storage.js';
import { PdfPreparationCache } from '../src/pdf-cache.js';
import { phoneReadingStorage } from '../src/reading-storage.js';
import { readLocalFile } from '../src/library.js';
import { showLibrary } from './ui-helpers.mjs';

const endpoint = 'https://library-fixture.invalid';
// Explicit origins also disable private automatic pairing in the Vite config.
process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
const out = 'test-results/library-recovery'; await mkdir(out, { recursive: true });
const server = await createServer({ mode: 'debug', cacheDir: '.state/vite-library-recovery', clearScreen: false,
  optimizeDeps: { entries: ['index.html'] },
  plugins: [{ name: 'skip-inference', transform(code, id) {
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
  } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--disable-gpu'] });
const values = new Map(), errors = [], requests = [], report = { nativeWriteRejections: 0 };
const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
const library = new PhoneLibrary(kv); await library.read();
for (let i = 0; i < 25; i++) await library.save(await readLocalFile(new File([`%PDF-1.4\nfixture-${i}\n%%EOF`], `paper-${String(i).padStart(2, '0')}.pdf`)));
const target = library.snapshot.documents[18], kept = library.snapshot.documents[0];
const prefs = { updatedAt: 1, ask: { mode: 'terminal', endpoint, token: 'fixture', agent: 'claude' }, positions: {}, bookmarks: {}, librarySort: 'name' };
await new AtomicPhoneValue(kv, 'preferences').write(prefs);
const history = { id: 'saved-reading', day: '2026-01-01', at: '2026-01-01T12:00:00.000Z', words: 100, seconds: 60,
  document: { id: target.id, key: target.positionKey, title: target.title }, scope: '', platform: 'glasses', sessions: [] };
await phoneReadingStorage(kv).merge([history]);
await new PdfPreparationCache(kv).forDocument(kept.id).write('fixture', { text: 'Derived layout '.repeat(20000) });
values.set('pageborne:models:v1:untouched:0', 'Complete model fixture');
const originalKeys = new Map([...values].filter(([key]) => key.startsWith(kept.revision + ':')));
const usage = () => [...values.values()].reduce((sum, value) => sum + value.length, 0);
let quota = Infinity, rejectNonempty = false, releaseManifest;
const manifestReady = new Promise(resolve => releaseManifest = resolve);
const context = await browser.newContext({ viewport: { width: 440, height: 806 }, isMobile: true, hasTouch: true });
await context.route('**/api/**', async route => {
  const request = route.request(), url = new URL(request.url()); requests.push({ method: request.method(), path: url.pathname });
  assert.equal(url.origin, endpoint, 'tests must not inherit private developer pairing');
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers, body: '' });
  if (url.pathname.endsWith('/pageborne/library')) {
    await manifestReady;
    return route.fulfill({ headers, json: { version: 1, id: 'fixture-library', directory: 'fixture', files: library.snapshot.documents.map((doc, i) =>
      ({ name: doc.id, bytes: doc.bytes, sha256: doc.sha256, readingWords: (i + 1) * 1000 })) } });
  }
  return route.fulfill({ headers, json: { version: 1, days: [], documents: [], entries: [], messages: [], sessions: [], state: 'idle' } });
});
await context.exposeFunction('__storage', ({ method, data }) => {
  if (method === 'getLocalStorage') return kv.get(data.key);
  if (data.value && (rejectNonempty || usage() - (values.get(data.key)?.length || 0) + data.value.length > quota)) { report.nativeWriteRejections++; return false; }
  values.set(data.key, data.value); return true;
});
await context.addInitScript(() => {
  window.flutter_inappwebview = { async callHandler(_, payload) {
    const message = JSON.parse(payload);
    if (message.method.endsWith('LocalStorage')) return window.__storage(message);
    // Match the user's separate native display rejection. Library still works.
    return message.method === 'createStartUpPageContainer' ? 1 : message.method === 'updateImageRawData' ? 0 : true;
  } };
});
const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(server.resolvedUrls.local[0]); releaseManifest(); await expect(page.locator('#import')).toBeEnabled();
  const displayFailure = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).errors.find(e => e.type === 'display-error'));
  assert.equal(displayFailure.context.resultName, 'invalid'); assert.equal(displayFailure.context.validation, 'valid');
  await showLibrary(page);
  await expect.poll(() => requests.some(r => r.path.endsWith('/pageborne/library'))).toBe(true);
  releaseManifest();
  await expect(page.locator('#library-sync')).toBeEnabled();
  await expect(page.locator('.document-reading-time').filter({ hasText: '—' })).toHaveCount(0);
  await expect(page.locator('#library-sync')).toBeEnabled();
  quota = usage(); rejectNonempty = true;
  assert(requests.every(r => !r.path.includes('/library/') && !(r.path.endsWith('/library') && !['GET', 'OPTIONS'].includes(r.method))), 'count refresh must never change desktop files');
  const row = page.locator(`[data-document-id="${target.id}"]`);
  await row.locator('.document-delete').tap();
  const confirm = row.locator('[data-confirm-delete]'); await confirm.scrollIntoViewIfNeeded();
  await confirm.evaluate(button => { window.__deleteButton = button; });
  await confirm.tap();
  await expect(row.locator('.delete-status')).toContainText('Could not delete: Even app storage rejected');
  await expect(confirm).toBeEnabled();
  assert(await confirm.evaluate(button => button === window.__deleteButton), 'failed deletion keeps the tapped control mounted');
  await row.screenshot({ path: `${out}/inline-delete-error.png` });
  const failure = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:diagnostics:v1')).errors.find(e => e.type === 'library-delete-error'));
  assert.equal(failure.context.stage, 'library-index'); assert.equal(failure.context.code, 'phone-storage-write');
  assert.equal((await new PhoneLibrary(kv).read()).documents.length, 25, 'refused deletion preserves the original');
  rejectNonempty = false;
  await confirm.tap(); await expect(row).toHaveCount(0);
  assert.equal((await new PhoneLibrary(kv).read()).documents.length, 24);
  assert.deepEqual(await phoneReadingStorage(kv).read(), [history]);
  for (const [key, value] of originalKeys) assert.equal(values.get(key), value);
  assert.equal(values.get('pageborne:models:v1:untouched:0'), 'Complete model fixture');
  await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await showLibrary(page);
  await expect(page.locator(`[data-document-id="${target.id}"]`)).toHaveCount(0);
  await expect(page.locator('.document-reading-time').filter({ hasText: '—' })).toHaveCount(0);
  assert((await new PhoneLibrary(kv).read()).documents.every(doc => Number.isInteger(doc.readingWords)), 'counts persist once writes recover');
  assert.deepEqual(errors, []);
  Object.assign(report, { passed: true, touchDelete: true, survivesReload: true, historyPreserved: true, originalsAndModelsPreserved: true,
    counts: 24, readOnlyMetadataRefresh: true, nativeDisplayFailureIsolated: true });
} catch (error) { report.error = error.stack; throw error; }
finally { releaseManifest(); await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await context.close(); await browser.close(); await server.close(); }
console.log(JSON.stringify(report));
