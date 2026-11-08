import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary } from './ui-helpers.mjs';
import { displayProbe } from './display-probe.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://sync.test';
const out = 'test-results/ask-sync'; await mkdir(out, { recursive: true });
const vite = await createServer({ plugins: [displayProbe()], cacheDir: '.state/vite-ask-sync', optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen(); const results = [];
try {
  for (const engine of [chromium, webkit].filter(engine => !process.env.ASK_BROWSER || engine.name() === process.env.ASK_BROWSER)) {
    const browser = await engine.launch({ headless: true, args: engine === chromium ? ['--disable-gpu'] : [], executablePath: engine === chromium ? (process.env.CHROME_PATH || '/usr/bin/google-chrome') : process.env.WEBKIT_PATH });
    const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
    const result = { browser: engine.name(), passed: false, errors: [] }; results.push(result);
    page.on('pageerror', error => result.errors.push(error.message));
    const storage = new Map(), requests = [];
    const turns = Array.from({ length: 12 }, (_, n) => ({ id: `remote-${n}`, question: `Mobile question ${n}?`, answer: `Mobile answer ${n}.`, state: 'complete' }));
    turns[11].activities = [
      { id: 'think', kind: 'thinking', text: 'Checking the relevant file.', state: 'complete' },
      { id: 'read', kind: 'tool', text: 'Shell node scripts/inspect.mjs…', detail: 'Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose ', state: 'complete' },
    ];
    let offline = false, delayed;
    try {
      await page.exposeFunction('__storage', ({ method, data }) => {
        if (method === 'getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key)) return JSON.stringify({ id: 'fixture', chunks: 1, headers: {} });
        return method === 'getLocalStorage' ? storage.get(data.key) || '' : (storage.set(data.key, data.value), true);
      });
      await page.addInitScript(() => {
        if (!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://sync.test', token: 'fixture', agent: 'codex' } }));
        const NativeWorker = Worker;
        window.Worker = class {
          constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); }
          postMessage(data) { if (data.operation === 'prepare') queueMicrotask(() => this.onmessage?.({ data: { id: data.id, result: { backend: 'wasm', verified: true } } })); }
          terminate() {}
        };
        window.__body = ''; window.__nativeBoxes = {};
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload); if (m.data?.menuObject) window.__nativeMenu = m.data.menuObject.menuItems; if (m.method.endsWith('LocalStorage')) return window.__storage(m);
          if (m.data?.textObject) window.__nativeBoxes = {};
          for (const t of m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || []) {
            window.__nativeBoxes[t.containerName] = t;
            if (t.containerName === 'body') window.__body = t.content;
          }
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.route('https://sync.test/**', async route => {
        const req = route.request(), url = new URL(req.url()), headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        requests.push({ method: req.method(), path: url.pathname });
        const json = value => route.fulfill({ headers, json: value });
        if (url.pathname === '/api/pageborne/reader-state') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
        if (url.pathname === '/api/info') return json({ pageborne: { conversationSync: 1 } });
        if (url.pathname === '/api/events') return route.fulfill({ headers, contentType: 'text/event-stream', body: ': connected\n\n' });
        if (url.pathname === '/api/pageborne/conversation') {
          if (offline) return route.abort('failed');
          const response = { version: 1, sessionId: url.searchParams.get('sessionId'), state: 'idle', turns: structuredClone(turns) };
          if (delayed) { const waiting = delayed; delayed = null; await waiting; }
          return json(response);
        }
        if (url.pathname.startsWith('/api/pageborne/')) return route.fulfill({ status: 404, headers, json: {} });
        throw Error(`Unexpected route ${url.pathname}`);
      });
      const body = () => page.evaluate(() => window.__body);
      const poll = async () => {
        await expect.poll(() => page.evaluate(() => !!window.__askUI.polling)).toBe(false);
        await page.evaluate(async () => { const ui = window.__askUI; ui.pollTimer?.cancel(); await ui.pollFooter(); ui.pollTimer?.cancel(); });
      };
      const openPaper = async () => { await showLibrary(page); await page.locator('[data-document-id="sync.md"] .document-card').click(); await expect(page.locator('#bookmark')).toBeEnabled(); await expect.poll(body).toContain('Keep this reading page visible'); };
      const stopped = () => page.evaluate(() => window.__askUI.pollTimer?.cancel());
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled(); await stopped();
      await page.locator('#file-picker').setInputFiles({ name: 'sync.md', mimeType: 'text/markdown', buffer: Buffer.from('# Sync paper\n\nKeep this reading page visible while messages arrive from the mobile app.') });
      await openPaper(); const reading = await body();
      await page.evaluate(() => { const ui = window.__askUI; ui.saveBinding(ui.currentPaperKey(), { sessionId: 'shared-session' }); });
      await poll(); assert.equal(await body(), reading); assert.notEqual(await page.evaluate(() => window.__askUI.footerStatus()), 'Unread reply');
      await page.locator('#ask-open').click(); await stopped();
      await expect(page.locator('.ask-message-user')).toHaveCount(12); await expect(page.locator('.ask-message-assistant')).toHaveCount(12);
      await expect(page.locator('#ask-messages')).toContainText('Mobile question 0?');
      // Import/reopening history is silent, and opens at the tail instead of page one.
      assert.notEqual(await page.evaluate(() => window.__askUI.footerStatus()), 'Unread reply');
      await page.evaluate(() => window.__askUI.open()); await stopped();
      await expect.poll(body).toContain('Mobile answer 11.'); assert(!(await body()).includes('Mobile question 0?'));
      await expect(page.locator('.ask-message-activity')).toHaveCount(1);
      await expect(page.locator('#ask-messages')).not.toContainText('Checking the relevant file.');
      const activityRows = await page.evaluate(() => window.__askUI.session.conversation.messages.filter(m => m.role === 'activity').flatMap(m => m.rows.map(r => r.text)));
      assert.equal(activityRows.length, 2); assert(activityRows[1].endsWith('…'));
      assert(!activityRows[0].endsWith('…')); assert(activityRows.join(' ').includes('--format'));
      assert((await page.evaluate(() => window.__nativeBoxes.activity.content)).trim().split('\n').length === 2);
      const phoneAction = await page.locator('.ask-message-activity .ask-message-text').evaluate(el => ({
        height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), clamp: getComputedStyle(el).webkitLineClamp,
        overflow: getComputedStyle(el).textOverflow, width: el.clientWidth, contentWidth: el.scrollWidth }));
      assert(Math.abs(phoneAction.height - phoneAction.line * 2) <= 1); assert.equal(phoneAction.clamp, '2');
      await expect.poll(() => page.evaluate(() => window.__nativeBoxes.activity?.textColor)).toBe(1);
      assert.equal(await page.evaluate(() => window.__nativeBoxes.body.textColor), 4);
      assert.match(await page.evaluate(() => window.__nativeBoxes.activity.content), /Shell node scripts/);
      assert.notEqual(await page.locator('.ask-message-activity').first().evaluate(el => getComputedStyle(el).color),
        await page.locator('.ask-message-assistant').first().evaluate(el => getComputedStyle(el).color));
      await page.screenshot({ path: `${out}/${engine.name()}-activity.png`, fullPage: true });
      await expect.poll(() => page.evaluate(() => window.__nativeMenu?.[1]?.itemName)).toBe('Go to latest');
      await page.evaluate(() => window.__askUI.returnToReading()); await expect.poll(body).toBe(reading);
      await expect.poll(() => page.evaluate(() => window.__nativeMenu?.[1]?.itemName)).toBe('Go to position');
      await poll(); assert.notEqual(await page.evaluate(() => window.__askUI.footerStatus()), 'Unread reply');
      // Repair old 0.8.105 imported unread flags on upgrade.
      await page.evaluate(() => {
        const ui = window.__askUI, key = ui.currentPaperKey(), turns = ui.chat.turns(key);
        for (const turn of turns) turn.readThrough = 0;
        const last = turns.at(-1); ui.chat.persist(key);
        ui.saveBinding(key, { ...ui.binding(), conversationSyncVersion: undefined,
          reply: { answer: last.answer, question: last.question, turnId: last.id, unread: true } });
      });
      await poll(); assert.notEqual(await page.evaluate(() => window.__askUI.footerStatus()), 'Unread reply');
      // Unread status cannot stop later messages arriving from other clients.
      turns.push({ id: 'repeat-1', question: 'Again?', answer: 'First repeated answer.', state: 'complete' }, { id: 'repeat-2', question: 'Again?', answer: 'Second repeated answer.', state: 'complete' });
      await poll(); await expect(page.locator('.ask-message-user')).toHaveCount(14); assert.equal(await page.evaluate(() => window.__askUI.footerStatus()), 'Unread reply');
      assert.equal(await page.locator('.ask-message-user').filter({ hasText: 'Again?' }).count(), 2);
      assert.equal(await body(), reading, 'sync never switches glasses into Ask');
      // The same retained messages render on the glasses with their questions.
      await page.evaluate(() => window.__askUI.open()); await stopped();
      await expect.poll(body).toContain('First repeated answer.'); assert(!(await body()).includes('Mobile question 0?'));
      // Both the native menu and preview menu jump to the latest without leaving Ask.
      await page.locator('#ask-question').fill('Keep this draft');
      await page.evaluate(() => { for (let n = 0; n < 20; n++) window.__askUI.session.move(-1); });
      await expect.poll(body).toContain('Mobile question 0?');
      await page.evaluate(() => window.__glasses.handleEvent({ menuItemClickEvent: { itemID: 11 } }));
      await expect.poll(body).toContain('Second repeated answer.');
      await page.evaluate(() => window.__askUI.returnToReading()); await expect.poll(body).toBe(reading);
      await page.evaluate(() => window.__askUI.open()); await expect.poll(body).toContain('Second repeated answer.');
      await page.evaluate(() => { for (let n = 0; n < 20; n++) window.__askUI.session.move(-1); });
      await expect.poll(body).toContain('Mobile question 0?');
      await page.locator('#preview-menu-toggle').click(); await expect.poll(body).toContain('Go to latest');
      assert(!(await body()).includes('Go to position'));
      await page.locator('#preview').focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
      await expect.poll(body).toContain('Second repeated answer.'); await expect(page.locator('#ask-question')).toHaveValue('Keep this draft');
      await page.screenshot({ path: `${out}/${engine.name()}-latest.png`, fullPage: true });
      await page.evaluate(() => { for (let n = 0; n < 20; n++) window.__askUI.session.move(-1); });
      await expect.poll(body).toContain('Mobile question 0?');
      const first = await body();
      const anchor = await page.evaluate(() => { const ui = window.__askUI; ui.session.move(1); return ui.session.conversation.anchor(ui.session.y); });
      await expect.poll(body).not.toBe(first);
      const before = await body();
      const phoneAnchor = await page.evaluate(() => {
        const ui = window.__askUI, scroller = document.querySelector('#ask-history'), message = document.querySelectorAll('.ask-message-user')[4];
        ui.chatFollowing = false; scroller.scrollTop += message.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 10;
        return { key: message.dataset.key, offset: message.getBoundingClientRect().top };
      });
      turns.unshift({ id: 'backfill', question: 'Older mobile question?', answer: 'Older mobile answer.', state: 'complete' });
      turns[2].activities = [{ id: 'late-tool', kind: 'tool', text: 'Read todo.txt', state: 'complete' }];
      turns.push({ id: 'later', question: 'Later mobile question?', answer: 'Later mobile answer.', state: 'complete' });
      await poll(); assert.deepEqual(await page.evaluate(() => window.__askUI.session.conversation.anchor(window.__askUI.session.y)), anchor);
      await expect.poll(body).toBe(before);
      assert(Math.abs(await page.evaluate(key => [...document.querySelectorAll('.ask-message')].find(el => el.dataset.key === key).getBoundingClientRect().top, phoneAnchor.key) - phoneAnchor.offset) < 2, 'phone scroll position survives backfill');
      const texts = await page.locator('.ask-message-text').allTextContents();
      assert.equal(texts[0], 'Older mobile question?'); assert.equal(texts.at(-1), 'Later mobile answer.');
      // A history backfill while the phone tab is closed must preserve the
      // same visible message and offset when it reopens.
      const hiddenAnchor = await page.evaluate(() => window.__askUI.chatPosition());
      await page.locator('#tab-outline').click();
      turns[1].activities = [{ id: 'hidden-tool', kind: 'tool', text: 'Earlier tool activity backfilled while reading', state: 'complete' }];
      await poll();await page.locator('#ask-open').click();
      await expect.poll(() => page.evaluate(() => window.__askUI.chatPosition().key)).toBe(hiddenAnchor.key);
      assert(Math.abs((await page.evaluate(() => window.__askUI.chatPosition())).offset - hiddenAnchor.offset) < 2, 'hidden backfill preserves the phone anchor');
      result.hiddenBackfillPosition = true;
      offline = true; await poll(); await expect(page.locator('.ask-message-user')).toHaveCount(16);
      turns.push({ id: 'offline-1', question: 'Missed while offline?', answer: 'Recovered answer one.', state: 'complete' },
        { id: 'offline-2', question: 'Another missed question?', answer: 'Recovered answer two.', state: 'complete' });
      offline = false; await poll(); await expect(page.locator('.ask-message-user')).toHaveCount(18); await poll();
      await expect(page.locator('.ask-message-user')).toHaveCount(18);
      await page.screenshot({ path: `${out}/${engine.name()}-synced.png`, fullPage: true });
      await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await openPaper(); await page.locator('#ask-open').click(); await poll();
      await expect(page.locator('.ask-message-user')).toHaveCount(18);
      // Selecting another session while history is in flight discards the old response.
      let release; delayed = new Promise(resolve => { release = resolve; });
      const late = poll(); await expect.poll(() => delayed === null).toBe(true);
      await page.evaluate(() => window.__askUI.newSession()); release(); await late;
      await expect(page.locator('.ask-message-user')).toHaveCount(0);
      assert(requests.every(r => r.method === 'GET'), 'sync must never submit a prompt'); assert.deepEqual(result.errors, []);
      Object.assign(result, { passed: true, silentHistory: true, upgradedUnreadRepaired: true, newestUnreadOnly: true, latestMenus: true, mobileQuestions: true, unreadCatchup: true, offlineRecovery: true, reload: true, preservedAnchor: true, noDuplicatePrompts: true, staleSessionIgnored: true });
    } catch (error) { result.failure = error.stack; await page.screenshot({ path: `${out}/${engine.name()}-failure.png`, fullPage: true }); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
