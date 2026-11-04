// Real app/SDK dispatcher with deterministic transport; no BLE timing claims.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, hideSettings, backToReading } from './ui-helpers.mjs';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';

const out = 'test-results/reading-controls'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'release', plugins: [{ name: 'controls-speech-fixture', transform(code, id) {
  if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
} }], cacheDir: '.state/vite-reading-controls', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen(); const results = [];
try {
  for (const engine of process.env.READING_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch(engine === chromium ? { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--js-flags=--max-old-space-size=384'] }
      : { headless: true, ...(process.env.WEBKIT_PATH ? { executablePath: process.env.WEBKIT_PATH } : {}) });
    const result = { engine: engine.name(), passed: false, errors: [], physicalGlasses: false }; results.push(result);
    let page;
    try {
      page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      page.on('pageerror', error => result.errors.push(error.message));
      await page.addInitScript(() => {
        // An old preference must not restore the conflicting single-tap mapping.
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ readingTap: 'conversation', pdfDefaults: { reflow: false } }));
        window.__boxes = {}; window.__images = 0;
        const storage = new Map();
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const m = JSON.parse(payload);
          if (m.method === 'getLocalStorage') return storage.get(m.data.key) || '';
          if (m.method === 'setLocalStorage') { storage.set(m.data.key, m.data.value); return true; }
          if (m.method === 'updateImageRawData') window.__images++;
          if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) window.__boxes = {};
          for (const t of (m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || [])) window.__boxes[t.containerName] = { ...window.__boxes[t.containerName], ...t };
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
        } };
      });
      const event = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
      const menu = itemID => page.evaluate(itemID => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { menuItemClickEvent: { itemID } } })), itemID);
      const openModes = async () => { await event(4); await menu(3); await event(5); await expect.poll(popup).toContain('Pages'); };
      const body = () => page.evaluate(() => window.__boxes.body?.content || '');
      const popup = () => page.evaluate(() => [0, 1, 2].map(i => window.__boxes['mode-option-' + i]?.content || '').join('\n').trim());
      const position = () => page.locator('#position').inputValue();
      const seek = value => page.locator('#position').evaluate((el, value) => { el.value = value; el.dispatchEvent(new Event('input')); }, value);
      const mode = value => page.locator(`#mode-${value}`).evaluate(el => el.click());
      const paused = () => expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'false');
      await page.goto(vite.resolvedUrls.local[0]); await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await page.locator('#file-picker').setInputFiles([
        { name: 'controls.md', mimeType: 'text/markdown', buffer: Buffer.from('# Controls\n\n' + 'A paragraph with enough words for sustained reading. '.repeat(500)) },
        { name: 'scanned.pdf', mimeType: 'application/pdf', buffer: pdfFixture('annotations') },
      ]);
      await showLibrary(page); await page.locator('[data-document-id="controls.md"] .document-card').click();
      await expect.poll(body).toMatch(/^Controls/);
      const firstPlace = await position();
      const readingBody = await body();
      await page.locator('#ask-open').click(); await expect(page.locator('#ask-panel')).toBeVisible();
      await expect(page.locator('#ask-back, #ask-navigation')).toHaveCount(0);
      await expect(page.locator('#transport')).toBeHidden();
      await expect.poll(body).toBe(readingBody);
      await backToReading(page);
      result.phoneAskKeepsGlassesReading = true;
      await event(0); await expect(page.locator('#ask-panel')).toBeVisible();
      await event(0); await expect(page.locator('#ask-panel')).toBeHidden(); assert.equal(await position(), firstPlace);
      await event(2); await expect(page.locator('#page-number')).toHaveValue('2');
      result.pagesTapAskAndSwipePages = true;
      const pagePlace = await position();
      await event(3); await expect.poll(body).toMatch(/^Choose document/);
      await event(0); await expect(page.locator('#title')).toHaveText('Controls');
      await expect.poll(position).toBe(pagePlace); await hideSettings(page);
      result.pagesBackPreserved = true;

      for (const value of ['auto', 'speed']) {
        await mode(value); await seek('300');
        await event(0); await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('#ask-open').click(); await expect(page.locator('#ask-panel')).toBeVisible();
        await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#preview')).not.toHaveAttribute('aria-label', /^Ask about this:/);
        await backToReading(page);
        await event(0); await paused(); const place = await position();
        for (const returnTap of [0, 3]) {
          await event(3); await expect(page.locator('#ask-panel')).toBeVisible();
          await event(returnTap); await expect(page.locator('#ask-panel')).toBeHidden();
          await paused(); assert.equal(await position(), place);
        }
        await event(0); await expect(page.locator('#play')).toHaveAttribute('aria-pressed', 'true');
        await openModes(); await paused();
        await expect.poll(popup).toContain(value === 'auto' ? '> Autoscroll' : '> Speed read');
        const pickerPlace = await position(), rate = await page.locator('#speed-value').textContent();
        await event(2); await event(2);
        assert.equal(await position(), pickerPlace); assert.equal(await page.locator('#speed-value').textContent(), rate);
        await expect(page.locator(`#mode-${value}`)).toHaveAttribute('aria-pressed', 'true');
        await event(3); await expect.poll(popup).toBe(''); await paused();
        assert.equal(await position(), pickerPlace);
      }
      result.playPauseAndAsk = result.pickerCancelPreservesReading = true;

      await mode('page'); await openModes(); await event(1); await expect.poll(popup).toContain('> Speed read');
      await event(2); await expect.poll(popup).toContain('> Pages');
      await event(2); await event(0); await expect(page.locator('#mode-auto')).toHaveAttribute('aria-pressed', 'true'); await paused();
      await openModes(); await event(2); await event(0); await expect(page.locator('#mode-speed')).toHaveAttribute('aria-pressed', 'true'); await paused();
      await openModes(); await event(2); await event(0); await expect(page.locator('#mode-page')).toHaveAttribute('aria-pressed', 'true');
      // Pages can still open Ask from the menu, and either tap returns to reading.
      for (const returnTap of [0, 3]) {
        const place = await position(); await menu(10); await expect(page.locator('#ask-panel')).toBeVisible();
        await event(returnTap); await expect(page.locator('#ask-panel')).toBeHidden(); assert.equal(await position(), place);
      }
      result.allModesSelectable = result.askReturnsInEveryMode = true;

      // Cancelling a native or preview menu restores Ask, not the paper.
      // Draft, reading position and the selected conversation all survive.
      await menu(10); await expect(page.locator('#ask-panel')).toBeVisible();
      await page.locator('#ask-question').fill('Keep this unsent draft');
      await expect.poll(body).toContain('Ask about this');
      const askBody = await body(), askPlace = await position();
      await event(4); await event(5);
      await expect(page.locator('#ask-panel')).toBeVisible();
      await expect.poll(body).toBe(askBody);
      for (const dismiss of ['back', 'toggle']) {
        await page.locator('#preview-menu-toggle').click(); await expect.poll(body).toMatch(/^Pageborne menu/);
        if (dismiss === 'back') { await page.locator('#preview').focus(); await page.keyboard.press('Escape'); }
        else await page.locator('#preview-menu-toggle').click();
        await expect.poll(body).toBe(askBody);
        await expect(page.locator('#ask-panel')).toBeVisible();
        await expect(page.locator('#ask-question')).toHaveValue('Keep this unsent draft');
        assert.equal(await position(), askPlace);
      }
      result.menuDismissalPreservesAsk = true;
      // An actual reading action in that same menu still leaves Ask.
      await openModes(); await expect(page.locator('#ask-panel')).toBeHidden();
      await event(3); await expect.poll(popup).toBe(''); await paused();

      // The preview's actual taps and keyboard use the same selector and bindings.
      await page.locator('#preview-menu-toggle').click(); await expect.poll(body).toMatch(/^Pageborne menu/);
      await page.locator('#preview').click(); await expect.poll(popup).toContain('Pages');
      await page.locator('#preview').focus(); await page.keyboard.press('ArrowDown'); await expect.poll(popup).toContain('> Autoscroll');
      await page.keyboard.press('Enter'); await expect(page.locator('#mode-auto')).toHaveAttribute('aria-pressed', 'true');
      await page.locator('#preview').dblclick({ delay: 80 }); await expect(page.locator('#ask-panel')).toBeVisible();
      await page.locator('#preview').dblclick({ delay: 80 }); await expect(page.locator('#ask-panel')).toBeHidden(); await paused();
      await openModes(); await page.locator('#preview').focus(); await page.keyboard.press('Escape'); await expect.poll(popup).toBe('');
      await openModes(); await seek('450'); await expect.poll(popup).toBe('');
      result.previewAndKeyboard = result.phoneJumpDismissesPicker = true;

      await showLibrary(page); await page.locator('[data-document-id="scanned.pdf"] .document-card').click();
      await expect.poll(() => page.evaluate(() => window.__images), { timeout: 30000 }).toBeGreaterThan(0);
      await openModes(); await expect.poll(popup).toContain('> Autoscroll');
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-mode-selector.png` });
      await event(2); await event(0); await expect(page.locator('#mode-speed')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(popup).toBe(''); await paused();
      result.pdfFigureUnderModePopup = true;
      assert.deepEqual(result.errors, []); result.passed = true;
    } catch (error) { result.error = error.stack; await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); throw error; }
    finally { await browser.close(); }
  }
} finally { await vite.close(); await writeFile(`${out}/results.json`, JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results));
