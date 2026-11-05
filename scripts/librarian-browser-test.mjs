// Exercise library/document session navigation with real UI and native storage;
// speech preparation and desktop responses are fixtures.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

const out = 'test-results/librarian'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'release', plugins: [displayProbe(), { name: 'librarian-speech-fixture', transform(code, id) {
  if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
} }], cacheDir: '.state/vite-librarian',
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen();
const reports = [];
try {
  for (const engine of process.env.LIBRARIAN_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const report = { engine: engine.name(), passed: false, physicalGlasses: false, errors: [] }; reports.push(report);
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      page.on('pageerror', error => report.errors.push(error.message));
      const storage = new Map();
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        if (method === 'getLocalStorage') return storage.get(data.key) || '';
        storage.set(data.key, data.value); return true;
      });
      await page.addInitScript(() => {
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
          terminate() {}
        };
        window.__images = 0; window.__boxes = {};
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          if (m.method === 'updateImageRawData') window.__images++;
          if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) window.__boxes = Object.fromEntries((m.data.textObject || []).map(box => [box.containerName, box]));
          if (m.method === 'textContainerUpgrade') window.__boxes[m.data.containerName] = m.data;
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      const prompts = [], sessions = new Map();
      await page.route('https://terminal.example/**', async route => {
        const url = new URL(route.request().url()), body = route.request().postDataJSON();
        let result;
        if (url.pathname === '/api/pageborne/library') result = { version: 1, id: 'library-one', directory: '/shared/library', files: [] };
        else if (url.pathname === '/api/info') result = { provider: 'codex', pageborne: { sessionTitles: 1 } };
        else if (url.pathname === '/api/prompt') {
          prompts.push(body); const id = body.sessionId || `session-${sessions.size + 1}`;
          const previous = sessions.get(id) || [], n = previous.at(-1)?.id || 0;
          sessions.set(id, [...previous, { id: n + 1, type: 'user_prompt', text: body.text }, { id: n + 2, type: 'result', success: true, text: `Reply ${prompts.length}` }]);
          result = { sessionId: id };
        } else if (url.pathname === '/api/messages') result = { state: 'idle', messages: sessions.get(url.searchParams.get('sessionId')) || [] };
        else if (url.pathname.endsWith('/history')) result = { history: [] };
        else if (url.pathname === '/api/events') { await route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }); return; }
        else throw new Error(`Unexpected endpoint ${url.pathname}`);
        await route.fulfill({ json: result });
      });
      const boot = async () => {
        await page.goto(vite.resolvedUrls.local[0]);
        await expect(page.locator('#library-librarian')).toBeEnabled({ timeout: 30000 });
        await page.evaluate(() => { const options = window.__askUI.options.bind(window.__askUI); window.__askUI.options = () => ({ ...options(), origins: ['https://terminal.example'] }); window.__askUI.readConfig = () => ({ mode: 'terminal', endpoint: 'https://terminal.example', token: 'fixture', agent: 'codex', cwd: '/paper-default', paperDirectories: true }); });
      };
      const gesture = action => page.evaluate(action => window.__glasses.onAction(action), action);
      const send = async text => {
        await page.locator('#ask-question').fill(text); await page.locator('#ask-send').click();
        await expect.poll(() => page.evaluate(() => window.__askUI.session.status)).toBe('answer');
      };
      await boot();
      // Empty library: use the actual selection menu's tap dispatch.
      await gesture('play');
      await expect(page.locator('#ask-panel')).toBeVisible();
      await expect(page.locator('.ask-title-label')).toHaveText('Librarian');
      await expect.poll(() => page.evaluate(() => window.__displayFrame?.message?.statusLeft)).toBe('Librarian');
      await page.screenshot({ path: `${out}/${engine.name()}-empty-library.png` });
      await send('What can you help me find?');
      assert.equal(prompts[0].cwd, '/shared/library'); assert.equal(prompts[0].sessionTitle, 'Librarian');
      assert(!prompts[0].text.includes('Reading context'));
      const librarianKey = await page.evaluate(() => window.__askUI.paperKey);
      const librarianId = await page.evaluate(() => window.__askUI.binding().sessionId);
      await gesture('back');
      await expect(page.locator('#ask-panel')).toBeHidden();
      await expect.poll(() => page.evaluate(() => window.__displayFrame?.picker?.items.some(item => item.title === 'Librarian'))).toBe(true);
      await page.locator('#file-picker').setInputFiles({ name: 'paper.md', mimeType: 'text/markdown', buffer: Buffer.from('# A paper\n\n' + 'A private passage about plants. '.repeat(100)) });
      await showLibrary(page); await page.locator('[data-document-id="paper.md"] .document-card').click();
      await page.evaluate(() => window.__askUI.open());
      await expect(page.locator('.ask-title-label')).toHaveText('Ask');
      await page.evaluate(() => { window.__askUI.config.paperDirectories = false; });
      await send('Explain the passage.');
      assert.equal(prompts[1].cwd, '/paper-default'); assert(!prompts[1].sessionId);
      assert(prompts[1].text.includes('A private passage about plants.'));
      const paperId = await page.evaluate(() => window.__askUI.binding().sessionId);
      assert.notEqual(paperId, librarianId);
      await gesture('back');
      await gesture('documents'); await gesture('previous'); await gesture('previous'); await gesture('play');
      await expect(page.locator('.ask-title-label')).toHaveText('Librarian');
      await expect(page.locator('#ask-history')).toContainText('What can you help me find?');
      await expect(page.locator('#ask-history')).not.toContainText('Explain the passage.');
      await send('Compare the documents.');
      assert.equal(prompts[2].sessionId, librarianId); assert(!prompts[2].text.includes('A private passage'));
      assert.equal(await page.evaluate(() => window.__askUI.paperKey), librarianKey);
      // A spoken follow-up uses the library scope and chat vocabulary too.
      await page.evaluate(() => {
        const ui = window.__askUI; ui.reviewSpeech('A dictated library question', { words: [] }, false);
      });
      await gesture('play');
      await expect.poll(() => prompts.length).toBe(4);
      await expect.poll(() => page.evaluate(() => window.__askUI.session.status)).toBe('answer');
      assert.equal(prompts[3].sessionId, librarianId);
      await gesture('back');
      // Native preference storage survives a fresh page/run.
      await boot(); await showLibrary(page); await page.locator('#library-librarian').click();
      await expect(page.locator('#ask-history')).toContainText('Compare the documents.');
      await send('Continue after reopening.');
      assert.equal(prompts[4].sessionId, librarianId);
      await page.screenshot({ path: `${out}/${engine.name()}-resumed.png` });
      await page.evaluate(() => window.__askUI.newSession());
      await expect(page.locator('#ask-history')).not.toContainText('Compare the documents.');
      await send('Start a fresh library conversation.');
      assert.equal(prompts[5].cwd, '/shared/library'); assert(!prompts[5].sessionId);
      assert.deepEqual(report.errors, []);
      Object.assign(report, { passed: true, emptyLibrary: true, rootDirectory: true, isolatedDocumentSession: true, glassesSelection: true, dictation: true, persistentSession: true, newSession: true });
    } catch (error) { report.error = error.stack; report.state = await page?.evaluate(() => ({ status: window.__askUI.session.status, error: window.__askUI.session.error })); await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }); throw error; }
    finally { await browser.close(); }
  }
} finally { await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); await vite.close(); }
console.log(JSON.stringify(reports));
