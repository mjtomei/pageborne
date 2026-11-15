// Shared native-session follow-ups through the real Ask UI. Speech/desktop IO
// are fixtures; no prompts are sent to a live agent and no BLE claims are made.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://followups.test';
const out = 'test-results/ask-followups'; await mkdir(out, { recursive: true });
const vite = await createServer({ plugins: [displayProbe()], cacheDir: '.state/vite-ask-followups', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen(); const reports = [];
try {
  for (const engine of (process.env.ASK_BROWSER === 'chromium' ? [chromium] : [chromium, webkit])) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH,
      ...(engine === chromium ? { args: ['--disable-gpu', '--js-flags=--max-old-space-size=384'] } : {}) });
    const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
    const report = { engine: engine.name(), errors: [], passed: false }; reports.push(report);
    const storage = new Map(), prompts = [], sessions = new Map(); let serial = 0, gate, rejectNext = false, conflict, rejectedPrompt;
    page.on('pageerror', e => report.errors.push(e.message));
    try {
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        return method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true);
      });
      await page.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://followups.test', token: 'fixture', agent: 'codex' } }));
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
      await page.route('https://followups.test/**', async route => {
        const req = route.request(), url = new URL(req.url()), headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const json = value => route.fulfill({ headers, json: value });
        const id = url.searchParams.get('sessionId'), saved = sessions.get(id);
        if (url.pathname === '/api/info') return json({ pageborne: { conversationSync: 1 } });
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
          if (rejectNext) { rejectNext = false; return route.fulfill({ status: 400, headers, json: { error: 'Fixture rejection' } }); }
          const sessionId = body.sessionId || `session-${++serial}`;
          if (!sessions.has(sessionId)) sessions.set(sessionId, { turns: [], messages: [], state: 'idle' });
          const s = sessions.get(sessionId), marker = body.text.match(/Pageborne question [\w-]+/)[0];
          const question = body.text.split('\n\n').at(-1);
          prompts.push({ body, sessionId, marker, question }); s.state = 'busy';
          s.messages.push({ id: s.messages.length + 1, type: 'user_prompt', text: body.text });
          s.turns.push({ id: marker, marker, question, answer: '', state: 'pending' });
          const wait = gate; gate = null; if (wait) await wait;
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
      // Quick sends before the first session ID comes back share one session.
      let release; gate = new Promise(resolve => { release = resolve; });
      await send('First question'); await expect.poll(() => prompts.length).toBe(1);
      await send('Second question'); await expect(page.locator('.ask-message-user')).toHaveCount(2);
      await page.evaluate(() => { window.__askUI.close(); window.__askUI.open({ showConversation: false }); });
      assert.equal(prompts.length, 1); release();
      await expect.poll(() => prompts.length).toBe(2); assert.equal(serial, 1);
      assert.equal(prompts[1].body.sessionId, prompts[0].sessionId);
      assert.equal(sessions.get(prompts[0].sessionId).state, 'busy');
      await expect.poll(state).toBe('thinking');
      await expect(page.locator('#ask-voice')).toBeEnabled();
      // Native steering can leave an earlier message without its own answer.
      finish(0, '');
      const s = sessions.get(prompts[1].sessionId); s.turns[1].answer = 'Answer in progress';
      await expect(page.locator('#ask-answer')).toHaveText('Answer in progress');
      await page.evaluate(() => window.__askUI.open({ showConversation: true }));
      await send('Third question'); await expect.poll(() => prompts.length).toBe(3);
      await expect.poll(glassesBody).toContain('Third question');
      finish(1, 'Second answer complete. '.repeat(100));
      await expect(page.locator('#ask-messages')).toContainText('Second answer complete');
      await expect.poll(glassesBody).toContain('Third question');
      s.turns[2].answer = 'Third answer partial';
      await expect(page.locator('#ask-answer')).toHaveText('Third answer partial');
      await expect.poll(glassesBody).toContain('Third answer partial');
      assert.equal((await turns()).find(t => t.question === 'First question').state, 'complete');
      // Actual hold/release/review lifecycle with a deterministic speech result.
      await page.evaluate(() => {
        const ui = window.__askUI;
        ui.stream.start = () => {}; ui.stream.cancel = () => {};
        ui.stream.finish = async () => ({ text: 'Spoken follow-up', words: [] });
        ui.mic.start = async () => {}; ui.mic.stop = async () => ({ kind: 'pcm-stream', bytes: 64000 });
      });
      await page.locator('#ask-voice').click(); await expect.poll(state).toBe('listening');
      s.turns[2].answer = 'Third answer grows during listening';
      await expect(page.locator('#ask-answer')).toHaveText('Third answer grows during listening');
      await page.locator('#ask-voice').click(); await expect.poll(state).toBe('review');
      await expect(page.locator('#ask-question')).toHaveValue('Spoken follow-up');
      finish(2, 'Third answer completed during review');
      await expect(page.locator('#ask-answer')).toHaveText('Third answer completed during review');
      await expect.poll(state).toBe('review'); await expect(page.locator('#ask-question')).toHaveValue('Spoken follow-up');
      await page.locator('#ask-send').click(); await expect.poll(() => prompts.length).toBe(4);
      assert.equal(prompts[3].question, 'Spoken follow-up');
      await expect.poll(glassesBody).toContain('Spoken follow-up');
      // A newly discovered old answer must not consume follow mode or jump
      // away from the question currently waiting for an answer on the glasses.
      s.turns.unshift({ id: 'historical-answer', question: '', answer: 'Historical answer. '.repeat(100), state: 'complete' });
      await expect(page.locator('#ask-messages')).toContainText('Historical answer');
      await expect.poll(glassesBody).toContain('Spoken follow-up');
      // A rejected follow-up retains the earlier pending question for recovery.
      rejectNext = true; await send('Rejected follow-up'); await expect.poll(state).toBe('error');
      finish(3, 'Spoken answer');
      await expect(page.locator('#ask-messages')).toContainText('Spoken answer');
      await expect.poll(async () => (await turns()).find(t => t.question === 'Rejected follow-up')?.state).toBe('error');
      await expect.poll(state).toBe('answer');
      // A model switch during two queued POSTs cannot change their destination.
      let releaseAgain; gate = new Promise(resolve => { releaseAgain = resolve; });
      await send('Stay on Codex one'); await expect.poll(() => prompts.length).toBe(5);
      await send('Stay on Codex two'); await page.locator('#ask-chat-model').selectOption('claude');
      releaseAgain(); await expect.poll(() => prompts.length).toBe(6);
      finish(4, 'Codex one'); finish(5, 'Codex two');
      await expect.poll(() => page.evaluate(() => window.__askUI.deliveries.size)).toBe(0);
      await expect(page.locator('#ask-messages')).not.toContainText('Stay on Codex');
      await page.locator('#ask-chat-model').selectOption('codex');
      await expect(page.locator('#ask-messages')).toContainText('Codex one'); await expect(page.locator('#ask-messages')).toContainText('Codex two');
      assert(prompts.every(p => p.sessionId === prompts[0].sessionId && p.body.provider === 'codex'));
      assert.equal(new Set(prompts.map(p => p.marker)).size, prompts.length);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled();
      await showLibrary(page); await page.locator('[data-document-id="followups.md"] .document-card').click(); await page.locator('#ask-open').click();
      await expect(page.locator('#ask-messages')).toContainText('Codex two');
      await expect(page.locator('.ask-message-user')).toHaveCount(7);
      // The same path sends an accepted voice review while Claude is still busy.
      await page.locator('#ask-chat-model').selectOption('claude');
      await send('Claude first question'); await expect.poll(() => prompts.length).toBe(7);
      await page.evaluate(() => {
        const ui = window.__askUI;
        ui.stream.start = () => {}; ui.stream.cancel = () => {};
        ui.stream.finish = async () => ({ text: 'Claude spoken follow-up', words: [] });
        ui.mic.start = async () => {}; ui.mic.stop = async () => ({ kind: 'pcm-stream', bytes: 64000 });
      });
      await page.locator('#ask-voice').click(); await expect.poll(state).toBe('listening');
      await page.locator('#ask-voice').click(); await expect.poll(state).toBe('review');
      await page.locator('#ask-send').click(); await expect.poll(() => prompts.length).toBe(8);
      assert.equal(prompts[7].sessionId, prompts[6].sessionId); assert.equal(prompts[7].body.provider, 'claude');
      assert.notEqual(prompts[7].sessionId, prompts[0].sessionId);
      finish(6, 'Claude first answer'); finish(7, 'Claude spoken answer');
      await expect(page.locator('#ask-messages')).toContainText('Claude first answer'); await expect(page.locator('#ask-answer')).toHaveText('Claude spoken answer');
      await expect(page.locator('#ask-messages')).not.toContainText('Codex two');
      // A native pre-send rejection is retryable without changing the session.
      conflict = 'Claude Remote Control is disconnected. Reconnect the normal Claude session before sending.';
      await send('Rejected while disconnected');
      await expect(page.locator('#ask-status')).toContainText('Your question was not sent');
      assert.equal(await page.evaluate(() => !!window.__askUI.binding().pending), false);
      assert.equal(await page.evaluate(() => window.__askUI.binding().sessionId), prompts[6].sessionId);
      assert.equal(prompts.length, 8);
      // Old versions retained a pending question on 409. An unknown conflict
      // recreates that persisted shape without pretending absence proves safety.
      conflict = 'Unknown conflict';
      await send('Unconfirmed question'); await expect.poll(state).toBe('error');
      await expect(page.locator('#ask-clear-submission')).toBeVisible();
      const uncertain = { ...rejectedPrompt };
      await send('Attempt while blocked');
      await expect(page.locator('#ask-status')).toContainText('previous submission is unconfirmed');
      assert.equal(prompts.length, 8);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled();
      await showLibrary(page); await page.locator('[data-document-id="followups.md"] .document-card').click(); await page.locator('#ask-open').click();
      await expect(page.locator('#ask-clear-submission')).toBeVisible();
      await page.evaluate(() => {
        const ui = window.__askUI;
        window.__staleBinding = ui.binding(); window.__staleSave = ui.bindingWriter(ui.paperKey);
      });
      await page.screenshot({ path: `${out}/${engine.name()}-blocked-440.png` });
      await page.setViewportSize({ width: 320, height: 700 });
      await expect(page.locator('#ask-clear-submission')).toBeInViewport();
      await page.screenshot({ path: `${out}/${engine.name()}-blocked-320.png` });
      await page.setViewportSize({ width: 440, height: 806 });
      await page.locator('#ask-clear-submission').click();
      await expect(page.locator('#ask-blocked-submission')).toBeHidden();
      await expect(page.locator('#ask-messages')).toContainText('Claude first answer');
      await expect(page.locator('#ask-messages')).toContainText('Unconfirmed question');
      await page.evaluate(() => window.__staleSave(window.__staleBinding));
      assert.equal(await page.evaluate(() => !!window.__askUI.binding().pending), false, 'stale polling cannot restore the cleared block');
      assert.equal(prompts.length, 8, 'clearing never resends');
      await send('New question after clearing'); await expect.poll(() => prompts.length).toBe(9);
      assert.equal(prompts[8].sessionId, prompts[6].sessionId);
      finish(8, 'Recovered in the original session');
      await expect(page.locator('#ask-messages')).toContainText('Recovered in the original session');
      // A late reply remains recoverable and deduplicates with the retained turn.
      const marker = uncertain.text.match(/Pageborne question [\w-]+/)[0];
      sessions.get(uncertain.sessionId).turns.push({ id: marker, marker, question: 'Unconfirmed question', answer: 'Late original reply', state: 'complete' });
      await page.evaluate(() => window.__askUI.pollFooter());
      await expect(page.locator('#ask-messages')).toContainText('Late original reply');
      assert.equal((await turns()).filter(t => t.question === 'Unconfirmed question').length, 1);
      await page.reload(); await expect(page.locator('#import')).toBeEnabled();
      await showLibrary(page); await page.locator('[data-document-id="followups.md"] .document-card').click(); await page.locator('#ask-open').click();
      await expect(page.locator('#ask-messages')).toContainText('Late original reply');
      await expect(page.locator('#ask-blocked-submission')).toBeHidden();
      assert.equal(prompts.length, 9);
      assert.deepEqual(report.errors, []);
      Object.assign(report, { passed: true, prompts: prompts.length, oneSession: true, busyFollowups: true, voiceDuringReply: true, rejectedFollowupRecovered: true, modelSwitch: true, reload: true, glassesFollowupPosition: true, glassesHistoryBackfillPosition: true,
        disconnectedRejection: true, legacyPendingCleared: true, stalePollIgnored: true, lateReplyRecovered: true, noAutomaticResend: true });
      await page.screenshot({ path: `${out}/${engine.name()}.png`, fullPage: true });
    } catch (e) { report.failure = e.stack; console.error(await page.evaluate(() => ({ status: window.__askUI?.session.status, error: window.__askUI?.session.error, turns: window.__askUI?.chat.turns(window.__askUI.paperKey) }))); await page.screenshot({ path: `${out}/${engine.name()}-failure.png` }); throw e; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
