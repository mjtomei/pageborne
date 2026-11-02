import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

const queues = new Map();
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const fail = () => { throw Object.assign(new Error('Invalid reading history.'), { status: 400 }); };
const text = (v, max) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const revision = entries => createHash('sha256').update(JSON.stringify(entries)).digest('hex');
function validDay(day) { const date = new Date(`${day}T00:00:00Z`); return dayPattern.test(day) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day; }
export function validateReadingEntry(e, day, scope) {
  if (!e || !text(e.id, 100) || !e.id || e.day !== day || e.scope !== scope
    || !Number.isFinite(Date.parse(e.at)) || !Number.isFinite(Date.parse(e.endedAt))
    || !Number.isFinite(e.words) || e.words <= 0 || e.words > 20000
    || !Number.isFinite(e.seconds) || e.seconds <= 0 || e.seconds > 3600
    || !['glasses', 'web', 'preview'].includes(e.platform)
    || !text(e.document?.id, 220) || !text(e.document.key, 1000) || !text(e.document.title, 300)
    || e.document.revision != null && !text(e.document.revision, 200)
    || !Number.isFinite(e.position) || e.position < 0 || e.position > 100
    || e.page != null && (!Number.isInteger(e.page) || e.page < 1 || e.page > 100000)
    || !text(e.excerpt, 240) || !Array.isArray(e.sessions) || e.sessions.length > 100
    || e.sessions.some(s => !['claude', 'codex'].includes(s.agent) || !text(s.id, 300) || !s.id || s.cwd != null && !text(s.cwd, 4000))) fail();
  return { id: e.id, day, at: e.at, endedAt: e.endedAt, words: e.words, seconds: e.seconds, platform: e.platform,
    scope, document: { id: e.document.id, key: e.document.key, title: e.document.title, ...(e.document.revision ? { revision: e.document.revision } : {}) },
    position: e.position, ...(e.page ? { page: e.page } : {}), excerpt: e.excerpt,
    sessions: e.sessions.map(s => ({ agent: s.agent, id: s.id, ...(s.cwd ? { cwd: s.cwd } : {}) })) };
}
export function createReadingActivity({ identity, libraryDir = process.env.PAGEBORNE_LIBRARY_DIR || path.join(homedir(), '.pageborne/library') }) {
  let locating; const summaries = new Map();
  function location() { return locating ||= locate().catch(error => { locating = null; throw error; }); }
  async function locate() {
    const { instanceId, libraryId } = await identity();
    const root = libraryDir.startsWith('~/') ? path.join(homedir(), libraryDir.slice(2)) : libraryDir;
    const folder = path.join(root, '.pageborne', 'reading-activity', instanceId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const dir of [root, path.join(root, '.pageborne'), path.dirname(folder), folder]) {
      const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    }
    return { folder, scope: `pageborne:${instanceId}:${libraryId}` };
  }
  async function read(day) {
    if (!validDay(day)) fail();
    const { folder } = await location(), file = path.join(folder, `${day}.json`);
    let entries = [], signature;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_000_000) fail();
      signature = `${stat.mtimeMs}:${stat.ino}:${stat.size}`;
      entries = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const rev = revision(entries); if (signature) summaries.set(day, { signature, revision: rev });
    return { entries, revision: rev };
  }
  async function index() {
    const { folder } = await location(), days = [];
    for (const name of await readdir(folder)) if (/^\d{4}-\d{2}-\d{2}\.json$/.test(name)) {
      const day = name.slice(0, 10), stat = await lstat(path.join(folder, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16_000_000) fail();
      const cached = summaries.get(day), signature = `${stat.mtimeMs}:${stat.ino}:${stat.size}`;
      const saved = cached?.signature === signature ? cached : await read(day);
      days.push({ day, revision: saved.revision });
    }
    return { version: 1, days: days.sort((a, b) => a.day.localeCompare(b.day)) };
  }
  async function update(day, input) {
    if (!validDay(day) || !Array.isArray(input?.entries) || input.entries.length > 50) fail();
    const { folder, scope } = await location(), file = path.join(folder, `${day}.json`);
    const incoming = input.entries.map(e => validateReadingEntry(e, day, scope));
    const work = (queues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      const prior = await read(day), entries = new Map(prior.entries.map(e => [e.id, e]));
      for (const e of incoming) {
        const old = entries.get(e.id), sessions = new Map([...(old?.sessions || []), ...e.sessions].map(s => [`${s.agent}:${s.id}`, s]));
        if (sessions.size > 100) fail();
        entries.set(e.id, { ...(old || e), sessions: [...sessions.values()] });
      }
      const saved = [...entries.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
      const json = JSON.stringify(saved); if (Buffer.byteLength(json) > 16_000_000) fail();
      const temp = `${file}.${randomUUID()}.tmp`;
      await writeFile(temp, json, { flag: 'wx', mode: 0o600 }); await rename(temp, file);
      return { revision: revision(saved) };
    });
    queues.set(file, work);
    try { return await work; } finally { if (queues.get(file) === work) queues.delete(file); }
  }
  return { read, index, update };
}
export function installReadingActivity(router, options) {
  const store = createReadingActivity(options);
  const handler = run => async (req, res) => { try { res.json(await run(req)); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Could not access reading history.' }); } };
  router.get('/pageborne/reading-activity', handler(() => store.index()));
  router.get('/pageborne/reading-activity/:day', handler(req => store.read(req.params.day)));
  router.post('/pageborne/reading-activity/:day', handler(req => store.update(req.params.day, req.body)));
}
