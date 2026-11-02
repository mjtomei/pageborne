import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, writeFile, mkdir, rename, unlink, readdir, lstat, realpath, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { chromium } from '@playwright/test';
import { libraryManifest, librarySnapshotBytes, libraryOriginal, libraryOcrDirectory, preparationRequest } from '../../integrations/even-terminal/pageborne-library.js';
import { PDF_DEFAULTS } from '../../src/pdf-settings.js';
import { attachCheckpointNavigation } from './navigation.mjs';
import { attachCheckpointReflowSanity } from './reflow-audit.mjs';
import { ocrEngineIdentity } from './identity.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function directory(folder) {
  await mkdir(folder, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const info = await lstat(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder) !== folder) throw new Error('Unsafe OCR directory');
  return folder;
}
async function json(file, maxBytes = 16*1024*1024) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('Invalid OCR artifact');
    return JSON.parse(await handle.readFile('utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}
async function atomic(file, value, maxBytes = 16*1024*1024) {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > maxBytes) throw new Error('OCR metadata exceeds its size limit');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
    const parent = await open(path.dirname(file), 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  }
  finally { await unlink(temporary).catch(() => {}); }
}
export async function memoryState() {
  const info = Object.fromEntries((await readFile('/proc/meminfo', 'utf8')).trim().split('\n').map(line => {
    const [key, value] = line.split(':'); return [key, Number(value.trim().split(/\s/)[0])*1024];
  }));
  return { used: 1-info.MemAvailable/info.MemTotal, free: info.MemFree, total: info.MemTotal };
}

export class Engine {
  constructor(config, configFile, { spawnProcess = spawn, startupTimeoutMs = 90_000, inferenceTimeoutMs = 360_000 } = {}) {
    this.config = config; this.configFile = configFile; this.pending = [];
    this.spawnProcess = spawnProcess; this.startupTimeoutMs = startupTimeoutMs; this.inferenceTimeoutMs = inferenceTimeoutMs;
  }
  async start() {
    if (this.failed) throw this.failed;
    if (this.child) return this.ready;
    this.ready = new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    const child = this.child = this.spawnProcess(this.config.python, [path.join(here, 'guard.py'),
      '--samples', path.join(this.config.telemetryDir, `memory-${Date.now()}.jsonl`), '--', this.config.python,
      path.join(here, 'engine.py'), this.configFile], { stdio: ['pipe', 'pipe', 'inherit'] });
    const failure = error => {
      if (this.child !== child || this.stoppingChild === child || this.failed) return;
      this.failed = error;
      for (const item of this.pending.splice(0)) item.reject(error);
      child.kill('SIGTERM');
    };
    this.fail = failure;
    child.on('error', failure);
    child.stdin.on('error', failure);
    child.on('exit', code => {
      failure(new Error(`OCR engine stopped (${code}); restart required`));
    });
    child.on('close', () => { if (this.child === child) this.child = null; });
    createInterface({ input: child.stdout }).on('line', line => {
      try { const value = JSON.parse(line); this.pending.shift()?.resolve(value); }
      catch (error) { failure(error); }
    });
    const timer = setTimeout(() => failure(new Error('OCR model startup timed out')), this.startupTimeoutMs);
    try {
      const ready = await this.ready;
      if (ready.ready !== true) { failure(new Error('Invalid OCR startup response')); throw this.failed; }
      return ready;
    } finally { clearTimeout(timer); }
  }
  async infer(items) {
    await this.start();
    const response = new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    this.child.stdin.write(JSON.stringify({ items })+'\n');
    const fail = this.fail;
    const timer = setTimeout(() => fail(new Error('OCR batch timed out; restart required')), this.inferenceTimeoutMs);
    try {
      const result = await response;
      if (!Array.isArray(result.items) || result.items.length !== items.length
          || new Set(result.items.map(item => item.number)).size !== items.length
          || result.items.some(item => !items.some(input => input.number === item.number)
            || typeof item.markdown !== 'string' || !Array.isArray(item.extracted?.text))) {
        this.failed = new Error('Incomplete OCR batch; no pages committed');
        await this.stop(); throw this.failed;
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  async stop() {
    const child = this.child; if (!child) return;
    const exited = new Promise(resolve => child.once('close', resolve));
    this.stoppingChild = child;
    for (const item of this.pending.splice(0)) item.reject(this.failed || new Error('OCR engine stopped intentionally'));
    child.kill('SIGTERM'); await exited;
  }
}

export async function runDaemon(configFile, { once = false, engineFactory = (config, file) => new Engine(config, file), readMemory = memoryState,
  dist = path.resolve(here, '../../dist-ocr') } = {}) {
  const config = await json(configFile);
  if (!config?.python || !config?.modelPath || !/^[a-f0-9]{64}$/.test(config.weightsSha256 || '')) throw new Error('Set python, modelPath and weightsSha256 in the private OCR config');
  // Larger groups regressed throughput and were implicated in GB10 freezes.
  const batchSize = Math.max(1, Math.min(4, Math.trunc(config.batchSize || 1)));
  const options = { libraryDir: config.libraryDir };
  const root = await libraryOcrDirectory(options), requests = await directory(path.join(root, 'requests'));
  config.telemetryDir = await directory(path.join(root, 'telemetry'));
  const logs = (await readdir(config.telemetryDir)).filter(name => /^memory-\d+\.jsonl(?:\.previous)?$/.test(name)).sort().reverse();
  for (const name of logs.slice(16)) await unlink(path.join(config.telemetryDir, name));
  // Verify actual weights once; changing weights/runtime/preparation code gets
  // a different artifact namespace, never silently reuses old recognition.
  const weights = createHash('sha256');
  const file = await open(path.join(config.modelPath, 'model.safetensors'), 'r');
  try { for await (const chunk of file.createReadStream()) weights.update(chunk); } finally { await file.close().catch(() => {}); }
  if (weights.digest('hex') !== config.weightsSha256) throw new Error('Xiaomi checkpoint checksum mismatch');
  const engineId = await ocrEngineIdentity(config, dist);
  const folder = await directory(path.join(root, engineId));
  const prepared = await directory(path.join(folder, 'prepared'));
  const pages = await directory(path.join(folder, 'pages'));
  const failures = await directory(path.join(folder, 'failures'));
  const temporary = await directory(path.join(folder, 'temporary'));
  for (const name of await readdir(temporary)) if (/^[a-f0-9-]+\.png$/.test(name)) await unlink(path.join(temporary, name));
  const engine = engineFactory(config, configFile);
  const server = express().use(express.static(dist, { dotfiles: 'deny' })).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let browser, tab, state, heartbeat, monitor, stopping = false, pressureStop = false;
  async function saveState(update = {}) {
    state = { ...state, engine: engineId, heartbeat: Date.now(), batchSize, ...update };
    await atomic(path.join(root, 'daemon.json'), state);
  }
  async function stop() { stopping = true; await Promise.allSettled([engine.stop(), browser?.close()]); }
  const shutdown = () => void stop();
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try {
    browser = await chromium.launch({ headless: true, ...(config.chromePath ? { executablePath: config.chromePath } : {}),
      args: ['--disable-dev-shm-usage', '--disable-gpu'] });
    const newTab = async () => {
      tab = await browser.newPage();
      await tab.goto(`http://127.0.0.1:${server.address().port}`);
      await tab.waitForFunction(() => window.prepareDesktopPdf);
    };
    await newTab();
    const info = await tab.evaluate(() => window.desktopPdfInfo);
    await saveState({ phase: 'idle', pdfjs: info.version, preparationVersion: info.preparationVersion });
    heartbeat = setInterval(() => void saveState().catch(console.error), 15_000);
    // Separate from the Python token loop, also covers browser layout work.
    monitor = setInterval(() => void readMemory().then(m => {
      if (!stopping && (m.used >= .76 || m.free < 12*1024**3)) { pressureStop = true; void stop(); }
    }).catch(() => { pressureStop = true; void stop(); }), 250);
    do {
      const memory = await readMemory();
      if (memory.used > .70 || memory.free < 22*1024**3) {
        await saveState({ phase: 'waiting-for-memory' });
        if (once) break;
        await sleep(30_000); continue;
      }
      const manifest = await libraryManifest({}, options);
      const jobs = [];
      for (const name of await readdir(requests)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        try {
          const request = await json(path.join(requests, name));
          const parsed = preparationRequest(request.key);
          const doc = manifest.files.find(f => f.name === request.name && f.sha256 === parsed.sha256);
          if (doc && parsed.version === info.preparationVersion && parsed.pdfjs === info.version && parsed.settings.reflow) jobs.push({ ...request, doc });
          else await unlink(path.join(requests, name));
        } catch { await unlink(path.join(requests, name)); }
      }
      const documents = manifest.files.filter(f => /\.pdf$/i.test(f.name))
        .sort((a, b) => Number(config.priority?.includes(b.name)) - Number(config.priority?.includes(a.name)) || b.addedAt-a.addedAt);
      for (const doc of documents) jobs.push({ doc, name: doc.name,
        key: JSON.stringify([info.preparationVersion, info.version, doc.sha256, PDF_DEFAULTS]) });
      let worked = false;
      for (const job of jobs) {
        if (stopping) break;
        const id = digest(job.key), outputFile = path.join(prepared, id+'.json');
        const existing = await json(outputFile, Infinity);
        if (existing) {
          const readPage = number => json(path.join(pages, job.doc.sha256, number+'.json'));
          const navigationChanged = await attachCheckpointNavigation(existing.saved, readPage, () => !stopping);
          const sanityChanged = !stopping && await attachCheckpointReflowSanity(existing.saved, readPage,
            { current: () => !stopping, reflow: preparationRequest(job.key).settings.reflow });
          if (navigationChanged || sanityChanged) await atomic(outputFile, existing, Infinity);
          if (sanityChanged) console.log(JSON.stringify({ event: 'pdf-reflow-check', name: job.name, ...existing.saved.layout.reflowSanity }));
          await unlink(path.join(requests, id+'.json')).catch(() => {}); continue;
        }
        const failed = await json(path.join(failures, id+'.json'));
        if (failed?.retryAt > Date.now()) continue;
        if ((await readMemory()).used > .70) break;
        worked = true;
        await saveState({ phase: 'preparing', document: job.name, page: 0 });
        const pageFolder = await directory(path.join(pages, job.doc.sha256));
        const original = { name: job.name, sha256: job.doc.sha256, id: manifest.id, snapshot: true };
        try {
          const bytes = await librarySnapshotBytes(original, options);
          await tab.exposeFunction('desktopProgress', progress => saveState(progress));
          await tab.exposeFunction('desktopPageRead', async number => {
            const checkpoint = path.join(pageFolder, number+'.json');
            try {
              const saved = await json(checkpoint);
              if (!saved || (saved.number === number && Array.isArray(saved.extracted?.text))) return saved;
            } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
            await unlink(checkpoint); return null;
          });
          await tab.exposeFunction('desktopPageBatch', async items => {
            await libraryOriginal(original, options); // Detect edits/deletions between batches.
            const staged = [];
            try {
              for (const item of items) if (item.png) {
                const image = path.join(temporary, randomUUID()+'.png');
                await writeFile(image, Buffer.from(item.png, 'base64'), { flag: 'wx', mode: 0o600 });
                staged.push({ number: item.number, image, extracted: item.extracted, turn: item.turn });
              }
              const inferred = staged.length ? (await engine.infer(staged)).items : [];
              const results = items.map(item => inferred.find(p => p.number === item.number)
                || { number: item.number, turn: item.turn, extracted: item.extracted });
              await libraryOriginal(original, options);
              for (const result of results) await atomic(path.join(pageFolder, result.number+'.json'), result);
              return results;
            } finally { for (const item of staged) await unlink(item.image).catch(() => {}); }
          });
          const result = await tab.evaluate(arg => window.prepareDesktopPdf(arg), {
            content: bytes.toString('base64'), settings: preparationRequest(job.key).settings, batchSize,
          });
          if (result.key !== job.key) throw new Error('Preparation identity mismatch');
          await libraryOriginal(original, options);
          await attachCheckpointNavigation(result.saved, number => json(path.join(pageFolder, number+'.json')), () => !stopping);
          await attachCheckpointReflowSanity(result.saved, number => json(path.join(pageFolder, number+'.json')),
            { current: () => !stopping, reflow: preparationRequest(job.key).settings.reflow });
          console.log(JSON.stringify({ event: 'pdf-reflow-check', name: job.name, ...result.saved.layout.reflowSanity }));
          // Completed books are not bounded by a transport budget. Network and
          // phone storage use chunks; retain the separate small-metadata guards.
          await atomic(outputFile, { key: job.key, engine: engineId, saved: result.saved, warnings: result.warnings }, Infinity);
          await unlink(path.join(requests, id+'.json')).catch(() => {});
          await unlink(path.join(failures, id+'.json')).catch(() => {});
          await saveState({ phase: 'ready', document: job.name });
          console.log(JSON.stringify({ event: 'pdf-ready', name: job.name, blocks: result.saved.layout.blocks.length }));
        } catch (error) {
          await atomic(path.join(failures, id+'.json'), { retryAt: Date.now()+600_000, error: String(error.message).slice(0, 500) });
          console.error('PDF preparation deferred:', job.name, error.message);
          // A failed CUDA process is not automatically relaunched for each PDF.
          // Preserve checkpoints and require an explicit service restart.
          if (engine.failed) { stopping = true; throw engine.failed; }
          await engine.stop();
        } finally { await tab.close().catch(() => {}); if (!stopping) await newTab(); }
      }
      if (once || stopping) break;
      await saveState({ phase: worked ? 'idle' : 'waiting' });
      await sleep(30_000);
    } while (!stopping);
  } finally {
    clearInterval(heartbeat); clearInterval(monitor);
    await stop(); server.close();
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    await saveState({ phase: pressureStop ? 'paused-memory' : 'stopped', heartbeat: 0 });
  }
  if (pressureStop) throw new Error('OCR paused by memory watchdog');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = process.argv[2];
  if (!config) throw new Error('Usage: node desktop/ocr/daemon.mjs /path/to/private-config.json [--once]');
  runDaemon(path.resolve(config), { once: process.argv.includes('--once') }).catch(error => { console.error(error); process.exitCode = 1; });
}
