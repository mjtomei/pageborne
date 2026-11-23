// Explicit hold-to-retry through the real Ask UI. Speech/desktop IO
// are fixtures; no prompts are sent to a live agent and no BLE claims are made.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://retry.test';
const out = 'test-results/ask-retry'; await mkdir(out, { recursive: true });
const vite = await createServer({ plugins: [displayProbe()], cacheDir: '.state/vite-ask-retry', optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen(); const reports = [];
try {
  for (const engine of (process.env.ASK_BROWSER === 'chromium' ? [chromium] : [chromium, webkit])) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH,
      ...(engine === chromium ? { args: ['--disable-gpu', '--js-flags=--max-old-space-size=384'] } : {}) });
    const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
    const report = { engine: engine.name(), errors: [], passed: false }; reports.push(report);
    const storage = new Map(), prompts = [], sessions = new Map(), recordings = new Map(); let serial = 0, gate, dropAck = false, rejectNext = false, conflict, rejectedPrompt;
    page.on('pageerror', e => report.errors.push(e.message));
    try {
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        return method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true);
      });
      await page.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://retry.test', token: 'fixture', agent: 'codex' } }));
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
          terminate() {}
        };
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload); if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          const texts = m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || [];
          for (const text of texts) if (text.containerName === 'body') window.__body = text.content;
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.route('https://retry.test/**', async route => {
        const req = route.request(), url = new URL(req.url()), headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const json = value => route.fulfill({ headers, json: value });
        const id = url.searchParams.get('sessionId'), saved = sessions.get(id);
        if (url.pathname === '/api/info') return json({ pageborne: { conversationSync: 1, speechRecordings: 1 } });
        if (url.pathname.startsWith('/api/pageborne/speech-recordings/')) {
          const [id, kind, part] = url.pathname.split('/').slice(4), body = req.postDataJSON();
          const recording = recordings.get(id) || { parts: new Map() }; recordings.set(id, recording);
          if (kind === 'chunks') recording.parts.set(part, body.pcm);
          else if (!recording.revision || body.revision > recording.revision) Object.assign(recording, body);
          return json({ ok: true });
        }
        if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
        if (url.pathname.endsWith('/history')) return json({ history: [] });
        if (req.method() === 'GET' && ['/api/pageborne/library', '/api/pageborne/library/activity', '/api/pageborne/reading-activity'].includes(url.pathname)) return route.fulfill({ status: 404, headers, json: {} });
        if (url.pathname === '/api/pageborne/reader-state') return route.fulfill({ status: 404, headers, json: {} });
        if (url.pathname === '/api/pageborne/conversation') return json({ version: 1, sessionId: id, state: saved.state, turns: saved.turns });
        if (url.pathname === '/api/messages') return json({ state: saved.state, messages: saved.messages });
        if (url.pathname === '/api/prompt') {
          const body = req.postDataJSON();
          if (conflict) {
            const error = conflict; conflict = null; rejectedPrompt = body;
            return route.fulfill({ status: 409, headers, json: { error } });
          }
          if (rejectNext) { rejectedPrompt = body; rejectNext = false; return route.fulfill({ status: 400, headers, json: { error: 'Fixture rejection' } }); }
          const sessionId = body.sessionId || `session-${++serial}`;
          if (!sessions.has(sessionId)) sessions.set(sessionId, { turns: [], messages: [], state: 'idle' });
          const s = sessions.get(sessionId), marker = body.text.match(/Pageborne question [\w-]+/)[0];
          const question = body.text.split('\n\n').at(-1);
          prompts.push({ body, sessionId, marker, question }); s.state = 'busy';
          s.messages.push({ id: s.messages.length + 1, type: 'user_prompt', text: body.text });
          s.turns.push({ id: marker, marker, question, answer: '', state: 'pending' });
          const wait = gate; gate = null; if (wait) await wait;
          if (dropAck) { dropAck = false; return route.abort('failed'); }
          return json({ sessionId });
        }
        throw new Error(`Unexpected fixture route: ${url.pathname}`);
      });
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles({ name: 'followups.md', mimeType: 'text/markdown', buffer: Buffer.from('# Follow-ups\n\nKeep the reading position and conversation.') });
      await showLibrary(page); await page.locator('[data-document-id="followups.md"] .document-card').click(); await page.locator('#ask-open').click();
      const send = async text => { await page.locator('#ask-question').fill(text); await expect(page.locator('#ask-send')).toBeEnabled(); await page.locator('#ask-send').click(); };
      const state = () => page.evaluate(() => window.__askUI.session.status);
      const turns = () => page.evaluate(() => window.__askUI.chat.turns(window.__askUI.paperKey));
      const glassesBody = () => page.evaluate(() => window.__body);
      const finish = (index, text) => {
        const p = prompts[index], s = sessions.get(p.sessionId), turn = s.turns.find(t => t.marker === p.marker);
        turn.answer = text; turn.state = 'complete';
        s.messages.push({ id: s.messages.length + 1, type: 'result', text, success: true });
        s.state = s.turns.some(t => t.state === 'pending') ? 'busy' : 'idle';
      };

      let microphoneStarts = 0;
      await page.exposeFunction('__microphoneStarted', () => { microphoneStarts++; });
      await page.evaluate(() => {
        const ui = window.__askUI;
        ui.mic.start = async () => { await window.__microphoneStarted(); };
        ui.mic.stop = async () => ({ kind: 'pcm-stream', bytes: 0 });
        ui.stream.start = () => {}; ui.stream.cancel = () => {};
      });
      const hint = () => page.evaluate(() => window.__askUI.frame().statusRight);
      const hold = () => page.evaluate(() => { window.__askUI.handle('ask-hold', 'glasses'); });
      const releaseHold = () => page.evaluate(() => { window.__askUI.handle('ask-release', 'glasses'); });
      // Rejection before acceptance retains the exact context and local turn.
      rejectNext = true; await send('Retry the original question');
      await expect.poll(state).toBe('error'); await expect.poll(hint).toContain('Hold to retry');
      const original = (await turns()).at(-1), rejectedText = rejectedPrompt.text;
      await page.evaluate(() => {
        const ui = window.__askUI; ui.close(); ui.open();
        ui.snapshot = ((snapshot) => () => ({ ...snapshot(), title: 'Different position now', y: 999 }))(ui.snapshot);
        ui.returnToReading();
      });
      await expect.poll(() => page.evaluate(() => window.__status)).toContain('Hold to retry');
      let unblock; gate = new Promise(resolve => { unblock = resolve; });
      await hold(); await hold(); await releaseHold(); await hold();
      await expect.poll(() => prompts.length).toBe(1);
      assert.equal(microphoneStarts, 0); assert.equal((await turns()).length, 1);
      assert.equal((await turns())[0].id, original.id);
      assert.equal(prompts[0].body.text.replace(/Pageborne question [\w-]+/g, 'MARKER'), rejectedText.replace(/Pageborne question [\w-]+/g, 'MARKER'));
      unblock(); finish(0, 'Recovered original answer');
      await expect.poll(state).toBe('answer'); await expect.poll(hint).toContain('Hold: speak');
      await hold(); await expect.poll(state).toBe('listening'); assert.equal(microphoneStarts, 1);
      await page.evaluate(() => window.__askUI.cancelDictation());
      // A lost POST response may already have created the remote message.
      // Holding checks that marker: it must never submit the prompt again.
      dropAck = true; await send('Accepted but acknowledgement lost');
      await expect.poll(state).toBe('error'); await expect.poll(hint).toContain('Hold to retry');
      assert.equal(prompts.length, 2);
      const pending = await page.evaluate(() => window.__askUI.binding().pending);
      await hold(); await hold(); await releaseHold();
      await expect.poll(state).toBe('thinking');
      assert.equal(prompts.length, 2); assert.equal(microphoneStarts, 1);
      assert.equal(await page.evaluate(() => window.__askUI.binding().pending.marker), pending.marker);
      finish(1, 'Recovered accepted answer');
      await expect.poll(state).toBe('answer'); await expect.poll(hint).toContain('Hold: speak');
      assert.equal((await turns()).length, 2);
      // An earlier reply completing cannot hide a rejected follow-up's retry.
      await send('Earlier reply'); await expect.poll(() => prompts.length).toBe(3);
      rejectNext = true; await send('Rejected follow-up'); await expect.poll(state).toBe('error');
      const followupId = (await turns()).at(-1).id;
      finish(2, 'Earlier completion'); await expect.poll(state).toBe('answer');
      await expect.poll(hint).toContain('Hold to retry');
      await hold(); await expect.poll(() => prompts.length).toBe(4);
      assert.equal((await turns()).at(-1).id, followupId); assert.equal((await turns()).length, 4);
      finish(3, 'Follow-up recovered'); await expect.poll(state).toBe('answer');
      // Model switches scope the retry to its original conversation.
      rejectNext = true; await send('Codex retry only'); await expect.poll(state).toBe('error');
      await page.locator('#ask-chat-model').selectOption('claude');
      await expect.poll(hint).toContain('Hold: speak');
      await page.locator('#ask-chat-model').selectOption('codex');
      await expect.poll(hint).toContain('Hold to retry');
      await hold(); await expect.poll(() => prompts.length).toBe(5);
      assert.equal(prompts[4].body.provider, 'codex'); assert.equal(prompts[4].sessionId, prompts[0].sessionId);
      finish(4, 'Scoped recovery'); await expect.poll(state).toBe('answer');
      // Clearing an uncertain submission revokes retry, including late callbacks.
      conflict = 'Unknown conflict'; await send('Unconfirmed'); await expect.poll(state).toBe('error');
      await expect.poll(hint).toContain('Hold to retry');
      await page.evaluate(() => window.__askUI.clearBlockedSubmission());
      await expect.poll(hint).toContain('Hold: speak'); assert.equal(prompts.length, 5);
      // Across reload, only a persisted uncertain submission is recoverable;
      // without its session ID there is no safe way to resend it.
      await page.evaluate(() => window.__askUI.newSession());
      conflict = 'Unknown conflict'; await send('Unconfirmed first question'); await expect.poll(state).toBe('error');
      assert.equal(await page.evaluate(() => !!window.__askUI.binding().sessionId), false);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled();
      await showLibrary(page); await page.locator('[data-document-id="followups.md"] .document-card').click(); await page.locator('#ask-open').click();
      await expect.poll(hint).toContain('Hold to retry');
      await hold(); await hold(); await releaseHold(); await expect.poll(state).toBe('error');
      assert.equal(prompts.length, 5);
      await page.evaluate(() => window.__askUI.clearBlockedSubmission());
      await expect.poll(hint).toContain('Hold: speak');
      // Speech errors do not expose a stale message as a retry target.
      await page.evaluate(() => window.__askUI.session.fail(new Error('Microphone unavailable')));
      await expect.poll(hint).toContain('Hold: speak');
      assert.equal(microphoneStarts, 1); assert.deepEqual(report.errors, []);
      Object.assign(report, { passed: true, prompts: prompts.length, sameTurn: true, originalContext: true,
        repeatedHolds: true, lostAcknowledgementNoResend: true, olderReply: true, modelScope: true, reset: true, speakRestored: true });
    } catch (e) { report.failure = e.stack; console.error(await page.evaluate(() => ({ status: window.__askUI?.session.status, error: window.__askUI?.session.error, turns: window.__askUI?.chat.turns(window.__askUI.paperKey) }))); await page.screenshot({ path: `${out}/${engine.name()}-failure.png` }); throw e; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
