// Exercise the packaged private app, with all Terminal traffic intercepted.
// No prompts reach a real agent; the saved token is never printed or exported.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { debugTerminalConnection } from './debug-terminal.mjs';
import { AtomicPhoneValue } from '../src/phone-storage.js';
import { showLibrary, showTool, hideSettings, backToReading } from './ui-helpers.mjs';

const build = JSON.parse(await readFile('dist/build-info.json', 'utf8'));
assert(build.automaticTerminal, 'Build the private debug app with automatic pairing first.');
const config = debugTerminalConnection(build, { ...loadEnv('debug', process.cwd(), 'PAGEBORNE_'), ...process.env });
const modelHashes = JSON.parse(await readFile('node_modules/@pageborne/browser-stt/vendor/stt/ensemble-models.json', 'utf8')).flatMap(model => model.files.map(file => file.sha256));
assert(config, 'The local private pairing configuration is required.');
const out = path.resolve('test-results/ask-automatic'); await mkdir(out, { recursive: true });
const server = createApp({ distDir: path.resolve('dist') }).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const result = { passed: false, errors: [] };
try {
  for (const native of [false, true]) {
    const context = await browser.newContext({ viewport: native ? { width: 440, height: 806 } : { width: 1280, height: 900 } });
    const phoneStorage = new Map(); const sessions = new Map(); const prompts = []; let serial = 0;
    await context.exposeFunction('__storage', ({ method, data }) => {
      if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
      if (method === 'getLocalStorage') return phoneStorage.get(data.key) || '';
      phoneStorage.set(data.key, data.value); return true;
    });
    await context.addInitScript(({ native, modelHashes }) => {
      // Connection coverage does not download or initialise speech models.
      const NativeWorker = Worker;
      window.Worker = class {
        constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
        postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
        terminate() {}
      };
      if (!native) {
        const open = indexedDB.open('pageborne-ensemble-weights-v1', 1);
        open.onupgradeneeded = () => { open.result.createObjectStore('files'); open.result.createObjectStore('chunks'); };
        open.onsuccess = () => {
          const tx = open.result.transaction('files', 'readwrite');
          for (const hash of modelHashes) tx.objectStore('files').put({ id: 'fixture', chunks: 0, headers: {} }, hash);
          tx.oncomplete = () => open.result.close();
        };
      }
      if (native) window.flutter_inappwebview = { async callHandler(_, serialized) {
        const m = JSON.parse(serialized);
        if (m.method.endsWith('LocalStorage')) return window.__storage(m);
        return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
      } };
      // A saved, incomplete provider setup must not take priority over the
      // private Terminal connection, including after native storage hydration.
      if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'provider', baseUrl: '', model: 'old-model' } }));
    }, { native, modelHashes });
    const expectedEndpoint = !native && config.previewEndpoint ? config.previewEndpoint : config.endpoint;
    // Catch any network request, including an accidental wrong-host fallback.
    await context.route('**/api/**', async route => {
      const req = route.request(); const url = new URL(req.url());
      assert.equal(url.origin, new URL(expectedEndpoint).origin);
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, ngrok-skip-browser-warning' };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      assert.ok(req.headers().authorization === `Bearer ${config.token}`, 'Request uses the saved Terminal credential');
      assert(['claude', 'codex'].includes(url.searchParams.get('provider')));
      const json = body => route.fulfill({ headers, json: body });
      if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ':connected\n\n' });
      if (['/api/pageborne/reader-state', '/api/pageborne/library', '/api/pageborne/reading-activity'].includes(url.pathname)) return route.fulfill({ status: 404, headers, json: {} });
      if (url.pathname === '/api/info') return json({ provider: config.agent });
      if (url.pathname.endsWith('/history')) return json({ history: [] });
      if (url.pathname === '/api/messages') return json({ state: 'idle', messages: (sessions.get(url.searchParams.get('sessionId')) || []).filter(m => m.id > Number(url.searchParams.get('after') || 0)) });
      if (url.pathname === '/api/prompt') {
        const body = req.postDataJSON(); prompts.push(body);
        const id = body.sessionId || `automatic-${++serial}`; const messages = sessions.get(id) || []; const n = messages.at(-1)?.id || 0;
        sessions.set(id, [...messages, { id: n + 1, type: 'user_prompt', text: body.text }, { id: n + 2, type: 'result', success: true, text: `Automatic connection answer from ${id}.` }]);
        return json({ sessionId: id });
      }
      throw new Error(`Unexpected Terminal route: ${url.pathname}`);
    });
    let page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
    if (native) await expect(page.locator('#connection-state')).toHaveText('Connected');
    await showTool(page, 'settings');
    await expect(page.locator('#ask-connection-settings')).toBeHidden();
    await expect(page.locator('#ask-token')).toHaveValue('');
    await expect(page.locator('#ask-default-model')).toBeVisible();
    await expect(page.locator('#ask-default-model')).toHaveValue(config.agent);
    await expect(page.locator('#theme-control')).toBeVisible();
    await hideSettings(page); await showLibrary(page);
    await page.locator('#file-picker').setInputFiles(['first.md', 'second.md'].map(name => ({ name, mimeType: 'text/markdown', buffer: Buffer.from('# Notebook\n\nThe notebook is blue and has twelve pages.\n\n'.repeat(20)) })));
    const open = async name => { await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click(); await expect(page.locator('#ask-open')).toBeEnabled(); };
    const ask = async id => {
      await page.locator('#ask-open').click();
      await expect(page.locator('#ask-settings-link')).toBeHidden();
      await expect(page.locator('#ask-paper-directory-settings')).toBeHidden();
      await page.locator('#ask-question').fill('What color is the notebook?'); await page.locator('#ask-send').click();
      await expect(page.locator('#ask-answer')).toContainText(`answer from ${id}`);
      await backToReading(page);
    };
    await open('first.md'); await ask('automatic-1');
    assert(!prompts[0].sessionId); assert(!prompts[0].cwd);
    await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await open('first.md'); await ask('automatic-1');
    assert.equal(prompts[1].sessionId, 'automatic-1');
    await open('second.md'); await ask('automatic-2'); assert(!prompts[2].sessionId);
    await open('first.md'); await ask('automatic-1'); assert.equal(prompts[3].sessionId, 'automatic-1');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const saved = await page.evaluate(() => localStorage.getItem('even-reader:preferences:v1'));
    assert(!saved.includes(config.token), 'Bundled credential is not copied to browser preferences');
    assert(![...phoneStorage.values()].some(v => v.includes(config.token)), 'Bundled credential is not copied to phone storage or diagnostics');
    assert(!JSON.stringify(await page.evaluate(() => localStorage.getItem('even-reader:diagnostics:v1'))).includes(config.token));
    let migrated = false;
    if (config.previousEndpoints?.length) {
      const previous = config.previousEndpoints[0]; const legacy = JSON.parse(saved);
      delete legacy.terminalMigrations;
      for (const field of ['askSessions', 'askChats']) for (const key of Object.keys(legacy[field] || {})) {
        const parts = JSON.parse(key); if (parts[2] !== expectedEndpoint) continue;
        parts[2] = previous; legacy[field][JSON.stringify(parts)] = legacy[field][key]; delete legacy[field][key];
      }
      legacy.librarySync = { [previous]: { id: 'retained-library', at: 123, directory: '/paper-library', files: { 'deleted.md': 'retained-deletion-baseline' } } };
      legacy.updatedAt = Date.now();
      await page.close();
      if (native) {
        const kv = { get: async key => phoneStorage.get(key) || '', set: async (key, value) => phoneStorage.set(key, value) };
        const prefs = new AtomicPhoneValue(kv, 'preferences'); await prefs.read(); await prefs.write(legacy);
      }
      await context.addInitScript(({ native, legacy }) => {
        if (native) localStorage.removeItem('even-reader:preferences:v1');
        else localStorage.setItem('even-reader:preferences:v1', JSON.stringify(legacy));
      }, { native, legacy });
      page = await context.newPage(); page.on('pageerror', e => result.errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}`); await expect(page.locator('#import')).toBeEnabled();
      await open('first.md'); await ask('automatic-1');
      assert.equal(prompts[4].sessionId, 'automatic-1');
      const restored = JSON.parse(await page.evaluate(() => localStorage.getItem('even-reader:preferences:v1')));
      assert.deepEqual(restored.librarySync[expectedEndpoint], legacy.librarySync[previous]);
      assert(Object.entries(restored.askChats).some(([key, turns]) => JSON.parse(key)[2] === expectedEndpoint && turns.length >= 4));
      migrated = true;
    }
    await page.locator('#ask-open').click();
    await expect(page.locator('#ask-chat-model')).toBeVisible();
    await expect(page.locator('#ask-chat-model option[value=claude]')).toHaveText('Claude Fable 5.2');
    await expect(page.locator('#ask-default-model option[value=claude]')).toHaveText('Claude Fable 5.2');
    await expect(page.locator('#ask-session-model')).toBeVisible();
    const otherAgent = config.agent === 'claude' ? 'codex' : 'claude';
    await page.locator('#ask-chat-model').selectOption(otherAgent);
    await expect(page.locator('.ask-message-user')).toHaveCount(0);
    await page.locator('#ask-question').fill('What color is the notebook?'); await page.locator('#ask-send').click();
    await expect(page.locator('#ask-answer')).toContainText('answer from automatic-3');
    await page.locator('#ask-chat-model').selectOption(config.agent);
    await expect(page.locator('#ask-answer')).toContainText('answer from automatic-1');
    const switched = await page.evaluate(() => localStorage.getItem('even-reader:preferences:v1'));
    assert(!switched.includes(config.token), 'Model selection never persists the bundled token');
    const preferences = JSON.parse(switched);
    const firstKey = Object.keys(preferences.askSessions).find(key => preferences.askSessions[key].sessionId === 'automatic-1');
    assert.equal(preferences.askModels.selections[JSON.stringify([JSON.parse(firstKey)[0]])], config.agent);
    await page.screenshot({ path: path.join(out, native ? 'phone.png' : 'desktop.png') });
    result[native ? 'phone' : 'desktop'] = { setupRequired: false, authenticatedQuestions: prompts.length, perPaperSessions: true, sessionRestoredAfterReload: true, endpointMigration: migrated, credentialsKeptOutOfPreferencesAndLogs: true };
    await context.close();
  }
  assert.deepEqual(result.errors, []); result.passed = true;
} finally {
  await writeFile(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
console.log(JSON.stringify(result));
