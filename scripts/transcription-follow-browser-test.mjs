// Real AskUI, native microphone lifecycle and serialized glasses display.
// Only recognition and the native host are fixtures; no physical-device claim.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://transcription-follow.test';
const out = 'test-results/transcription-follow'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'debug', plugins: [displayProbe(), { name: 'voice-setup-fixture', transform(code, id) {
  if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
} }], cacheDir: '.state/vite-transcription-follow', optimizeDeps: { entries: ['index.html'] },
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen();
const reports = [];
try {
  for (const engine of process.env.VOICE_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH });
    const report = { engine: engine.name(), physicalGlasses: false, passed: false, errors: [] }; reports.push(report);
    try {
      const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
      page.on('pageerror', error => report.errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://transcription-follow.test', token: 'fixture', agent: 'codex' } }));
        const storage = new Map(); window.__boxes = {}; window.__mic = [];
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const { method, data } = JSON.parse(payload);
          if (method === 'getLocalStorage') return storage.get(data.key) || '';
          if (method === 'setLocalStorage') { storage.set(data.key, data.value); return true; }
          if (method === 'textContainerUpgrade') window.__boxes[data.containerName] = data.content;
          if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(method)) window.__boxes = Object.fromEntries(data.textObject.map(b => [b.containerName, b.content]));
          if (method === 'audioControl') window.__mic.push(data);
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(method) ? 0 : true;
        } };
      });
      let prompts = 0;
      await page.route('https://transcription-follow.test/**', route => {
        if (route.request().url().endsWith('/prompt')) prompts++;
        return route.fulfill({ json: {}, headers: { 'Access-Control-Allow-Origin': '*' } });
      });
      await page.goto(vite.resolvedUrls.local[0]);
      await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      await page.locator('#file-picker').setInputFiles({ name: 'dictation.md', mimeType: 'text/markdown', buffer: Buffer.from('# Dictation\n\n' + 'Reading before asking. '.repeat(30)) });
      await showLibrary(page); await page.locator('[data-document-id="dictation.md"] .document-card').click();
      await page.evaluate(() => {
        const ask = window.__askUI;
        ask.speech.models.open = async () => [];
        ask.stream.start = () => { window.__finish = null; };
        ask.stream.receive = () => {};
        ask.stream.cancel = () => {};
        ask.stream.finish = () => new Promise(resolve => { window.__finish = resolve; });
        ask.open(); ask.reveal();
      });
      const input = page.locator('#ask-question');
      const text = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');
      const partial = text => page.evaluate(text => window.__askUI.stream.result({ text, words: [] }), text);
      const bottomGap = () => input.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
      const glasses = () => page.evaluate(() => window.__reviewText);
      const start = async () => {
        await page.evaluate(async () => {
          const ask = window.__askUI; await ask.hold('glasses');
          ask.mic.receive(new Uint8Array(64000));
        });
        await expect.poll(() => page.evaluate(() => window.__askUI.session.status)).toBe('listening');
      };
      const release = async () => {
        await page.evaluate(() => { window.__release = window.__askUI.release(); });
        await expect.poll(() => page.evaluate(() => typeof window.__finish)).toBe('function');
        await expect(page.locator('#ask-status')).toHaveText('Refining…');
      };
      const finish = text => page.evaluate(async text => { window.__finish({ text, words: [] }); await window.__release; }, text);
      await start(); await partial(text);
      await expect.poll(glasses).toMatch(/word129$/); await expect.poll(bottomGap).toBeLessThan(2);
      const before = await glasses();
      await release(); await expect.poll(glasses).toBe(before);
      for (const suffix of [' afterrelease', ' afterrelease ' + 'More arriving words. '.repeat(25) + 'stillprocessing']) {
        await partial(text + suffix);
        await expect.poll(glasses).toMatch(new RegExp(suffix.split(' ').at(-1) + '$'));
        await expect.poll(bottomGap).toBeLessThan(2);
      }
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-processing.png` });
      await finish(text + ' The final words have arrived.');
      await expect.poll(glasses).toMatch(/arrived\.$/); await expect.poll(bottomGap).toBeLessThan(2);
      await expect(page.locator('#ask-status')).toHaveText('');
      assert.equal(await page.evaluate(() => window.__askUI.session.review.completing), false);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}-complete.png` });
      report.releaseAndCompletionFollow = true;

      // Manual scrollback on either surface survives more drafts and completion.
      await start(); await partial(text); await release();
      await page.evaluate(() => window.__askUI.handle('previous-page'));
      await expect.poll(glasses).not.toMatch(/word129$/);
      const earlier = await glasses();
      await input.evaluate(el => { el.scrollTop = 0; });
      await expect.poll(() => page.evaluate(() => window.__askUI.questionFollowing)).toBe(false);
      await partial(text + ' NEW'); await expect.poll(glasses).toBe(earlier);
      assert.equal(await input.evaluate(el => el.scrollTop), 0);
      await finish(text + ' FINAL'); await expect.poll(glasses).toBe(earlier);
      assert.equal(await input.evaluate(el => el.scrollTop), 0);
      await expect(page.locator('#ask-status')).toHaveText('');
      report.manualScrollbackPreserved = true;

      // A new hold restores following; scrolling to the bottom resumes it.
      await start(); await partial(text); await expect.poll(bottomGap).toBeLessThan(2);
      await release();
      await input.evaluate(el => { el.scrollTop = 0; });
      await expect.poll(() => page.evaluate(() => window.__askUI.questionFollowing)).toBe(false);
      await input.evaluate(el => { el.scrollTop = el.scrollHeight; });
      await expect.poll(() => page.evaluate(() => window.__askUI.questionFollowing)).toBe(true);
      await partial(text + ' FOLLOWING'); await expect.poll(bottomGap).toBeLessThan(2);
      await expect.poll(glasses).toMatch(/FOLLOWING$/);
      await finish('Short corrected result'); await expect.poll(glasses).toBe('Short corrected result');
      await expect.poll(bottomGap).toBeLessThan(2);
      report.resumesAndClamps = true;

      // Editing and cancellation must revoke pending recognition.
      await start(); await partial(text); await release();
      await input.fill('My edited question');
      await finish('Stale recognition');
      await expect(input).toHaveValue('My edited question');
      await expect.poll(glasses).toBe('My edited question');
      await expect(page.locator('#ask-status')).toHaveText('');
      await start(); await partial(text); await release();
      await page.evaluate(() => window.__askUI.handle('back')); await finish('Stale after cancellation');
      await expect(input).toHaveValue('');
      assert.equal(await page.evaluate(() => window.__askUI.session.review), null);
      assert.equal(prompts, 0, 'release, recognition and review never send automatically');
      report.editsAndCancellationSafe = true;
      assert.deepEqual(report.errors, []); report.passed = true;
    } finally { await browser.close(); }
  }
} finally { await writeFile(`${out}/report.json`, JSON.stringify(reports, null, 2)); await vite.close(); }
console.log('PASS: long dictation follows through release/completion on glasses and phone; manual scrolling, edits and cancellation remain safe.');
