// Real app and SDK, simulated host loss; no model weights or GPU inference.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { showLibrary } from './ui-helpers.mjs';

const endpoint = 'https://library-fixture.invalid', out = 'test-results/library-on-demand';
process.env.PAGEBORNE_ASK_ORIGINS = endpoint;
await mkdir(out, { recursive: true });
const server = await createServer({ mode: 'debug', cacheDir: '.state/vite-library-on-demand', clearScreen: false,
  optimizeDeps: { entries: ['index.html'] },
  plugins: [{ name: 'skip-voice-inference', transform(code, id) {
    if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return initialize();');
  } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
await server.listen();
const browser = process.env.LIBRARY_BROWSER === 'webkit'
  ? await webkit.launch({ executablePath: process.env.WEBKIT_PATH, headless: true })
  : await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--disable-gpu'] });
const report = [];
try {
  for (const mode of ['ok', 'false', 'null', 'large']) {
    const healthy = ['ok','large'].includes(mode);
    const content = mode === 'large' && process.env.LIBRARY_BOOK_PATH ? await readFile(process.env.LIBRARY_BOOK_PATH, 'utf8')
      : '# Desktop book\n\n' + 'This passage downloads only when opened. '.repeat(mode === 'large' ? 32000 : 30), bytes = Buffer.from(content);
    const file = { name: 'book.md', title: 'Desktop book', bytes: bytes.length, words: 180, sha256: createHash('sha256').update(bytes).digest('hex') };
    const values = new Map(), errors = [], requests = []; let writes = 0, offline = false;
    const context = await browser.newContext({ viewport: { width: 440, height: 806 }, isMobile: true, hasTouch: true });
    await context.route(endpoint + '/**', async route => {
      const request = route.request(), url = new URL(request.url()); requests.push({ path: url.pathname, method: request.method() });
      const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (offline) return route.abort();
      if (url.pathname.endsWith('/pageborne/library')) return route.fulfill({ headers, json: { version: 1, id: 'fixture', directory: 'Desktop library', files: [file], skipped: [] } });
      if (url.pathname.endsWith('/pageborne/library/read')) {
        const { offset = 0 } = request.postDataJSON();
        return route.fulfill({ headers, json: { ...file, offset, data: bytes.subarray(offset,offset+768*1024).toString('base64') } });
      }
      return route.fulfill({ headers, json: { version: 1, observations: 2, days: [], documents: [], entries: [], messages: [], sessions: [], state: 'idle' } });
    });
    await context.exposeFunction('__nativeStorage', ({ method, data }) => {
      if (method === 'getLocalStorage') return mode === 'null' ? null : values.get(data.key) || '';
      writes++; if (mode === 'large' && data.key.includes(':doc:')) return new Promise(() => {});
      if (!healthy) return mode === 'false' ? false : null;
      values.set(data.key, data.value); return true;
    });
    await context.addInitScript(({ endpoint, mode }) => {
      localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ updatedAt: 1, positions: {}, bookmarks: {}, ask: { mode: 'terminal', endpoint, token: 'fixture', agent: 'claude' } }));
      window.flutter_inappwebview = { async callHandler(_, payload) {
        const message = JSON.parse(payload);
        if (message.method.endsWith('LocalStorage')) return window.__nativeStorage(message);
        if (message.method === 'createStartUpPageContainer') return ['ok','large'].includes(mode) ? 0 : mode === 'null' ? null : 1;
        return message.method === 'updateImageRawData' ? 0 : true;
      } };
    }, { endpoint, mode });
    const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    if (mode === 'large' && process.env.LIBRARY_CPU_RATE && process.env.LIBRARY_BROWSER !== 'webkit') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.LIBRARY_CPU_RATE) });
    }
    await page.goto(server.resolvedUrls.local[0]);
    const row = page.locator('[data-document-id="book.md"]'); await expect(row).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#library-sync')).toBeEnabled();
    assert(!requests.some(r => r.path.endsWith('/library/read')), 'catalog must not eagerly download bodies');
    await expect(row.locator('.document-details')).toContainText('On desktop');
    if (!healthy) {
      await expect(page.locator('#import')).toBeDisabled(); await expect(row.locator('.document-delete')).toBeDisabled();
      await expect(page.locator('#library-storage-status')).toContainText('Even storage is unavailable');
      assert(writes <= 2, 'unavailable diagnostics must stop native save retries');
    }
    await row.locator('.document-card').tap(); await expect(page.locator('#bookmark')).toBeEnabled({ timeout: 30000 });
    await expect(page.locator('#title')).not.toHaveText('Choose something good.');
    await expect(page.locator('#notice-text')).not.toContainText('Could not open');
    assert(requests.some(r => r.path.endsWith('/library/read')));
    if (mode === 'large') {
      await expect(page.locator('#notice-text')).not.toContainText('Indexing');
      await page.locator('#position').evaluate(input => { input.value = '500'; input.dispatchEvent(new Event('input', {bubbles:true})); input.dispatchEvent(new Event('change', {bubbles:true})); });
      await expect(page.locator('#position-value')).toContainText('50%');
    }
    await showLibrary(page);
    await expect(row.locator('.document-details')).toContainText(mode === 'ok' ? 'Offline' : 'On desktop');
    assert(!requests.some(r => /\/library\/(remove|commit|chunk|status)$/.test(r.path)), 'read-only operations must never mutate desktop files');
    await page.screenshot({ path: `${out}/${mode}.png` });
    if (mode === 'ok') {
      offline = true; const reads = requests.filter(r => r.path.endsWith('/library/read')).length;
      await page.reload(); await expect(page.locator('#bookmark')).toBeEnabled();
      await showLibrary(page); await expect(row).toBeVisible();
      await row.locator('.document-card').tap(); await expect(page.locator('#bookmark')).toBeEnabled();
      assert.equal(requests.filter(r => r.path.endsWith('/library/read')).length, reads, 'offline reopen uses saved bytes');
    }
    assert.deepEqual(errors, []);
    report.push({ mode, passed: true, writes, catalogOnlySync: true, opened: true, offlineRestart: mode === 'ok' });
    await context.close();
  }
  // A worker that never responds must release its resources on deadline or
  // cancellation. No inference, native storage, or long wall-clock wait.
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  const recovery = await page.evaluate(async () => {
    const { prepareTextInBackground } = await import('/src/text-reader.js');
    const Original = window.Worker; let terminated = 0;
    window.Worker = class { postMessage() {} terminate() { terminated++; } };
    try {
      let timeout = '', cancelled = '';
      try { await prepareTextInBackground('book', undefined, () => {}, { timeout: 20 }); } catch (e) { timeout = e.message; }
      const controller = new AbortController();
      const pending = prepareTextInBackground('book', controller.signal); controller.abort();
      try { await pending; } catch (e) { cancelled = e.name; }
      return { timeout, cancelled, terminated };
    } finally { window.Worker = Original; }
  });
  assert.match(recovery.timeout, /too long/); assert.equal(recovery.cancelled, 'AbortError'); assert.equal(recovery.terminated, 2);
  report.push({ workerRecovery: recovery }); await page.close();
} finally { await writeFile(`${out}/results.json`, JSON.stringify(report, null, 2)); await browser.close(); await server.close(); }
console.log(JSON.stringify(report));
