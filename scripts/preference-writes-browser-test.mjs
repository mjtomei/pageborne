// Real native preference/checkpoint storage, bridge diagnostics and library
// sync, with durable host storage shared across fresh WebView origins.
import { chromium, webkit } from '@playwright/test';
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const out = 'test-results/preference-writes'; await mkdir(out, { recursive: true });
const servers = [], reports = [];
async function startServer() {
  const server = await createServer({ cacheDir: '.state/vite-preference-writes', clearScreen: false,
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [{ name: 'storage-page', configureServer(vite) {
      vite.middlewares.use('/preference-fixture', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Preference persistence fixture</title>'); });
    } }] });
  await server.listen(); servers.push(server); return server.resolvedUrls.local[0];
}
try {
  const origins = [await startServer(), await startServer()];
  for (const engine of process.env.PREFERENCES_BROWSER === 'chromium' ? [chromium] : [chromium, webkit]) {
    const browser = await engine.launch({ headless: true,
      executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH,
      ...(engine === chromium ? { args: ['--disable-gpu'] } : {}) });
    const values = new Map(), writes = [], errors = [];
    const report = { engine: engine.name(), passed: false, runs: [], errors }; reports.push(report);
    try {
      let previousAt = 100;
      for (let run = 0; run < 2; run++) {
        const context = await browser.newContext();
        await context.exposeFunction('__phoneGet', key => values.get(key) || '');
        await context.exposeFunction('__phoneSet', (key, value) => { values.set(key, value); writes.push({ key, characters: value.length }); return true; });
        const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
        await page.goto(origins[run] + 'preference-fixture');
        const setup = await page.evaluate(async run => {
          const { PhoneLibrary, PhonePreferences, AtomicPhoneValue, bridgeStorage } = await import('/src/phone-storage.js');
          const { BridgeLane, Diagnostics } = await import('/src/diagnostics.js');
          const diagnostics = new Diagnostics(localStorage), bridge = { getLocalStorage: __phoneGet, setLocalStorage: __phoneSet };
          const kv = bridgeStorage(bridge, new BridgeLane(diagnostics));
          const endpoint = 'https://desktop.example', id = 'fixture-library';
          const remote = { version: 1, id, directory: '/fixture/library', skipped: [],
            files: [{ name: 'scan.pdf', sha256: 'a'.repeat(64), bytes: 1024 }] };
          const store = new PhoneLibrary(kv, { lazy: true, onDemand: true }); await store.read();
          if (!run) {
            await store.putRemote(remote.files[0], { endpoint, libraryId: id });
            await new AtomicPhoneValue(kv, 'preferences').write({ updatedAt: 100,
              positions: { book: { percent: 40 } }, askChats: { book: [{ answer: 'x'.repeat(700000) }] },
              librarySync: { [endpoint]: { id, directory: remote.directory, files: { 'scan.pdf': remote.files[0].sha256 }, at: 100 } } });
          }
          const failures = [], preferences = new PhonePreferences(kv, error => failures.push(error.message));
          const value = await preferences.read({});
          window.fixture = { diagnostics, kv, store, preferences, value, remote, endpoint, failures };
          return { restoredAt: value.librarySync[endpoint].at, chatUnchanged: value.askChats.book[0].answer === 'x'.repeat(700000), percent: value.positions.book.percent };
        }, run);
        assert.equal(setup.restoredAt, previousAt); assert(setup.chatUnchanged); assert.equal(setup.percent, 40);
        writes.length = 0;
        const synced = await page.evaluate(async () => {
          const { syncLibrary } = await import('/src/library-sync.js');
          const f = fixture; const apiCalls = [];
          f.diagnostics.log('voice-startup', { stage: 'first-word', ms: 100 });
          const result = await syncLibrary({ store: f.store, snapshot: f.store.snapshot, saved: f.value.librarySync[f.endpoint],
            client: { config: { endpoint: f.endpoint }, async api(route) {
              apiCalls.push(route); if (route !== 'pageborne/library') throw Error('Unexpected transfer or deletion'); return f.remote;
            } }, saveState: async state => {
              f.value.librarySync[f.endpoint] = state;
              f.value.updatedAt = Math.max(Date.now(), f.value.updatedAt + 1);
              f.preferences.schedule(f.value); await f.preferences.flush();
            } });
          return { at: f.value.librarySync[f.endpoint].at, failures: f.failures, uploaded: result.uploaded,
            deleted: result.deleted, apiCalls, eventCount: f.diagnostics.events.length,
            speechEventKept: f.diagnostics.events.some(e => e.type === 'voice-startup'), storageTraffic: f.diagnostics.summary().storageTraffic };
        });
        const preferenceWrites = writes.filter(w => /:(preferences|reading-position)(:|$)/.test(w.key));
        const characters = preferenceWrites.reduce((n, w) => n + w.characters, 0);
        assert(synced.at > previousAt); previousAt = synced.at;
        assert(preferenceWrites.length > 0 && preferenceWrites.every(w => w.key.includes(':reading-position')));
        assert(characters < 1500, `metadata-only sync wrote ${characters} characters`);
        assert.equal(synced.uploaded, 0); assert.equal(synced.deleted, 0); assert.deepEqual(synced.apiCalls, ['pageborne/library']);
        assert(synced.speechEventKept); assert(synced.eventCount < 30); assert.deepEqual(synced.failures, []);
        report.runs.push({ freshOrigin: !!run, restored: setup, sync: synced, nativePreferenceWrites: preferenceWrites.length, nativePreferenceCharacters: characters });
        await context.close();
      }
      assert.deepEqual(errors, []); report.passed = true;
    } finally { await browser.close(); }
  }
} finally { await writeFile(`${out}/report.json`, JSON.stringify(reports, null, 2)); await Promise.all(servers.map(s => s.close())); }
console.log(JSON.stringify(reports));
