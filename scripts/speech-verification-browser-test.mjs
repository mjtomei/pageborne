// Real WASM inference, saved browser cache/receipts, fresh launches and workers.
// Native storage across changing localhost ports is covered by the startup test.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const manifest = [JSON.parse(await readFile('node_modules/@pageborne/browser-stt/vendor/stt/fluid-mini.json'))];
const files = manifest.flatMap(m => m.files.filter(f => f.url).map(f => ({ ...f, path: path.join(path.resolve(process.env.PAGEBORNE_TEST_MODEL_DIR || '.state/models'), m.directory, f.file) })));
let requests = 0;
const vite = await createServer({ clearScreen: false, server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'local-weights', configureServer(server) {
 server.middlewares.use((req, res, next) => { const f = files.find(f => req.url === `/__models/${f.sha256}`); if (!f) return next(); requests++; res.setHeader('Content-Length', f.bytes); createReadStream(f.path).pipe(res); });
} }] });
await vite.listen(); const results = [];
try {
 for (const name of ['chromium', 'webkit']) {
  const browser = await (name === 'webkit' ? webkit : chromium).launch({ executablePath: name === 'webkit' ? process.env.WEBKIT_PATH : '/usr/bin/google-chrome' });
  try {
   const context = await browser.newContext(); const page = await context.newPage();
   await context.route('**/__verification', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Speech check</title>' }));
   const runs = [];
   for (let run = 0; run < 2; run++) {
    await page.goto(new URL('/__verification', vite.resolvedUrls.local[0]).href);
    const before = requests;
    const result = await page.evaluate(async ({ lookup, run }) => {
     const { EnsembleSpeech, EnsembleModelStore } = await import('/node_modules/@pageborne/browser-stt/src/index.js');
     const store = new EnsembleModelStore({ fetch: input => fetch('/__models/' + lookup[input]) });
     const stages = []; const models = new EnsembleSpeech({ modelIds: ['fluid-mini'], store, verificationDevice: 'real-browser-fixture', changed: () => { for (const e of Object.values(models.entries)) if (e.setup.stage === 'checking' && !stages.includes(e.model.id)) stages.push(e.model.id); } });
     const restored = await models.restoreVerification();
     const unloaded = Object.values(models.entries).every(e => e.state === 'idle');
     const ready = await models.open(); if (ready.some(r => r.status !== 'fulfilled')) throw Error(JSON.stringify(ready.map(r => r.reason?.message)));
     const info = Object.values(models.entries).map(e => ({ id: e.model.id, verification: e.ready.verification }));
     const texts = [];
     if (run) {
      const wave = await (await fetch('/stt/ensemble-check.wav')).blob();
      for (const id of Object.keys(models.entries)) { const r = await models.transcribe(id, wave); texts.push({ id, text: r.text, confidences: r.words.every(w => Number.isFinite(w.confidence)) }); }
     }
     models.close(); return { restored, unloaded, stages, info, texts };
    }, { lookup: Object.fromEntries(files.map(f => [f.url, f.sha256])), run });
    assert.equal(result.restored, !!run); assert(result.unloaded);
    assert.equal(result.stages.length, run ? 0 : 1);
    assert(result.info.every(r => r.verification === (run ? 'saved' : 'tested')));
    if (run) { assert.equal(requests, before); assert.equal(result.texts.length, 1); assert(result.texts.every(r => /apostle|middle|gospel/i.test(r.text) && r.confidences)); }
    runs.push(result); console.log(name, run, JSON.stringify(result));
   }
   results.push({ engine: name, passed: true, actualInference: true, runs });
  } finally { await browser.close(); }
 }
} finally { await mkdir('test-results/speech-verification', { recursive: true }); await writeFile('test-results/speech-verification/results.json', JSON.stringify(results, null, 2)); await vite.close(); }
