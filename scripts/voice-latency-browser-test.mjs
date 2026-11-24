// Real AskUI, frame queue and Even SDK; recognition and BLE are fixtures.
// Prove new words enter the queue without waiting for a reading timer, even
// while a slow display call is outstanding. No physical-device timing claim.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://voice-latency.test';
const out = 'test-results/voice-latency'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'debug', plugins: [displayProbe(), { name: 'voice-setup-fixture', transform(code, id) {
  if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
} }], cacheDir: '.state/vite-voice-latency', optimizeDeps: { entries: ['index.html'] },
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
        localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://voice-latency.test', token: 'fixture', agent: 'codex' } }));
        const storage = new Map(); window.__activeDisplay = 0; window.__maxDisplay = 0; window.__boxes = {};
        window.flutter_inappwebview = { async callHandler(_, payload) {
          const { method, data } = JSON.parse(payload);
          if (method === 'getLocalStorage') return storage.get(data.key) || '';
          if (method === 'setLocalStorage') { storage.set(data.key, data.value); return true; }
          if (['createStartUpPageContainer', 'rebuildPageContainer', 'textContainerUpgrade'].includes(method)) {
            window.__maxDisplay = Math.max(window.__maxDisplay, ++window.__activeDisplay);
            if (window.__displayDelay) await new Promise(resolve => setTimeout(resolve, window.__displayDelay));
            if (method === 'textContainerUpgrade') window.__boxes[data.containerName] = data.content;
            else window.__boxes = Object.fromEntries(data.textObject.map(b => [b.containerName, b.content]));
            window.__activeDisplay--;
          }
          return ['createStartUpPageContainer', 'updateImageRawData'].includes(method) ? 0 : true;
        } };
      });
      await page.route('https://voice-latency.test/**', route => route.fulfill({ json: {}, headers: { 'Access-Control-Allow-Origin': '*' } }));
      await page.goto(vite.resolvedUrls.local[0]);
      await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
      assert.equal(await page.evaluate(() => window.__askUI.stream.streamOptions.batchOverlaps), true, 'production voice batches already decoded overlaps');
      report.backendBatching = await page.evaluate(async () => {
        const speech = window.__askUI.speech, originalPrepare = speech.models.prepare, originalTranscribe = speech.transcribe;
        const results = [];
        try {
          for (const ready of [{ backend: 'webgpu', threads: 1 }, { backend: 'wasm', threads: 4 }, { backend: 'wasm', threads: 1 }]) {
            speech.models.prepare = async () => ready;
            const stream = speech.stream({ result() {} }); stream.start();
            try {
              await stream.models.prepare('fluid-mini', {});
              results.push(stream.streams.get('fluid-mini').batchOverlaps);
              // GPU can fail mid-recording. Its CPU replay must enable batching
              // before the next pass, not wait for a new recording.
              speech.transcribe = async () => ({ backend: 'wasm', threads: 1 });
              await stream.models.transcribe('fluid-mini', new Blob(), {});
              results.push(stream.streams.get('fluid-mini').batchOverlaps);
            } finally { stream.cancel(); }
          }
          const override = speech.stream({ result() {}, streamOptions: { batchOverlaps: false } }); override.start();
          try { await override.models.prepare('fluid-mini', {}); results.push(override.streams.get('fluid-mini').batchOverlaps); }
          finally { override.cancel(); }
        } finally { speech.models.prepare = originalPrepare; speech.transcribe = originalTranscribe; }
        return results;
      });
      assert.deepEqual(report.backendBatching, [false, true, false, true, true, true, false]);
      await page.locator('#file-picker').setInputFiles({ name: 'latency.md', mimeType: 'text/markdown', buffer: Buffer.from('# Latency\n\n' + 'Reading before asking a question. '.repeat(30)) });
      await showLibrary(page); await page.locator('[data-document-id="latency.md"] .document-card').click();
      await page.evaluate(() => {
        const ask = window.__askUI; window.__warmCalls = 0;
        ask.speech.models.open = () => { window.__warmCalls++; return Promise.resolve([]); };
        ask.open();
      });
      await expect.poll(() => page.evaluate(() => window.__warmCalls)).toBe(1);
      report.warmsBeforeRecording = true;
      report.cancelledWarm = await page.evaluate(async () => {
        const ask = window.__askUI, start = window.__warmCalls;
        ask.close(); ask.open(); ask.close();
        await new Promise(r => setTimeout(r, 30)); return window.__warmCalls === start;
      });
      assert(report.cancelledWarm);
      report.pdfHasPriority = await page.evaluate(async () => {
        const ask = window.__askUI, original = ask.pdfProcessing, start = window.__warmCalls;
        ask.pdfProcessing = () => true; ask.open();
        await new Promise(r => setTimeout(r, 30)); ask.close(); ask.pdfProcessing = original;
        return window.__warmCalls === start;
      });
      assert(report.pdfHasPriority);
      report.remoteAndSuspended = await page.evaluate(async () => {
        const ask = window.__askUI, read = ask.speech.read, start = window.__warmCalls;
        ask.speech.read = () => 'remote'; ask.open(); await new Promise(r => setTimeout(r, 30)); ask.close();
        ask.speech.read = read; ask.speech.setup.suspended = true;
        ask.open(); await new Promise(r => setTimeout(r, 30)); ask.close(); ask.speech.setup.suspended = false;
        return window.__warmCalls === start;
      });
      assert(report.remoteAndSuspended);
      report.readingCancelsDownload = await page.evaluate(async () => {
        const speech = window.__askUI.speech, models = speech.models;
        let closed = false;
        speech.models = { entries: { 'fluid-mini': { state: 'downloading' } }, loading: new Promise(() => {}), close() { closed = true; } };
        try {
          return await Promise.race([speech.releaseForReading().then(() => closed), new Promise(resolve => setTimeout(() => resolve(false), 1000))]);
        } finally { speech.models = models; }
      });
      assert(report.readingCancelsDownload, 'opening a document must not wait for an unfinished model download');
      report.readingPreload = await page.evaluate(async () => {
        const speech = __askUI.speech, entry = speech.models.entries['fluid-mini'];
        const prior = entry.verified, read = speech.read, start = __warmCalls;
        entry.verified = true;
        try {
          speech.schedulePreload(() => false);
          await new Promise(r => setTimeout(r, 1600));
          if (__warmCalls !== start) throw Error('Preload ignored document preparation');
          speech.schedulePreload(); speech.cancelPreload();
          await new Promise(r => setTimeout(r, 1600));
          if (__warmCalls !== start) throw Error('Cancelled preload ran');
          speech.schedulePreload();
          await new Promise(r => setTimeout(r, 1600));
          if (__warmCalls !== start + 1) throw Error('Reader did not preload');
          speech.read = () => 'remote'; speech.schedulePreload();
          await new Promise(r => setTimeout(r, 1600));
          return __warmCalls === start + 1;
        } finally { entry.verified = prior; speech.read = read; speech.cancelPreload(); }
      });
      assert(report.readingPreload);
      report.immediateQueue = await page.evaluate(async () => {
        const ask = window.__askUI; ask.open(); ask.session.setStatus('listening');
        window.__displayDelay = 80;
        const observed = [];
        for (const text of ['First words', 'First words appear', 'First words appear immediately']) {
          const started = performance.now(); ask.stream.result({ text, words: [] });
          observed.push({ text, queued: window.__glasses.lastFrame.dialog?.text, ms: performance.now() - started });
        }
        await window.__glasses.queue.whenIdle(); return observed;
      });
      for (const r of report.immediateQueue) assert.equal(r.queued, r.text, 'queued synchronously before another timer tick');
      await expect.poll(() => page.evaluate(() => window.__boxes['review-text'])).toBe('First words appear immediately');
      assert.equal(await page.evaluate(() => window.__maxDisplay), 1, 'native calls remain serialized');
      report.finalReviewQueued = await page.evaluate(async () => {
        const ask = window.__askUI; ask.reviewSpeech('The final reviewed words.', { words: [] });
        const queued = window.__glasses.lastFrame.dialog?.text;
        await window.__glasses.queue.whenIdle(); return queued;
      });
      assert.equal(report.finalReviewQueued, 'The final reviewed words.');
      await expect.poll(() => page.evaluate(() => window.__boxes['review-text'])).toBe(report.finalReviewQueued);
      await page.locator('#preview').screenshot({ path: `${out}/${engine.name()}.png` });
      assert.deepEqual(report.errors, []); report.passed = true;
    } finally { await browser.close(); }
  }
} finally { await writeFile(`${out}/report.json`, JSON.stringify(reports, null, 2)); await vite.close(); }
console.log('PASS: Ask preloads voice, new words queue immediately, slow BLE stays serialized, latest and final text survive.');
