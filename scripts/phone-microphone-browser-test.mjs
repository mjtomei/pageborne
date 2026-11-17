// Real phone hold controls and Even SDK; native audio and recognition are fixtures.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://phone-mic.test';
const out = 'test-results/phone-microphone'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'debug', plugins: [displayProbe(), { name: 'phone-mic-fixture', transform(code, id) {
  if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
} }], optimizeDeps: { entries: ['index.html'] }, cacheDir: '.state/vite-phone-mic', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
  args: ['--disable-gpu', '--js-flags=--max-old-space-size=384'] });
const page = await browser.newPage({ viewport: { width: 440, height: 806 } });
const report = { errors: [], passed: false, physicalPhone: false };
page.on('pageerror', error => report.errors.push(error.message));
try {
  await page.addInitScript(() => {
    localStorage.setItem('even-reader:preferences:v1', JSON.stringify({ ask: { mode: 'terminal', endpoint: 'https://phone-mic.test', token: 'fixture', agent: 'codex' } }));
    window.__browserMicCalls = 0; window.__audioCalls = []; window.__storage = new Map();
    navigator.mediaDevices.getUserMedia = async () => { window.__browserMicCalls++; throw new DOMException('Permission denied', 'NotAllowedError'); };
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const { method, data } = JSON.parse(payload);
      if (method === 'getLocalStorage') return window.__storage.get(data.key) || '';
      if (method === 'setLocalStorage') { window.__storage.set(data.key, data.value); return true; }
      if (method === 'audioControl') {
        window.__audioCalls.push(data);
        if (data.isOpen && window.__delayStart) await new Promise(resolve => { window.__resolveStart = resolve; });
        if (data.isOpen && window.__rejectStart) return false;
      }
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(method) ? 0 : true;
    } };
  });
  await page.route('https://phone-mic.test/**', route => route.fulfill({ json: {}, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.goto(vite.resolvedUrls.local[0]);
  await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
  await page.locator('#file-picker').setInputFiles({ name: 'phone-mic.md', mimeType: 'text/markdown', buffer: Buffer.from('# Phone microphone\n\n' + 'A paragraph for testing speech from the reading screen. '.repeat(20)) });
  await showLibrary(page); await page.locator('[data-document-id="phone-mic.md"] .document-card').click();
  await page.evaluate(() => {
    const ask = window.__askUI;
    ask.speech.open = () => {}; ask.speech.vocabulary = () => []; ask.speech.filenames = () => [];
    ask.stream = { start(){ window.__bytes = 0; }, receive(bytes){ window.__bytes += bytes.length; }, cancel(){}, finish: async () => ({ text: 'Question from the phone microphone.' }) };
    // Capture bookkeeping fixture: check failed input cannot become a typed submission.
    ask.recordings.configure = () => {};
    ask.recordings.start = () => window.__recording = { bytes: 0 };
    ask.recordings.hints = () => {}; ask.recordings.receive = bytes => { window.__recording.bytes += bytes.length; };
    ask.recordings.stop = () => {}; ask.recordings.recognition = () => {};
    ask.recordings.cancel = r => { if (r) r.cancelled = true; };
  });
  const state = () => page.evaluate(() => window.__askUI.session.status);
  const calls = () => page.evaluate(() => window.__audioCalls);
  const hold = async () => { await expect(page.locator('#preview-speak')).toBeEnabled(); await page.locator('#preview-speak').hover(); await page.mouse.down(); };
  const audio = source => page.evaluate(source => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { source, audioPcm: new Uint8Array(6400).fill(1) } } })), source);
  const back = () => page.evaluate(() => { window.__askUI.cancelReview(); window.__askUI.returnToReading(); });
  await hold();
  await expect.poll(state).toBe('listening');
  assert.equal((await calls()).at(-1).source, 'phone');
  assert.equal(await page.evaluate(() => window.__browserMicCalls), 0);
  await audio('glasses'); assert.equal(await page.evaluate(() => window.__bytes), 0, 'wrong-source audio ignored');
  await audio('phone'); assert.equal(await page.evaluate(() => window.__bytes), 6400);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__askUI.session.review?.text)).toBe('Question from the phone microphone.');
  assert.equal((await calls()).at(-1).isOpen, false);
  report.nativePhoneHoldRelease = true;

  // Native phone capture remains available in WebViews without browser audio APIs.
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = undefined; window.AudioWorkletNode = undefined; window.__askUI.changed(); });
  await expect(page.locator('#preview-speak')).toBeVisible();
  report.noBrowserAudioRequired = true;

  await back(); await page.evaluate(() => { window.__delayStart = true; });
  await hold(); await expect.poll(() => page.evaluate(() => typeof window.__resolveStart)).toBe('function');
  await page.mouse.up();
  await page.evaluate(() => { window.__delayStart = false; window.__resolveStart(); });
  await expect.poll(() => page.evaluate(() => !window.__askUI.phoneMic.pending && !window.__askUI.phoneMic.stopping && !window.__askUI.phoneMic.capturing)).toBe(true);
  assert.equal((await calls()).at(-1).isOpen, false);
  report.releaseDuringStartup = true;

  await back(); await hold(); await expect.poll(state).toBe('listening');
  await page.locator('#preview-speak').dispatchEvent('pointercancel', { pointerId: 1 }); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__askUI.phoneMic.capturing)).toBe(false);
  await expect.poll(async () => (await calls()).at(-1).isOpen).toBe(false);
  report.cancelStopsPhone = true;

  await back(); await page.evaluate(() => { window.__rejectStart = true; });
  await hold(); await expect.poll(state).toBe('error'); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__recording.cancelled)).toBe(true);
  assert.equal(await page.evaluate(() => window.__askUI.voiceRecording), null);
  assert.match(await page.evaluate(() => window.__askUI.session.error), /microphone/i);
  assert.equal(await page.evaluate(() => window.__askUI.diagnostics.errors.at(-1)?.type), 'microphone-start-error');
  await page.locator('#ask-question').fill('Typing still works after a microphone failure.');
  await expect(page.locator('#ask-send')).toBeEnabled();
  report.failureLeavesTypingAndRetry = true;

  await back(); await page.evaluate(() => { window.__rejectStart = false; });
  await hold(); await expect.poll(state).toBe('listening'); await audio('phone'); await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__askUI.session.review?.text)).toBe('Question from the phone microphone.');

  await back();
  await page.evaluate(() => { void window.__askUI.hold('glasses'); });
  await expect.poll(state).toBe('listening');
  assert.equal((await calls()).at(-1).source, 'glasses');
  await audio('phone'); assert.equal(await page.evaluate(() => window.__bytes), 0);
  await audio('glasses'); assert.equal(await page.evaluate(() => window.__bytes), 6400);
  await page.evaluate(() => window.__askUI.release());
  report.glassesSourcePreserved = true;
  assert.equal(await page.evaluate(() => window.__browserMicCalls), 0);
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  if (!report.passed) report.ui = await page.evaluate(() => { const b = document.getElementById('preview-speak'), r = b.getBoundingClientRect(), a = window.__askUI; return { button: {hidden:b.hidden, disabled:b.disabled, rect:r.toJSON()}, hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,250), status:a.session.status, active:a.session.active, error:a.session.error, browserCalls:window.__browserMicCalls }; });
  await page.screenshot({path: `${out}/screen.png`});
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close(); await vite.close();
}
console.log(JSON.stringify(report));
