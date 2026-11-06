// Real library import, preferences and native picker; speech/bridge IO is mocked.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

const out = 'test-results/library-sort'; await mkdir(out, { recursive: true });
const reports = [];
try {
  for (const platform of ['glasses', 'web']) {
    const server = await createServer({ mode: platform === 'web' ? 'web' : 'release', plugins: [displayProbe(), {
      name: 'sort-fixtures', transform(code, id) {
        if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
      }, configureServer(vite) {
        // Local library operation does not require a paired desktop.
        vite.middlewares.use('/web/config', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{}'); });
      },
    }], cacheDir: `.state/vite-library-sort-${platform}`, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
    await server.listen();
    try { for (const engine of process.env.LIBRARY_SORT_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
      const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
      const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      const report = { platform, engine: engine.name(), errors: [], passed: false }; reports.push(report);
      page.on('pageerror', error => report.errors.push(error.message));
      try {
        if (platform === 'glasses') {
          const values = new Map();
          await page.exposeFunction('__storage', ({ method, data }) => method === 'getLocalStorage' ? values.get(data.key) || '' : (values.set(data.key, data.value), true));
          await page.addInitScript(() => {
            window.flutter_inappwebview = { async callHandler(_, payload) {
              const m = JSON.parse(payload);
              if (m.method.endsWith('LocalStorage')) return window.__storage(m);
              return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
            } };
          });
        }
        const order = () => page.locator('#documents .document-entry').evaluateAll(nodes => nodes.map(node => node.dataset.documentId));
        const picker = () => page.evaluate(() => {
          const p = window.__displayFrame?.picker;
          return p ? { ids: p.items.map(item => item.id).filter(id => typeof id === 'string'), selected: p.items[p.index]?.id } : null;
        });
        await page.goto(server.resolvedUrls.local[0]);
        await expect(page.locator('#import')).toBeEnabled();
        await expect(page.locator('#library-sort')).toHaveValue('recent');
        for (const [name, title, length] of [['chapter10.md', 'Alpha', 10], ['appendix.md', 'Middle', 300], ['chapter2.md', 'Zulu', 150]]) {
          await page.locator('#file-picker').setInputFiles({ name, mimeType: 'text/markdown', buffer: Buffer.from(`# ${title}\n\n${'Sample text. '.repeat(length)}`) });
          await expect(page.locator(`[data-document-id="${name}"]`)).toBeVisible();
        }
        const added = ['chapter2.md', 'appendix.md', 'chapter10.md'];
        const alphabetic = ['appendix.md', 'chapter2.md', 'chapter10.md'];
        const readingTime = ['chapter10.md', 'chapter2.md', 'appendix.md'];
        await expect.poll(order).toEqual(added);
        for (const id of ['chapter10.md', 'chapter2.md']) {
          await page.locator(`[data-document-id="${id}"] .document-card`).click();
          await expect(page.locator('#doc-path')).toHaveText(id);
          await showLibrary(page);
        }
        const recent = ['chapter2.md', 'chapter10.md', 'appendix.md'];
        await expect.poll(order).toEqual(recent);
        if (platform === 'glasses') {
          await page.evaluate(() => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { menuItemClickEvent: { itemID: 7 } } })));
          await expect.poll(picker).toEqual({ ids: recent, selected: 'chapter2.md' });
        }
        for (const [sort, expected] of [['added', added], ['name', alphabetic], ['recent', recent], ['time', readingTime]]) {
          await page.locator('#library-sort').selectOption(sort);
          await expect.poll(order).toEqual(expected);
          if (platform === 'glasses') await expect.poll(picker).toEqual({ ids: expected, selected: 'chapter2.md' });
          await expect(page.locator('#doc-path')).toHaveText('chapter2.md');
        }
        await page.locator('#filter').fill('chapter');
        await expect.poll(order).toEqual(readingTime.slice(0, 2));
        await page.locator('#filter').fill('');
        await expect.poll(order).toEqual(readingTime);
        // A new browser origin must recover the native phone preference too.
        await page.waitForTimeout(700);
        if (platform === 'glasses') await page.evaluate(() => localStorage.clear());
        await page.reload(); await expect(page.locator('#import')).toBeEnabled(); await showLibrary(page);
        await expect(page.locator('#library-sort')).toHaveValue('time');
        await expect.poll(order).toEqual(readingTime);
        // A new addition must outrank a previously opened document. Restoring
        // the selected document after reload must not count as another open.
        await page.locator('#library-sort').selectOption('recent');
        await page.locator('#file-picker').setInputFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('New addition.') });
        await expect.poll(order).toEqual(['new.txt', ...recent]);
        await page.waitForTimeout(700); await page.reload();
        await expect(page.locator('#import')).toBeEnabled(); await showLibrary(page);
        await expect.poll(order).toEqual(['new.txt', ...recent]);
        await page.locator('[data-document-id="appendix.md"] .document-card').click(); await showLibrary(page);
        await expect.poll(order).toEqual(['appendix.md', 'new.txt', 'chapter2.md', 'chapter10.md']);
        await page.locator('#library-sort').selectOption('time');
        await expect.poll(order).toEqual(['new.txt', ...readingTime]);
        for (const width of [320, 834]) {
          await page.setViewportSize({ width, height: 806 }); await showLibrary(page);
          await expect.poll(async () => {
            const box = await page.locator('#library-sort').boundingBox();
            return box.height >= 44 && box.x >= 0 && box.x + box.width <= width;
          }).toBe(true);
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: `${out}/${platform}-${engine.name()}-${width}.png` });
        }
        assert.deepEqual(report.errors, []); report.passed = true;
      } catch (error) { report.failure = error.stack; await page.screenshot({ path: `${out}/${platform}-${engine.name()}-failure.png` }); throw error; }
      finally { await browser.close(); }
    } } finally { await server.close(); }
  }
} finally { await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
