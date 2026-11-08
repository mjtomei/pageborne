// Real app, native-storage adapter and checksum verification with small fixture
// weights. Worker setup is simulated; full inference has a separate test.
import { chromium, webkit, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { displayProbe } from './display-probe.mjs';
import { AtomicPhoneValue } from '../src/phone-storage.js';
const out = 'test-results/speech-startup'; await mkdir(out, { recursive: true });
const fixtures = ['conformer', 'zipformer', 'moonshine'].map((id, i) => {
  const bytes = Buffer.alloc(96001 + i, 73 + i);
  return { bytes, model: { id, name: ['Conformer CTC Small', 'Zipformer 20M', 'Moonshine Base'][i], files: [{ file: 'model.onnx', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: `https://models.example/${id}.onnx` }] } };
});
const servers = [], reports = [];
async function server() {
  const vite = await createServer({ cacheDir: '.state/vite-speech-startup', clearScreen: false,
    optimizeDeps: { entries: ['index.html'], exclude: ['@pageborne/browser-stt'] },
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    plugins: [displayProbe(), { name: 'small-setup-fixture', enforce: 'pre',
      transformIndexHtml: html => html.replace('<head>', '<head><meta name="pageborne-host" content="even">'),
      transform(code, id) { if (id.split('?')[0].endsWith('/ensemble-speech.js')) return code.replace(/import manifests from [^;]+;/, `const manifests = ${JSON.stringify(fixtures.map(f => f.model))};`); },
    }] });
  await vite.listen(); servers.push(vite); return vite.resolvedUrls.local[0];
}
try {
  const origins = [await server(), await server()];
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true, executablePath: engine === chromium ? '/usr/bin/google-chrome' : process.env.WEBKIT_PATH,
      ...(engine === chromium ? { args: ['--disable-gpu'] } : {}) });
    const storage = new Map(), report = { engine: engine.name(), passed: false, downloads: 0, errors: [] }; reports.push(report);
    const kv = { get: async key => storage.get(key) || '', set: async (key, value) => storage.set(key, value) };
    const savedReading = { updatedAt: 100, positions: { 'local\nkept.md': { percent: 42, sourceLine: 17 } },
      bookmarks: { 'local\nkept.md': [{ sourceLine: 8 }] },
      askSessions: { fixture: { sessionId: 'saved-session' } },
      askChats: { fixture: [{ id: 'saved-turn', question: 'Keep this question', answer: 'And this answer', state: 'complete' }] } };
    await new AtomicPhoneValue(kv, 'preferences').write(savedReading);
    let page, context;
    try {
      for (let run = 0; run < 4; run++) {
        context = await browser.newContext({ viewport: { width: 440, height: 806 }, userAgent: run === 3 ? 'changed-device' : 'same-device' });
        await context.route('https://huggingface.co/**', route => route.abort());
        await context.route('**/api/**', route => route.fulfill({ json: { provider: 'claude', state: 'idle', messages: [], history: [], sessions: [] }, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' } }));
        await context.exposeFunction('__storage', ({ method, data }) => {
          if (method === 'getLocalStorage') return storage.get(data.key) || '';
          storage.set(data.key, data.value); return true;
        });
        await context.route('https://models.example/**', route => {
          report.downloads++;
          if (run) return route.abort();
          const fixture = fixtures.find(f => f.model.files[0].url === route.request().url());
          return route.fulfill({ body: fixture.bytes, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/octet-stream' });
        });
        await context.addInitScript(() => {
          window.__boxes = {}; window.__prepared = []; window.__checked = []; window.__allFrames = []; window.__finishModel = null; window.__transcribed = [];
          window.__installBridge = () => {
            window.flutter_inappwebview = { async callHandler(_, payload) {
              const m = JSON.parse(payload);
              if (m.method.endsWith('LocalStorage')) return window.__storage(m);
              if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) window.__boxes = {};
              for (const box of m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || []) window.__boxes[box.containerName] = box;
              if (window.__boxes.body) window.__allFrames.push({ body: window.__boxes.body.content, blocked: window.__askUI?.speech.setup.blocked });
              return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
            } };
            window.dispatchEvent(new Event('flutterInAppWebViewPlatformReady'));
          };
          const NativeWorker = window.Worker;
          window.Worker = class {
            constructor(url, options) { if (!String(url).includes('ensemble-worker')) return new NativeWorker(url, options); this.serial = 0; this.pending = new Map(); }
            emit(data) { queueMicrotask(() => this.onmessage({ data })); }
            cache(action, extra = {}) { return new Promise((resolve, reject) => { const request = ++this.serial; this.pending.set(request, { resolve, reject }); this.emit({ cache: { request, action, ...extra } }); }); }
            async postMessage(data) {
              if (data.cacheReply) { const job = this.pending.get(data.request); this.pending.delete(data.request); if (data.error) job.reject(Error(data.error)); else job.resolve(data.value); return; }
              if (data.operation === 'transcribe') {
                window.__transcribed.push({ model: this.model, audioMs: (data.audio.byteLength - 44) / 32, vocabulary: data.vocabulary });
                const text = this.model === 'conformer' ? 'ask Fafnir now' : 'Ask fafner now.';
                const confidence = this.model === 'conformer' ? .8 : this.model === 'zipformer' ? .45 : .5;
                this.emit({ id: data.id, result: { text, words: [...text.matchAll(/\w+/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, confidence })), seconds: (data.audio.byteLength - 44) / 32000, transcribeMs: 1 } }); return;
              }
              if (data.operation !== 'prepare') return;
              this.model = data.model.id;
              try {
                const file = data.model.files[0];
                this.emit({ id: data.id, progress: { stage: 'loading', file: file.file, loadedBytes: 0 } });
                const handle = await this.cache('open', { file: file.file }); let loaded = 0;
                for (;;) { const next = await this.cache('read', { handle }); if (next.done) break; loaded += next.bytes.byteLength; }
                if (loaded !== file.bytes) throw Error('Wrong fixture byte count');
                if (!data.reuseVerification) { window.__checked.push(data.model.id); this.emit({ id: data.id, progress: { stage: 'checking', loadedBytes: loaded } }); }
                window.__prepared.push(data.model.id);
                if (data.reuseVerification && window.__delayPreparation) await new Promise(resolve => setTimeout(resolve, window.__delayPreparation));
                if (data.model.id === 'moonshine' && !data.reuseVerification) await new Promise((resolve, reject) => { window.__finishModel = fail => { window.__finishModel = null; fail ? reject(Error('Injected setup failure')) : resolve(); }; });
                this.emit({ id: data.id, result: { backend: 'wasm', verified: true } });
              } catch (error) { this.emit({ id: data.id, error: error.message }); }
            }
            terminate() {}
          };
        });
        page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
        await page.goto(origins[Math.min(run, 1)]); await expect(page.locator('#speech-setup')).not.toBeVisible();
        // No host at script evaluation or for the first second of initialization.
        await page.waitForTimeout(1100);
        assert.equal(report.downloads, run ? 3 : 0); assert.equal(await page.evaluate(() => __prepared.length), 0);
        await page.evaluate(() => __installBridge());
        if (run === 0 || run === 3) {
        await expect.poll(() => page.evaluate(() => __boxes.body?.content)).toContain('Preparing voice models');
        await expect.poll(() => page.evaluate(() => __finishModel !== null)).toBe(true);
        await expect.poll(() => page.evaluate(() => __boxes.body?.content)).toContain('Checking transcription');
        if (run === 3) {
          await expect(page.locator('#speech-setup-help')).toContainText('Using saved files. Downloaded this run: 0 MB.');
          await expect(page.locator('[data-model=moonshine] [data-stage=download]')).toHaveText('Saved on phone');
          await expect(page.locator('#speech-setup')).not.toContainText('Downloading');
        } else {
          await expect(page.locator('#speech-setup-help')).toContainText('Downloaded this run: 0.1 MB.');
        }
        await expect(page.locator('#import')).toBeDisabled();
        // An update uses a fresh browser origin, but retains native preferences.
        // Backgrounding during the model gate must not make empty defaults newer
        // than the saved positions and conversations waiting to be restored.
        await page.evaluate(() => {
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.locator('#speech-setup').screenshot({ path: `${out}/${engine.name()}-${['first', 'update', 'reopen', 'changed-device'][run]}-setup.png` });
        if (!run) {
          await page.evaluate(() => __finishModel(true));
          await expect(page.locator('#speech-setup-retry')).toBeVisible();
          await page.locator('#speech-setup-retry').click();
          await expect.poll(() => page.evaluate(() => __finishModel !== null)).toBe(true);
        }
        await page.evaluate(() => __finishModel(false));
        }
        await expect(page.locator('#import')).toBeEnabled({ timeout: 30000 });
        const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('even-reader:preferences:v1')));
        for (const key of ['positions', 'bookmarks', 'askSessions', 'askChats']) assert.deepEqual(restored[key], savedReading[key], `${key} survived backgrounding during setup`);
        await expect.poll(async () => (await new AtomicPhoneValue(kv, 'preferences').read()).positions).toEqual(savedReading.positions);
        await expect.poll(() => page.evaluate(() => __boxes.body?.content)).toContain('Librarian');
        assert.equal(report.downloads, 3);
        const info = await page.evaluate(() => ({ kind: __askUI.speech.models.store.storageKind, ...__askUI.speech.models.store.stats }));
        assert.equal(info.kind, 'phone'); if (run) { assert.equal(info.networkRequests, 0); assert.equal(info.downloadedBytes, 0); assert.equal(info.receivedBytes, 0); }
        if (run === 1 || run === 2) {
          assert.equal(await page.evaluate(() => __prepared.length), 0, 'Restart/update creates no speech workers');
          await page.evaluate(() => __askUI.speech.open());
          await expect.poll(() => page.evaluate(() => __prepared.length)).toBe(3);
          assert.equal(await page.evaluate(() => __checked.length), 0, 'First voice loads without retesting');
          if (run === 2) {
            await page.locator('#library-librarian').click();
            await page.evaluate(async () => {
              const ui = __askUI; await ui.speech.releaseForReading();
              window.__delayPreparation = 200;
              ui.speech.readVocabulary = () => 'Fafnir'; await ui.hold('glasses');
              const pcm = new Uint8Array(8000); new Int16Array(pcm.buffer).fill(2000);
              window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: pcm, source: 'glasses' } } }));
            });
            await page.waitForTimeout(60);
            await page.evaluate(() => {
              const pcm = new Uint8Array(16000); new Int16Array(pcm.buffer).fill(2000);
              window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { audioEvent: { audioPcm: pcm, source: 'glasses' } } }));
            });
            await expect(page.locator('#ask-question')).toHaveValue('Ask Fafnir now.');
            await expect.poll(() => page.evaluate(() => __reviewText)).toBe('Ask Fafnir now.');
            const transcribed = await page.evaluate(() => __transcribed);
            assert.equal(transcribed.length, 3);
            assert(transcribed.every(call => call.audioMs === 750 && call.vocabulary.includes('Fafnir')));
            await page.evaluate(() => __askUI.release());
            await expect(page.locator('#ask-review-cancel')).toBeVisible();
            await expect(page.locator('#ask-question')).toHaveValue('Ask Fafnir now.');
            const timings = await page.evaluate(() => __askUI.diagnostics.events.filter(e => e.type === 'voice-startup'));
            assert(timings.some(e => e.stage === 'first-audio') && timings.some(e => e.stage === 'first-word'), JSON.stringify(timings));
            await page.locator('#ask-review-cancel').click();
            report.dictation = { coldAudioMs: 750, dictionaryVoteReachesPhoneAndGlasses: true, reviewAndCancel: true, timings };
          }
        } else assert.equal((await page.evaluate(() => [...new Set(__checked)])).length, 3);
        info.verificationReused = run === 1 || run === 2;
        assert(!(await page.evaluate(() => __allFrames)).some(frame => frame.blocked && frame.body === 'Opening your saved library…'), 'native startup identifies the voice gate while it blocks the library');
        report[['first', 'updated', 'reopened', 'changedDevice'][run]] = info;
        // A context teardown skips the host's visibility checkpoint. Persist
        // the completed cold preparation before simulating the next launch.
        await page.evaluate(() => __askUI.diagnostics.flushCheckpoint?.());
        await context.close();
      }
      assert.deepEqual(report.errors, []); report.passed = true;
    } catch (error) { report.error = error.stack; report.state = await page?.evaluate(() => ({ setup: document.querySelector('#speech-setup').innerText, prepared: __prepared, frame: __boxes.body?.content })); await page?.screenshot({ path: `${out}/${engine.name()}-failure.png` }).catch(() => {}); throw error; }
    finally { await browser.close(); }
  }
} finally { await Promise.all(servers.map(s => s.close())); await writeFile(`${out}/results.json`, JSON.stringify(reports, null, 2)); }
console.log(JSON.stringify(reports));
