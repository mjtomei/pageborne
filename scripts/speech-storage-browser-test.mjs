// Real app and SDK storage, synthetic weights/workers: quota recovery and data
// preservation, not recognizer accuracy or a physical iPhone measurement.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { EnsembleModelStore } from '@pageborne/browser-stt';
import { AtomicPhoneValue, PhoneLibrary, STORAGE_PREFIX } from '../src/phone-storage.js';
import { PdfPreparationCache } from '../src/pdf-cache.js';
import { phoneReadingStorage } from '../src/reading-storage.js';
import { readLocalFile } from '../src/library.js';
import { displayProbe } from './display-probe.mjs';
import { showLibrary, showSettings } from './ui-helpers.mjs';

process.env.PAGEBORNE_AUTOMATIC_TERMINAL = 'false';
const out = 'test-results/speech-storage'; await mkdir(out, { recursive: true });
const fixtures = ['conformer', 'zipformer', 'moonshine'].map((id, i) => {
  const bytes = Buffer.alloc(48001 + i, i + 1);
  return { bytes, model: { id, name: id, files: [{ file: 'model.onnx', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), url: `https://models.invalid/${id}.onnx` }] } };
});
const vite = await createServer({ mode: 'debug', cacheDir: '.state/vite-storage-recovery', clearScreen: false,
  optimizeDeps: { exclude: ['@pageborne/browser-stt'] },
  plugins: [displayProbe(), { name: 'quota-fixtures', enforce: 'pre', transform(code, id) {
    if (id.split('?')[0].endsWith('/ensemble-speech.js')) return code.replace(/import manifests from [^;]+;/, `const manifests = ${JSON.stringify(fixtures.map(f => f.model))};`);
  } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
const values = new Map(), errors = [], report = { mockedWorkers: true, quotaFailures: 0, networkModelRequests: 0 };
const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
const words = 'This saved document must remain readable after voice setup fails. '.repeat(80);
const library = new PhoneLibrary(kv); await library.read(); await library.save(await readLocalFile(new File([words], 'kept.md')));
const preferences = { updatedAt: 1, ask: { mode: 'terminal', endpoint: vite.resolvedUrls.local[0], token: 'fixture', agent: 'claude' },
  positions: { 'local\nkept.md': { percent: 42, sourceLine: 2 } }, bookmarks: { 'local\nkept.md': [{ sourceLine: 1 }] },
  askSessions: { fixture: { sessionId: 'kept-session' } }, askChats: { fixture: [{ id: 'turn', question: 'Saved question', answer: 'Saved answer', state: 'complete' }] } };
await new AtomicPhoneValue(kv, 'preferences').write(preferences);
const history = { id: 'reading', day: '2026-01-01', at: '2026-01-01T12:00:00.000Z', words: 100, seconds: 60,
  document: { id: 'kept.md', key: 'local\nkept.md', title: 'Kept document' }, scope: '', platform: 'glasses', sessions: [] };
await phoneReadingStorage(kv).merge([history]);
await new PdfPreparationCache(kv).forDocument('kept.md').write('fixture', { text: 'Cached layout '.repeat(20000) });
const modelStore = new EnsembleModelStore({ kv, fetch: async url => new Response(fixtures.find(f => f.model.files[0].url === url).bytes) });
for (const fixture of fixtures) await modelStore.ensure(fixture.model.files[0]);
const modelKey = fixtures[0].model.files[0].sha256, prefix = 'pageborne:models:v1:';
values.set(prefix + 'pending:' + modelKey, JSON.stringify({ id: 'orphan', chunks: 2 }));
values.set(prefix + 'orphan:0', 'a'.repeat(32000)); values.set(prefix + 'orphan:1', 'b'.repeat(32000));
const usage = () => [...values.values()].reduce((sum, value) => sum + value.length, 0), quota = usage();
let context, page;
async function open() {
  context = await browser.newContext({ viewport: { width: 440, height: 806 } });
  await context.route('https://models.invalid/**', route => { report.networkModelRequests++; return route.abort(); });
  await context.route('**/api/**', route => route.fulfill({ json: { provider: 'claude', state: 'idle', messages: [], history: [], sessions: [] } }));
  await context.exposeFunction('__storage', ({ method, data }) => {
    if (method === 'getLocalStorage') return values.get(data.key) || '';
    if (usage() - (values.get(data.key)?.length || 0) + data.value.length > quota) { report.quotaFailures++; return false; }
    values.set(data.key, data.value); return true;
  });
  await context.addInitScript(() => {
    window.__prepared = []; window.__nativeFrames = [];
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const message = JSON.parse(payload);
      if (message.method.endsWith('LocalStorage')) return window.__storage(message);
      if (message.method === 'textContainerUpgrade') window.__nativeFrames.push(message.data.content);
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(message.method) ? 0 : true;
    } };
    const NativeWorker = Worker;
    window.Worker = class {
      constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); this.serial = 0; this.pending = new Map(); }
      emit(data) { queueMicrotask(() => { if (!this.closed) this.onmessage({ data }); }); }
      cache(action, extra) { return new Promise((resolve, reject) => { const request = ++this.serial; this.pending.set(request, { resolve, reject }); this.emit({ cache: { action, request, ...extra } }); }); }
      async postMessage(data) {
        if (data.cacheReply) { const pending = this.pending.get(data.request); this.pending.delete(data.request); data.error ? pending.reject(Error(data.error)) : pending.resolve(data.value); return; }
        if (data.operation !== 'prepare') return;
        try {
          const file = data.model.files[0], handle = await this.cache('open', { file: file.file }); let bytes = 0;
          for (;;) { const next = await this.cache('read', { handle }); if (next.done) break; bytes += next.bytes.byteLength; }
          if (bytes !== file.bytes) throw Error('Incomplete saved model');
          window.__prepared.push(data.model.id); this.emit({ id: data.id, result: { backend: 'wasm', verified: true } });
        } catch (error) { this.emit({ id: data.id, error: error.message }); }
      }
      terminate() { this.closed = true; }
    };
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(vite.resolvedUrls.local[0]);
}
try {
  await open();
  await expect(page.locator('#speech-setup-skip')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#speech-setup [role=status]')).toContainText('Even could not save');
  assert(report.quotaFailures > 0); assert.equal(await page.evaluate(() => __prepared.length), 0);
  await page.locator('#speech-setup').screenshot({ path: `${out}/storage-failure.png` });
  await page.locator('#speech-setup-skip').click();
  await expect(page.locator('#import')).toBeEnabled();
  await showLibrary(page); await expect(page.locator('[data-document-id="kept.md"]')).toBeVisible();
  assert.deepEqual(await phoneReadingStorage(kv).read(), [history]);
  const saved = await new AtomicPhoneValue(kv, 'preferences').read();
  for (const key of ['positions', 'bookmarks', 'askSessions', 'askChats']) assert.deepEqual(saved[key], preferences[key]);
  await page.locator('#library-librarian').click();
  await expect(page.locator('#ask-question')).toBeEditable();
  await page.locator('#ask-question').fill('Typed Ask still works');
  assert.equal(await page.evaluate(() => __askUI.speech.setup.suspended), true);
  assert.equal(await page.evaluate(() => __prepared.length), 0, 'opening typed chat never restarts paused voice');
  await page.evaluate(() => __askUI.close());
  await showSettings(page); await page.locator('#speech-retry').click();
  await expect(page.locator('#speech-setup-free-space')).toBeEnabled();
  await page.locator('#speech-setup-free-space').click();
  await expect(page.locator('#speech-setup [role=status]')).toContainText('Cleared');
  assert.equal(values.get(prefix + 'orphan:0'), ''); assert.equal(values.get(prefix + 'orphan:1'), '');
  assert.equal([...values].filter(([key, value]) => key.includes(':pdf-cache:body:') && value).length, 0);
  assert.deepEqual(await phoneReadingStorage(kv).read(), [history]);
  const restored = new PhoneLibrary(kv); await restored.read(); assert.equal(restored.snapshot.documents[0].content, words);
  for (const fixture of fixtures) assert.deepEqual(Buffer.from(await (await modelStore.read(fixture.model.files[0])).arrayBuffer()), fixture.bytes);
  await page.locator('#speech-setup-retry').click();
  await expect(page.locator('#speech-setup')).not.toBeVisible({ timeout: 15000 });
  assert.equal(await page.evaluate(() => __askUI.speech.setup.suspended), false);
  assert.equal(await page.evaluate(() => __prepared.length), 3);
  assert.equal(report.networkModelRequests, 0, 'complete models survive cleanup without redownload');
  await page.evaluate(() => __askUI.diagnostics.flushCheckpoint());
  await context.close(); await open();
  await expect(page.locator('#import')).toBeEnabled({ timeout: 15000 });
  assert.equal(await page.evaluate(() => __prepared.length), 0, 'saved checks survive a fresh browser context');
  assert.deepEqual(errors, []);
  Object.assign(report, { passed: true, originalsPreserved: true, readingHistoryPreserved: true, chatsPreserved: true, continueWithoutVoice: true, cacheRecovery: true, savedModelsReused: true });
} finally {
  await browser.close(); await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify({ ...report, errors }, null, 2));
}
console.log(JSON.stringify(report));
