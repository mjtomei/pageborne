import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, showTool, hideSettings } from './ui-helpers.mjs';
import { displayProbe } from './display-probe.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://models.test';
const out = 'test-results/ask-models'; await mkdir(out, { recursive: true });
const vite = await createServer({ plugins: [displayProbe()], cacheDir: '.state/vite-ask-models', optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen(); const results = [];
try {
  for (const engine of [chromium, webkit].filter(engine => !process.env.ASK_BROWSER || engine.name() === process.env.ASK_BROWSER)) {
    const browser = await engine.launch({ headless: true, args: engine === chromium ? ['--disable-gpu'] : [], executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
    const result = { browser: engine.name(), errors: [], passed: false }; results.push(result);
    const storage = new Map(), sessions = new Map(), prompts = [], requests = [];
    let serial = 0, delayed, holdSubmission, finishSubmission;
    page.on('pageerror', error => result.errors.push(error.message));
    const session = (id, agent) => {
      if (!sessions.has(id)) sessions.set(id, { agent, model: agent === 'claude' ? 'claude-fable-5-1' : 'gpt-6-astra', messages: [], turns: [] });
      const saved = sessions.get(id); assert.equal(saved.agent, agent, 'session is only used with its original provider'); return saved;
    };
    try {
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        return method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true);
      });
      await page.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://models.test', token: 'fixture', agent: 'claude' } }));
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
          terminate() {}
        };
        window.__body = '';
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          for (const t of m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || []) if (t.containerName === 'body') window.__body = t.content;
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.route('https://models.test/**', async route => {
        const req = route.request(), url = new URL(req.url()), agent = url.searchParams.get('provider');
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        requests.push({ path: url.pathname, agent, sessionId: url.searchParams.get('sessionId') });
        const json = value => route.fulfill({ headers, json: value });
        if (['/api/pageborne/reader-state', '/api/pageborne/library', '/api/pageborne/reading-activity'].includes(url.pathname)) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (url.pathname === '/api/info') return json({ pageborne: { conversationSync: 1 } });
        if (/^\/api\/sessions\/[^/]+\/history$/.test(url.pathname)) {
          session(decodeURIComponent(url.pathname.split('/')[3]), agent); return json({ history: [] });
        }
        if (url.pathname === '/api/events') {
          if (url.searchParams.get('sessionId')) session(url.searchParams.get('sessionId'), agent);
          return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
        }
        if (url.pathname === '/api/pageborne/conversation') {
          const saved = session(url.searchParams.get('sessionId'), agent);
          const response = { version: 1, sessionId: url.searchParams.get('sessionId'), state: 'idle', sessionModel: saved.model, turns: structuredClone(saved.turns) };
          if (delayed) { const wait = delayed; delayed = null; await wait; }
          return json(response);
        }
        if (url.pathname === '/api/messages') {
          const saved = session(url.searchParams.get('sessionId'), agent);
          return json({ state: 'idle', messages: saved.messages.filter(m => m.id > Number(url.searchParams.get('after') || 0)) });
        }
        if (url.pathname === '/api/prompt') {
          const body = req.postDataJSON(), id = body.sessionId || `${agent}-${++serial}`, saved = session(id, agent);
          prompts.push({ agent, id, text: body.text });
          const marker = body.text.match(/Pageborne question [\w-]+/)[0], question = body.text.includes('Late question') ? 'Late question' : `${agent} followup`;
          const n = saved.messages.at(-1)?.id || 0, answer = `${agent} reply ${saved.turns.length + 1}.`;
          const complete = () => {
            saved.messages.push({ id: n + 1, type: 'user_prompt', text: body.text }, { id: n + 2, type: 'result', success: true, text: answer });
            saved.turns.push({ id: marker, marker, question, answer, state: 'complete' });
          };
          if (holdSubmission) { finishSubmission = complete; await holdSubmission; } else complete();
          return json({ sessionId: id });
        }
        throw Error(`Unexpected route ${url.pathname}`);
      });
      const stop = () => page.evaluate(() => window.__askUI.pollTimer?.cancel());
      const poll = async () => { await expect.poll(() => page.evaluate(() => !!window.__askUI.polling)).toBe(false); await page.evaluate(async () => { const ui = window.__askUI; ui.pollTimer?.cancel(); await ui.pollFooter(); ui.pollTimer?.cancel(); }); };
      const open = async name => { await showLibrary(page); await page.locator(`[data-document-id="${name}"] .document-card`).click(); await expect(page.locator('#ask-open')).toBeEnabled(); await stop(); };
      const select = async agent => { await page.locator('#ask-chat-model').selectOption(agent); await stop(); await expect(page.locator('#ask-chat-model')).toHaveValue(agent); };
      const getKey = () => page.evaluate(() => window.__askUI.paperKey);
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled(); await stop();
      await page.locator('#file-picker').setInputFiles(['old.md', 'new.md', 'another.md'].map(name => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(`# ${name}\n\nKeep reading this paper while replies arrive.`) })));
      await open('old.md');
      session('old-codex', 'codex').turns.push({ id: 'legacy-turn', question: 'Legacy Codex question', answer: 'Legacy Codex answer.', state: 'complete' });
      await page.evaluate(() => { const ui = window.__askUI, key = JSON.stringify([ui.snapshot().paperId, 'terminal', 'https://models.test', 'codex', '']); ui.saveBinding(key, { sessionId: 'old-codex' }); });
      // Changing the default before opening an old chat cannot reassign it.
      await showTool(page, 'settings'); await page.locator('#ask-default-model').selectOption('claude'); await hideSettings(page);
      await page.locator('#ask-open').click(); await poll();
      await expect(page.locator('#ask-chat-model')).toHaveValue('codex'); await expect(page.locator('#ask-messages')).toContainText('Legacy Codex question');
      await expect(page.locator('#ask-session-model')).toHaveText('Session model: gpt-6-astra');
      await page.evaluate(() => { window.__askUI.automaticConnection = true; window.__askUI.loadModels(); });
      await expect(page.locator('#ask-chat-model option[value=claude]')).toHaveText('Claude Fable 5.2');
      const codexKey = await getKey();
      await page.locator('#ask-question').fill('Codex unsent draft'); await select('claude');
      const claudeKey = await getKey(); assert.notEqual(claudeKey, codexKey);
      await expect(page.locator('.ask-message-user')).toHaveCount(0); await expect(page.locator('#ask-question')).toHaveValue('');
      await page.locator('#ask-question').fill('claude followup'); await page.locator('#ask-send').click();
      await expect(page.locator('#ask-answer')).toContainText('claude reply 1.'); await poll();
      const claudeId = await page.evaluate(() => window.__askUI.binding().sessionId);
      await expect(page.locator('#ask-session-model')).toHaveText('Session model: Fable 5.1');
      session(claudeId, 'claude').model = 'claude-fable-5-2'; await poll();
      await expect(page.locator('#ask-session-model')).toHaveText('Session model: Fable 5.2');
      delete session(claudeId, 'claude').model; await poll();
      await expect(page.locator('#ask-session-model')).toHaveText('Session model unavailable');
      session(claudeId, 'claude').model = 'claude-fable-5-2'; await poll();
      await page.locator('#ask-question').fill('Claude unsent draft'); await select('codex');
      await expect(page.locator('#ask-question')).toHaveValue('Codex unsent draft'); await expect(page.locator('#ask-messages')).toContainText('Legacy Codex question');
      assert.notEqual(await page.evaluate(() => window.__askUI.footerStatus()), 'Unread reply', 'the other model cannot leak its unread flag');
      assert.equal(await page.evaluate(() => window.__askUI.binding().sessionId), 'old-codex');
      await page.locator('#ask-question').fill('codex followup'); await page.locator('#ask-send').click();
      await expect(page.locator('#ask-answer')).toContainText('codex reply 2.'); await select('claude');
      await expect(page.locator('#ask-question')).toHaveValue('Claude unsent draft'); await expect(page.locator('#ask-messages')).not.toContainText('Legacy Codex question');
      assert.equal(await page.evaluate(() => window.__askUI.binding().sessionId), claudeId);
      // A pending submission is owned by its original key even before its ID arrives.
      let releaseSubmission; holdSubmission = new Promise(resolve => { releaseSubmission = resolve; });
      await page.locator('#ask-question').fill('Late question'); await page.locator('#ask-send').click();
      await expect.poll(() => !!finishSubmission).toBe(true); await select('codex');
      finishSubmission(); holdSubmission = null; releaseSubmission();
      await expect.poll(() => page.evaluate(() => window.__askUI.deliveries.size)).toBe(0);
      await expect(page.locator('#ask-messages')).not.toContainText('Late question');
      await select('claude'); await expect(page.locator('#ask-answer')).toContainText('claude reply 2.'); await poll();
      // Quietly sync a question from another device into only that model.
      session(claudeId, 'claude').turns.push({ id: 'mobile', question: 'External Claude question', answer: 'External Claude answer.', state: 'complete' });
      await poll(); await expect(page.locator('#ask-messages')).toContainText('External Claude question');
      await select('codex'); await expect(page.locator('#ask-messages')).not.toContainText('External Claude question');
      // New documents follow the default. A later default change leaves them pinned.
      await open('new.md'); await page.locator('#ask-open').click(); await stop(); await expect(page.locator('#ask-chat-model')).toHaveValue('claude');
      await showTool(page, 'settings'); await page.locator('#ask-default-model').selectOption('codex'); await hideSettings(page);
      await open('another.md'); await page.locator('#ask-open').click(); await stop(); await expect(page.locator('#ask-chat-model')).toHaveValue('codex');
      await open('new.md'); await page.locator('#ask-open').click(); await stop(); await expect(page.locator('#ask-chat-model')).toHaveValue('claude');
      await page.evaluate(() => window.__askUI.openLibrarian()); await stop(); await expect(page.locator('#ask-chat-model')).toHaveValue('codex');
      await select('claude'); assert.equal(JSON.parse(await getKey())[0], null);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await open('old.md'); await page.locator('#ask-open').click(); await poll();
      await expect(page.locator('#ask-chat-model')).toHaveValue('codex'); await expect(page.locator('#ask-messages')).toContainText('Legacy Codex question');
      await select('claude'); await poll(); await expect(page.locator('#ask-messages')).toContainText('External Claude question');
      assert.equal(await page.evaluate(() => window.__askUI.binding().sessionId), claudeId);
      // Late sync responses cannot replace the newly selected model's messages.
      let release; delayed = new Promise(resolve => { release = resolve; }); const late = poll(); await expect.poll(() => delayed === null).toBe(true);
      await select('codex'); release(); await late; await expect(page.locator('#ask-messages')).not.toContainText('External Claude question');
      await expect(page.locator('#ask-session-model')).toHaveText('Session model: gpt-6-astra');
      await page.screenshot({ path: `${out}/${engine.name()}.png`, fullPage: true });
      const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('even-reader:preferences:v1')));
      assert.equal(saved.askModels.defaultAgent, 'codex'); assert(saved.askChats[codexKey].length >= 2); assert(saved.askChats[claudeKey].length >= 3);
      await page.evaluate(() => window.__askUI.openLibrarian()); await stop(); await expect(page.locator('#ask-chat-model')).toHaveValue('claude');
      assert.equal(prompts.length, 3); assert.deepEqual(prompts.map(p => p.agent), ['claude', 'codex', 'claude']); assert.deepEqual(result.errors, []);
      result.eventRequests = requests.filter(r => r.path === '/api/events');
      assert(requests.some(r => r.path === '/api/events' && r.agent === 'codex') && requests.some(r => r.path === '/api/events' && r.agent === 'claude'));
      Object.assign(result, { passed: true, legacyPreserved: true, separateHistories: true, defaults: true, drafts: true, pendingSwitch: true, sharedSync: true, reload: true, staleSyncIgnored: true, librarian: true, prompts: prompts.length });
    } catch (error) { result.failure = error.stack; await page.screenshot({ path: `${out}/${engine.name()}-failure.png`, fullPage: true }); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
