import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installLibrarySync } from '../integrations/even-terminal/pageborne-library.js';
import { installReaderState, createReaderState } from '../integrations/even-terminal/pageborne-reader-state.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { showLibrary } from './ui-helpers.mjs';
process.env.PAGEBORNE_RELEASE_ASK_ORIGINS = 'http://127.0.0.1:5173';

const root = await mkdtemp(path.join(tmpdir(), 'reading-browser-')), libraryDir = path.join(root, 'library');
await mkdir(libraryDir); await mkdir('test-results/reading-activity', { recursive: true });
const prose = '# Reading record\n\n' + Array.from({ length: 45 }, (_, i) => `## Section ${i + 1}\n\n` + 'Reading carefully preserves the ideas while moving through a useful document. '.repeat(8)).join('\n\n');
await writeFile(path.join(libraryDir, 'paper.md'), prose);
await writeFile(path.join(libraryDir, 'original.pdf'), pdfFixture());
const options = { libraryDir, stateDir: path.join(root, 'state') }, state = createReaderState(options);
await state.update({ document: 'paper.md', agent: 'claude', sessionId: 'preserved-session', anchors: [] });
const app = express(); app.use(express.json({ limit: '2mb' }));
const api = express.Router(); installLibrarySync(api, options); installReaderState(api, options);
api.get('/info', (_req, res) => res.json({ pageborne: { conversationSync: 1 } }));
api.get('/events', (_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.write(': connected\n\n'); });
api.get('/pageborne/conversation', (req, res) => res.json({ version: 1, sessionId: req.query.sessionId, state: 'idle', turns: [{ id: 'turn', question: 'What did I read?', answer: 'The conversation is still available after deleting the document.', state: 'complete' }] }));
app.use('/api', api); const backend = app.listen(0, '127.0.0.1'); await new Promise(resolve => backend.once('listening', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--disable-gpu', '--js-flags=--max-old-space-size=384'] });
  for (const mode of ['release', 'web']) {
    // Phone startup now syncs deletions, so each profile needs a fresh original.
    await writeFile(path.join(libraryDir, 'paper.md'), prose);
    const vite = await createServer({ mode, cacheDir: `.state/vite-reading-${mode}`, clearScreen: false,
      optimizeDeps: { entries: ['index.html'] },
      plugins: [{ name: 'reading-test', transform(code, id) {
        if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
        if (id.endsWith('/src/main.js')) return code + `
          import { readingTotals as testTotals } from './reading-metrics.js';
          window.__reading = {
            get entries() { return readingLog?.entries || []; },
            get words() { return testTotals(readingLog?.entries).words; },
            get askWords() { return testTotals(readingLog?.entries, { kind: 'ask' }).words; },
            get units() { return [...readingTracker.units.values()].map(({key,words,text}) => ({key,words,text})); },
            get askUnits() { return [...askReadingTracker.units.values()]; },
            get askPane() { return askReadingTracker.pane; },
            get clearance() { return libraryClearance({ documents: documentsWithReadingCounts(), entries: readingLog?.entries,
              activity: snapshot.libraryActivity, removals: snapshot.libraryRemovals,
              scope: readerConnection().chatScope || '', endpoint: readerConnection().endpoint }); },
            clearanceFixture: (pending = false) => {
              readingLog.entries = [];
              const at = Date.now() - 86400000;
              snapshot = { ...snapshot, documents: [{ id: 'remaining.md', title: 'Remaining reading', words: 2000, bytes: 12000 },
                  ...(pending ? [{ id: 'pending.pdf', title: 'Preparing paper', format: 'pdf', bytes: 1000 }] : [])], libraryRemovals: [],
                libraryActivity: { version: 1, libraryId: 'fixture', endpoint: readerConnection().endpoint, startedAt: at - 30 * 86400000,
                  events: [{ id: 'd', kind: 'deleted', at, document: { name: 'deleted.md', words: 1000, addedAt: at - 86400000 } },
                    { id: 'a', kind: 'added', at, document: { name: 'added.md', words: 500, addedAt: at } },
                    ...(pending ? [{ id: 'p', kind: 'added', at, document: { name: 'pending.pdf', words: null, addedAt: at } },
                      { id: 'u', kind: 'deleted', at, document: { name: 'uncounted.pdf', words: null, addedAt: at - 86400000 } }] : [])] } };
              renderLibrary();
            },
            completeClearanceCounts: () => {
              snapshot.documents.find(doc => doc.id === 'pending.pdf').readingWords = 1000;
              snapshot.libraryActivity.events.find(event => event.id === 'p').document.words = 1000;
              snapshot.libraryActivity.events.find(event => event.id === 'u').document.words = 500;
              readingCountsChanged();
            },
            add: entries => readingLog.add(entries), sync: syncReading, remove: deleteDocument,
            next: () => reader.pageStep(1), get position() { return reader.y; },
            ask: () => {
              askUI.open();
              const turns = [{ id: 'reading-answer', question: 'Please explain this passage.',
                answer: 'The explanation connects these ideas with a detailed example. '.repeat(100), readThrough: 0, state: 'complete' }];
              askUI.chat.cache.set(askUI.paperKey, turns); askUI.session.syncConversation(turns, 'unread');
              askUI.session.setStatus('answer'); askUI.render(); dirty = true;
            },
            askNext: () => { askUI.session.move(1); dirty = true; },
            phoneAsk: () => { askUI.glassesVisible = false; askUI.reveal(); askUI.render();
              document.querySelector('#ask-question').blur(); document.querySelector('#ask-history').scrollTop = 0; dirty = true; },
            closeAsk: () => { askUI.close(); dirty = true; },
          };`;

      }, configureServer(server) { server.middlewares.use('/web/config', (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode: 'terminal', endpoint: `http://${req.headers.host}`, token: 'fixture', agent: 'claude' })); }); } }],
      server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false, watch: null, proxy: { '/api': `http://127.0.0.1:${backend.address().port}` } } });
    await vite.listen();
    const context = await browser.newContext({ viewport: { width: 440, height: 806 } }), page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', async response => { if (response.status() >= 400 && response.url().includes('/api/')) console.log(response.status(), new URL(response.url()).pathname, await response.text().catch(() => '')); });
    try {
      if (mode === 'release') await page.addInitScript(() => {
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: location.origin, token: 'fixture', agent: 'claude' } }));
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method === 'getLocalStorage') return localStorage.getItem(`sdk:${m.data.key}`) || '';
          if (m.method === 'setLocalStorage') { localStorage.setItem(`sdk:${m.data.key}`, m.data.value); return true; }
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      await page.goto(vite.resolvedUrls.local[0], { waitUntil: 'networkidle' });
      if (mode === 'release') {
        await expect(page.locator('#import')).toBeEnabled();
        await expect(page.locator('[data-document-id="paper.md"] .document-details')).toContainText('On desktop');
      }
      await expect(page.locator('[data-document-id="paper.md"]')).toBeAttached({ timeout: 30000 });
      await expect(page.locator('#library-reading-speed')).toHaveText('No average yet · estimates use 200 wpm');
      const paperTime = page.locator('[data-document-id="paper.md"] .document-reading-time');
      await expect(paperTime).toHaveText(/\d+ min/);
      if (mode === 'web') {
        await expect(page.locator('[data-document-id="original.pdf"] .document-reading-time')).toHaveText('—');
        await expect(page.locator('#library-reading-pending')).toContainText('1 document awaits');
      }
      if (await page.locator('#library-panel').getAttribute('data-open') !== 'true') await page.locator('#library-toggle').click();
      await page.locator('[data-document-id="paper.md"] .document-card').click();
      await page.evaluate(() => window.__reading.sync());
      await expect.poll(() => page.evaluate(() => window.__reading.units.length)).toBeGreaterThan(10);
      await expect(page.locator('[data-document-id="paper.md"]')).toBeAttached();
      const initial = await page.evaluate(() => window.__reading.words);
      const initialSpeed = await page.locator('#library-reading-speed').textContent();
      await page.waitForTimeout(6500);
      await page.evaluate(() => window.__reading.next());
      await expect.poll(() => page.evaluate(() => window.__reading.entries.filter(e => e.kind === 'document').length)).toBeGreaterThan(0);
      assert.equal(await page.evaluate(() => window.__reading.words), initial, 'one read pane stays in the raw log but is not counted');
      await expect(page.locator('#library-reading-speed')).toHaveText(initialSpeed);
      await page.waitForTimeout(6500);
      await page.evaluate(() => window.__reading.next());
      await expect.poll(() => page.evaluate(() => window.__reading.words)).toBeGreaterThan(initial);
      const read = await page.evaluate(() => window.__reading.words);
      await page.evaluate(() => window.__reading.next());
      await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => window.__reading.words) <= read + 15, 'fast paging cannot credit a whole screen');
      // Track acknowledged Ask panes with the same rate filter, independently
      // of document totals, and preserve the too-fast pane in the raw log.
      const docBeforeAsk = await page.evaluate(() => window.__reading.words), askBefore = await page.evaluate(() => window.__reading.askWords);
      await page.evaluate(() => window.__reading.ask());
      await expect.poll(() => page.evaluate(() => window.__reading.askUnits.length)).toBeGreaterThan(10);
      await page.waitForTimeout(8000);
      await page.evaluate(() => window.__reading.askNext());
      await expect.poll(() => page.evaluate(() => window.__reading.entries.filter(e => e.kind === 'ask').length)).toBeGreaterThan(0);
      assert.equal(await page.evaluate(() => window.__reading.askWords), askBefore, 'single Ask panes use the same exclusion');
      await page.waitForTimeout(8000);
      await page.evaluate(() => window.__reading.askNext());
      await expect.poll(() => page.evaluate(() => window.__reading.askWords)).toBeGreaterThan(askBefore + 10);
      const askBeforeFast = await page.evaluate(() => window.__reading.askWords);
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__reading.askNext());
      await page.waitForTimeout(300);
      assert.ok(await page.evaluate(() => window.__reading.askWords) <= askBeforeFast + 15);
      assert.ok(Math.abs(await page.evaluate(() => window.__reading.words) - docBeforeAsk) < 15);
      assert.ok((await page.evaluate(() => window.__reading.entries.filter(e => e.kind === 'ask'))).length >= 2);
      // The ordinary phone chat also counts clipped visible words, not the
      // offscreen answer or speaker/tool/status labels.
      await page.evaluate(() => window.__reading.phoneAsk());
      await expect.poll(() => page.evaluate(() => window.__reading.askPane?.platform)).toBe(mode === 'web' ? 'web' : 'preview');
      await expect.poll(() => page.evaluate(() => window.__reading.askUnits.length)).toBeGreaterThan(10);
      const phoneWords = await page.evaluate(() => window.__reading.askUnits.length);
      assert.ok(phoneWords < 900, 'only the visible part of the long answer is measured');
      await page.waitForTimeout(Math.max(6000, phoneWords * 100));
      await page.locator('#ask-history').evaluate(el => el.scrollTop += el.clientHeight);
      await page.locator('#ask-question').focus();
      await expect.poll(() => page.evaluate(() => window.__reading.askPane)).toBeNull();
      await page.waitForTimeout(200);
      await page.locator('#ask-question').blur();
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__reading.closeAsk());
      await page.evaluate(() => window.__reading.sync());
      if (await page.locator('#library-panel').getAttribute('data-open') !== 'true') await page.locator('#library-toggle').click();
      await page.locator('#reading-history-open').click();
      await expect(page.locator('.reading-chart button')).toHaveCount(30);
      await expect(page.locator('.reading-total')).not.toHaveText('0 words');
      const speed = await page.locator('#library-reading-speed').textContent();
      assert.match(speed, /^Your average: [\d,]+ wpm$/);
      await expect(page.locator('.reading-average')).toHaveText(`${speed} · documents only`);
      await expect(page.locator('.reading-combined-average')).toContainText('Including Ask:');
      await expect(page.locator('.reading-times')).toContainText('reading Ask');
      await expect(page.locator('.reading-entries > li')).toHaveCount(1);
      await expect(page.locator('.reading-entries > li > h3')).toHaveText('Reading record');
      await expect(page.locator('.reading-entries > li')).toContainText(/document words \+ [\d,]+ Ask words/);
      const helpButton = page.getByRole('button', { name: 'Help: Reading history', exact: true });
      const help = page.locator('#reading-history .help-popup');
      await expect(help).not.toBeVisible();
      await helpButton.click();
      await expect(help).toBeVisible();
      await expect(help).toContainText('Single-pane sessions do not count');
      await expect(help).toContainText('Export the viewing log to see all of them');
      await page.keyboard.press('Escape');
      await expect(help).not.toBeVisible();
      await expect(helpButton).toBeFocused();
      await expect(page.locator('#reading-history')).toBeVisible();
      for (const width of [320, 440]) {
        await page.setViewportSize({ width, height: 806 });
        const boxes = await page.locator('.reading-chart-controls').evaluate(row => {
          const date = row.querySelector('input').getBoundingClientRect(), help = row.querySelector('button').getBoundingClientRect(), bounds = row.getBoundingClientRect();
          return { sameRow: Math.abs((date.top + date.bottom) / 2 - (help.top + help.bottom) / 2) < 2,
            rightAligned: Math.abs(help.right - bounds.right) < 2, fits: date.right <= help.left && bounds.right <= innerWidth };
        });
        assert.ok(boxes.sameRow && boxes.rightAligned && boxes.fits, 'help is at the right of the date row without overflow');
      }
      await page.locator('.reading-view-log summary').first().click();
      await expect(page.locator('.reading-view-log[open]')).toContainText('Start');
      await expect(page.locator('.reading-view-log[open] time').first()).toHaveAttribute('datetime', /T/);
      await expect(page.locator('.reading-view-log[open]')).toContainText('End');
      await expect(page.locator('.reading-view-log[open]')).toContainText('Document ·');
      await expect(page.locator('.reading-view-log[open]')).toContainText('Ask ·');
      await page.screenshot({ path: `test-results/reading-activity/${mode}-views.png` });
      await page.locator('#reading-history').evaluate(el => el.scrollTop = 0);
      await page.screenshot({ path: `test-results/reading-activity/${mode}-history.png` });
      await page.locator('#reading-history').getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(() => window.__reading.remove('paper.md'));
      const clearance = await page.evaluate(() => window.__reading.clearance);
      assert.ok(clearance.deletedWords > 4000);
      assert.equal(clearance.readWords, 0, 'reading and deleting the same text never count twice');
      assert.equal(clearance.wordsPerDay, clearance.deletedWords / 30);
      await showLibrary(page);
      await expect(page.locator('#library-clearance-rate')).toContainText('last 30 days');
      await page.getByRole('button', { name: 'Help: Library clearance', exact: true }).click();
      await expect(page.locator('#library-clearance-detail')).toBeVisible();
      await expect(page.locator('#library-clearance-detail')).toContainText('Deletion tracking began');
      await page.keyboard.press('Escape');
      for (const width of [320, 440]) {
        await page.setViewportSize({ width, height: 806 });
        assert.ok(await page.locator('.library-time-values').evaluate(el => el.getBoundingClientRect().right <= innerWidth));
      }
      await page.screenshot({ path: `test-results/reading-activity/${mode}-clearance.png` });
      await page.locator('#reading-history-open').click();
      await expect(page.locator('.reading-entries')).toContainText('Document no longer in this library');
      await page.locator('.reading-entries').getByRole('button', { name: 'Claude conversation', exact: true }).first().click();
      await expect(page.locator('.reading-conversation')).toContainText('still available after deleting');
      await page.screenshot({ path: `test-results/reading-activity/${mode}-archived-chat.png` });
      await page.reload({ waitUntil: 'networkidle' });
      await page.evaluate(() => window.__reading.sync());
      const afterRestart = await page.evaluate(() => window.__reading.clearance);
      assert.equal(afterRestart.deletedWords, clearance.deletedWords, 'offline audit and desktop acknowledgement count only once');
      if (await page.locator('#library-panel').getAttribute('data-open') !== 'true') await page.locator('#library-toggle').click();
      await page.locator('#reading-history-open').click();
      await expect(page.locator('.reading-total')).not.toHaveText('0 words');
      await expect(page.locator('#library-reading-speed')).toHaveText(speed);
      await expect(page.locator('.reading-entries')).toContainText('Reading record');
      // More than one list page of consecutive readings must collapse before
      // pagination, while a different document separates two runs of this one.
      const groupedDay = mode === 'web' ? '2000-01-03' : '2000-01-02';
      await page.evaluate(async ({ day, mode }) => {
        const source = window.__reading.entries.find(e => e.document.id === 'paper.md');
        // These are legacy observations. Do not inherit a modern "leave"
        // marker, which would correctly split every fixture into a new visit.
        const entry = (id, hour, second, extra = {}) => ({ ...source, id: `grouped-${mode}-${id}`, version: undefined, reason: undefined, kind: 'document', day,
          at: `${day}T${hour}:00:${String(second).padStart(2, '0')}.000Z`, endedAt: `${day}T${hour}:01:00.000Z`, words: 1, seconds: 1, ...extra });
        await window.__reading.add([
          entry('earliest', '10', 0, { words: 3 }),
          entry('other', '11', 0, { words: 2, document: { id: 'other.md', key: 'other', title: 'Another document' } }),
          ...Array.from({ length: 55 }, (_, i) => entry(i, '12', i, { page: i + 1,
            sessions: i === 0 ? [{ agent: 'codex', id: 'older-linked-chat' }] : source.sessions })),
        ]);
      }, { day: groupedDay, mode });
      await page.locator('#reading-history input[type=date]').fill(groupedDay);
      await page.locator('#reading-history input[type=date]').dispatchEvent('change');
      await expect(page.locator('.reading-entries > li')).toHaveCount(1);
      await expect(page.locator('.reading-total')).toHaveText('55 words');
      await expect(page.locator('.reading-explanation').first()).not.toBeVisible();
      assert.equal(await page.evaluate(day => window.__reading.entries.filter(e => e.day === day).length, groupedDay), 57,
        'excluded entries remain in the raw viewing log');
      const grouped = page.locator('.reading-entries > li').first();
      await expect(grouped).toContainText('55 words · pages 1–55');
      await expect(grouped.getByRole('button', { name: 'Claude conversation', exact: true })).toHaveCount(1);
      await grouped.getByRole('button', { name: 'Codex conversation', exact: true }).click();
      await expect(page.locator('.reading-conversation')).toContainText('still available after deleting');
      await page.getByRole('button', { name: '← Reading history', exact: true }).click();
      await expect(page.locator('.reading-entries > li')).toHaveCount(1);
      await page.screenshot({ path: `test-results/reading-activity/${mode}-grouped.png` });
      if (mode === 'web') {
        await page.setViewportSize({ width: 834, height: 1194 });
        await page.screenshot({ path: 'test-results/reading-activity/ipad-history.png' });
        await page.locator('#reading-history').getByRole('button', { name: 'Close', exact: true }).click();
        await page.locator('[data-document-id="original.pdf"] .document-card').click();
        await expect.poll(() => page.evaluate(() => window.__reading.units.length), { timeout: 30000 }).toBeGreaterThan(0);
        assert.ok((await page.evaluate(() => window.__reading.units)).every(unit => typeof unit.text === 'string'));
        await expect(page.locator('[data-document-id="original.pdf"] .document-reading-time')).not.toHaveText('—');
        await expect(page.locator('#library-reading-pending')).toBeHidden();
        const duration = await page.locator('[data-document-id="original.pdf"] .document-reading-time').textContent();
        await page.reload({ waitUntil: 'networkidle' });
        await expect(page.locator('[data-document-id="original.pdf"] .document-reading-time')).toHaveText(duration);
      }
      if (await page.locator('#reading-history').isVisible()) await page.locator('#reading-history').getByRole('button', { name: 'Close', exact: true }).click();
      for (const width of [320, 440, 834]) {
        await page.setViewportSize({ width, height: 900 });
        await showLibrary(page);
        await page.waitForFunction(() => { const r = document.querySelector('#library-panel').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
        await expect(page.locator('#library-reading-speed')).toBeVisible();
        const total = await page.locator('#library-reading-time').textContent();
        await page.locator('#filter').fill('no matching text');
        await expect(page.locator('#library-reading-time')).toHaveText(total, { timeout: 1000 });
        await page.locator('#filter').fill('');
        const fits = await page.locator('.document-info').evaluateAll(nodes => nodes.every(info => {
          const r = info.getBoundingClientRect(), t = info.querySelector('.document-reading-time').getBoundingClientRect();
          return Math.abs(t.right-r.right) < 1 && t.left >= r.left && t.right <= innerWidth;
        }));
        assert(fits, 'reading time is right aligned on the metadata row without overflowing');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `test-results/reading-activity/${mode}-library-time-${width}.png` });
      }
      await page.evaluate(() => window.__reading.clearanceFixture());
      await expect(page.locator('#library-clearance-days')).toHaveText('~60 days');
      await expect(page.locator('#library-reading-time')).toHaveText('10 min');
      await expect(page.locator('#library-clearance-ratio')).toHaveText('Additions / clearance: 0.50');
      for (const width of [320, 440]) {
        await page.setViewportSize({ width, height: 806 });
        await showLibrary(page);
        await page.waitForFunction(() => { const r = document.querySelector('#library-panel').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
        await expect(page.locator('#library-clearance-days')).toBeVisible();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `test-results/reading-activity/${mode}-clearance-known-${width}.png` });
      }
      await page.evaluate(() => window.__reading.clearanceFixture(true));
      await expect(page.locator('#library-clearance-days')).toHaveText('~60 days · partial');
      await expect(page.locator('#library-clearance-ratio')).toHaveText('Additions / clearance: 0.50 · partial');
      await expect(page.locator('#library-reading-time')).toHaveText('10 min+');
      await expect(page.locator('#library-clearance-detail')).toContainText('Pending word counts are excluded');
      for (const width of [320, 440]) {
        await page.setViewportSize({ width, height: 806 });
        await showLibrary(page);
        await page.waitForFunction(() => { const r = document.querySelector('#library-panel').getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: `test-results/reading-activity/${mode}-clearance-partial-${width}.png` });
      }
      await page.evaluate(() => window.__reading.completeClearanceCounts());
      await expect(page.locator('#library-clearance-days')).toHaveText('~60 days');
      await expect(page.locator('#library-clearance-ratio')).toHaveText('Additions / clearance: 1.00');
      await expect(page.locator('#library-reading-time')).toHaveText('15 min');
      await expect(page.locator('#library-clearance-detail')).not.toContainText('Pending word counts');
      assert.deepEqual(errors, []);
      console.log(`${mode}: reading, fast paging, graph, deletion, archived chat, reload passed`);
    } catch (error) {
      console.log(mode, errors, await page.evaluate(() => ({ entries: window.__reading?.entries, status: document.querySelector('#notice')?.textContent })).catch(() => ({})));
      throw error;
    } finally { await context.close(); await vite.close(); }
  }
} finally { await browser?.close(); await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true }); }
