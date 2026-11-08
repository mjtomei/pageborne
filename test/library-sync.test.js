import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, symlink, link, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { libraryManifest, libraryUploadStatus, libraryUploadChunk, libraryCommit, libraryRead, libraryRemove } from '../integrations/even-terminal/pageborne-library.js';
import { paperFilesStatus, paperFileChunk, commitPaperFiles } from '../integrations/even-terminal/pageborne-files.js';
import { workspaceCapabilities } from '../integrations/even-terminal/pageborne-workspaces.js';
import { PhoneLibrary } from '../src/phone-storage.js';
import { readLocalFile, MAX_LIBRARY_BYTES, MAX_PDF_BYTES } from '../src/library.js';
import { syncLibrary, documentDescriptor, documentBytes, uploadLibraryFile, planLibrarySync, preparedWordUpdates } from '../src/library-sync.js';

test('read-only word counts match exact saved bytes and ignore replacements, unknown hashes and deleted files', () => {
  const sha = 'a'.repeat(64), documents = [
    { id: 'match.pdf', format: 'pdf', sha256: sha }, { id: 'empty.pdf', format: 'pdf', sha256: sha },
    { id: 'changed.pdf', format: 'pdf', sha256: 'b'.repeat(64) }, { id: 'unhashed.pdf', format: 'pdf' },
    { id: 'partial.pdf', format: 'pdf', sha256: sha }, { id: 'text.md', sha256: sha },
  ];
  const files = [...documents, { id: 'deleted.pdf' }].map(doc => ({ name: doc.id, sha256: sha, readingWords: doc.id === 'empty.pdf' ? 0 : 1200 }));
  delete files.find(f => f.name === 'partial.pdf').readingWords;
  const updates = preparedWordUpdates({ documents }, { files });
  assert.deepEqual(updates.map(u => [u.id, u.readingWords]), [['match.pdf', 1200], ['empty.pdf', 0]]);
  assert.equal(updates[0].expected, documents[0]);
});
import { paperAttachments, syncPaperFiles } from '../src/ask-documents.js';
import { nativeLayout } from '../src/native-text.js';
import { parseDocument } from '../src/document.js';
import { EvenTerminal } from '../src/ask-terminal.js';
import { orderedDocuments } from '../src/library-order.js';
import { Lexer } from 'marked';
import { downloadLibraryFile } from '../src/library-sync.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const document = (name, content) => readLocalFile(new File([content], name));
test('verified downloads use desktop counts without parsing the book on the UI thread', async t => {
  t.mock.method(Lexer, 'lex', () => { throw Error('Do not parse downloaded books before background preparation'); });
  const content = '\uFEFF# A book\r\n\r\n' + 'A readable paragraph.\n\n'.repeat(8000), bytes = Buffer.from(content);
  const file = { name: 'book.md', bytes: bytes.length, sha256: hash(bytes), readingWords: 24002 };
  const client = { async api(_, { body: { offset } }) {
    return { ...file, offset, data: bytes.subarray(offset, offset + 768 * 1024).toString('base64') };
  } };
  const downloaded = await downloadLibraryFile(client, file);
  assert.equal(downloaded.content, content); assert.equal(downloaded.readingWords, file.readingWords);
  assert.equal(downloaded.title, 'A book');
  const unknown = await downloadLibraryFile(client, { ...file, readingWords: undefined });
  assert.equal(unknown.readingWords, undefined, 'the reader can calculate missing counts in the background');
  await assert.rejects(downloadLibraryFile(client, { ...file, sha256: '0'.repeat(64) }), /Invalid document download|checksum mismatch/);
  const controller = new AbortController();
  await assert.rejects(downloadLibraryFile(client, file, controller.signal, stage => {
    if (stage.includes('Verifying')) controller.abort();
  }), { name: 'AbortError' });
});
async function fixture(t, lazy = false) {
  const libraryDir = await mkdtemp(path.join(tmpdir(), 'pageborne-library-'));
  t.after(() => rm(libraryDir, { recursive: true, force: true }));
  const options = { libraryDir }, values = new Map();
  const kv = { async get(key) { return values.get(key) || ''; }, async set(key, value) { values.set(key, value); } };
  const store = new PhoneLibrary(kv, { lazy }); await store.read(); const calls = [];
  const actions = { status: libraryUploadStatus, chunk: libraryUploadChunk, commit: libraryCommit, read: libraryRead, remove: libraryRemove };
  const papers = { status: paperFilesStatus, chunk: paperFileChunk, commit: commitPaperFiles };
  const client = { serverInfo: async () => ({ pageborne: workspaceCapabilities() }), async api(route, { body = {}, signal, query = {} } = {}) {
    signal?.throwIfAborted(); calls.push({ route, body });
    if (route === 'pageborne/library') return libraryManifest(query, options);
    return (route.includes('/files/') ? papers : actions)[route.split('/').at(-1)](body, options);
  } };
  let saved = {};
  const sync = extras => syncLibrary({ client, snapshot: store.snapshot, store, saved, saveState: async state => { saved = structuredClone(state); }, ...extras });
  return { libraryDir, options, store, kv, client, calls, sync, state: () => saved };
}

test('library sync exchanges all originals, deduplicates identical files, and persists its baseline across phone restart', async t => {
  const f = await fixture(t);
  await f.store.save(await document('phone.md', '# Phone'));
  await f.store.save(await document('scan.pdf', '%PDF-test'));
  await writeFile(path.join(f.libraryDir, 'desktop.txt'), 'Desktop');
  await writeFile(path.join(f.libraryDir, 'phone.md'), '# Phone');
  await writeFile(path.join(f.libraryDir, 'bom.md'), '\uFEFF# Heading\r\n\r\nOriginal bytes.');
  const result = await f.sync(); assert.equal(result.uploaded, 1); assert.equal(result.downloaded, 2);
  assert.deepEqual(f.store.snapshot.documents.map(d => d.id).sort(), ['bom.md', 'desktop.txt', 'phone.md', 'scan.pdf']);
  assert.equal(f.store.snapshot.documents.find(d => d.id === 'bom.md').content, '\uFEFF# Heading\r\n\r\nOriginal bytes.');
  assert.equal(await readFile(path.join(f.libraryDir, 'scan.pdf'), 'utf8'), '%PDF-test');
  const reopened = new PhoneLibrary(f.kv); await reopened.read();
  const count = f.calls.filter(c => c.route.endsWith('/chunk')).length;
  await f.sync({ store: reopened, snapshot: reopened.snapshot });
  assert.equal(f.calls.filter(c => c.route.endsWith('/chunk')).length, count);
  assert.equal(Object.keys(f.state().files).length, 4);
});

test('new PDF word counts sync without original transfers and survive native phone reload', async t => {
  const f = await fixture(t, true);
  await writeFile(path.join(f.libraryDir, 'book.pdf'), '%PDF-test');
  await f.sync();
  const original = f.store.snapshot.documents[0], api = f.client.api.bind(f.client);
  f.client.api = async (route, options) => {
    const result = await api(route, options);
    if (route === 'pageborne/library') for (const file of result.files) file.readingWords = 12000;
    return result;
  };
  f.calls.length = 0;
  const result = await f.sync();
  assert.equal(result.downloaded, 0); assert.equal(result.uploaded, 0);
  assert.equal(f.calls.some(c => c.route.endsWith('/read') || c.route.endsWith('/chunk')), false);
  assert.equal(f.store.snapshot.documents[0].revision, original.revision);
  const reopened = new PhoneLibrary(f.kv, { lazy: true }); await reopened.read();
  assert.equal(reopened.snapshot.documents[0].readingWords, 12000);
  f.client.api = api;
  await writeFile(path.join(f.libraryDir, 'book.pdf'), '%PDF-new content');
  await f.sync();
  assert.equal(f.store.snapshot.documents[0].readingWords, undefined, 'old counts cannot leak to replacement bytes');
});

test('one-sided edits transfer in either direction and preserve the phone reading identity', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'First')); await f.sync();
  const key = f.store.snapshot.documents[0].positionKey;
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'Desktop edit');
  assert.equal((await f.sync()).downloaded, 1);
  assert.equal(f.store.snapshot.documents[0].content, 'Desktop edit'); assert.equal(f.store.snapshot.documents[0].positionKey, key);
  await f.store.put(await document('paper.md', 'Phone edit'), f.store.snapshot.documents[0]);
  assert.equal((await f.sync()).uploaded, 1);
  assert.equal(await readFile(path.join(f.libraryDir, 'paper.md'), 'utf8'), 'Phone edit');
});

test('a 40 MiB library syncs and reopens intact above the old 32 MiB cap', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(10 * 1024 * 1024, 32);
  bytes.write('%PDF-fixture\n');
  for (let i = 0; i < 4; i++) await writeFile(path.join(f.libraryDir, `${i}.pdf`), bytes);
  assert.equal((await f.sync()).downloaded, 4);
  const reopened = new PhoneLibrary(f.kv), saved = await reopened.read();
  assert.equal(saved.documents.reduce((n, doc) => n + doc.bytes, 0), 40 * 1024 * 1024);
  for (const doc of saved.documents) assert.equal((await documentDescriptor(doc)).sha256, hash(bytes));
  const reads = f.calls.filter(call => call.route.endsWith('/read')).length;
  assert.equal((await f.sync({ store: reopened, snapshot: saved })).downloaded, 0);
  assert.equal(f.calls.filter(call => call.route.endsWith('/read')).length, reads);
});

test('both-side edits keep deterministic copies, including interrupted conflict recovery', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'First')); await f.sync();
  await f.store.put(await document('paper.md', 'Phone edit'), f.store.snapshot.documents[0]);
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'Desktop edit');
  const put = f.store.put.bind(f.store); let failCopy = true;
  f.store.put = async (doc, prior) => { if (doc.id.includes('conflict') && failCopy) { failCopy = false; throw new Error('Interrupted save'); } return put(doc, prior); };
  await assert.rejects(f.sync(), /Interrupted/); await f.sync();
  assert.equal(f.store.snapshot.documents.length, 2);
  const copy = f.store.snapshot.documents.find(d => d.id.includes('conflict'));
  assert.equal(copy.content, 'Phone edit'); assert.equal(await readFile(path.join(f.libraryDir, copy.id), 'utf8'), 'Phone edit');
  assert.equal(f.store.snapshot.documents.find(d => d.id === 'paper.md').content, 'Desktop edit');
  assert.equal((await f.sync()).conflicts, 0);
});

test('deletions propagate both ways and last synced originals remain recoverable on desktop', async t => {
  const f = await fixture(t);
  for (const name of ['phone-delete.md', 'desktop-delete.md']) await f.store.save(await document(name, `Keep ${name}`));
  await f.sync(); await f.store.remove('phone-delete.md'); await rm(path.join(f.libraryDir, 'desktop-delete.md'));
  assert.equal((await f.sync()).deleted, 2); assert.equal(f.store.snapshot.documents.length, 0);
  assert.deepEqual((await libraryManifest({}, f.options)).files, []);
  for (const name of ['phone-delete.md', 'desktop-delete.md']) {
    const folder = path.join(f.libraryDir, '.pageborne/history', hash(name));
    assert.equal(JSON.parse(await readFile(path.join(folder, 'name.json'))).name, name);
    assert.equal(await readFile(path.join(folder, hash(`Keep ${name}`) + '.md'), 'utf8'), `Keep ${name}`);
  }
  await f.sync(); assert.deepEqual(f.state().files, {});
});

test('edit/delete conflicts preserve edits and skipped unsafe files never look like deletions', async t => {
  const f = await fixture(t);
  for (const name of ['edited-phone.md', 'edited-desktop.md', 'linked.md']) await f.store.save(await document(name, 'Original'));
  await f.sync();
  await f.store.put(await document('edited-phone.md', 'New on phone'), f.store.snapshot.documents[0]); await rm(path.join(f.libraryDir, 'edited-phone.md'));
  await f.store.remove('edited-desktop.md'); await writeFile(path.join(f.libraryDir, 'edited-desktop.md'), 'New on desktop');
  await rm(path.join(f.libraryDir, 'linked.md')); await symlink('/does-not-exist', path.join(f.libraryDir, 'linked.md'));
  const result = await f.sync(); assert.equal(result.deleted, 0); assert.equal(result.skipped.length, 1);
  assert.equal(f.store.snapshot.documents.length, 3); assert.equal(await readFile(path.join(f.libraryDir, 'edited-phone.md'), 'utf8'), 'New on phone');
  assert.equal(f.store.snapshot.documents.find(d => d.id === 'edited-desktop.md').content, 'New on desktop');
});

test('changed desktop content rejects stale writes, download pointers and deletions', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'First')); await f.sync();
  const before = (await libraryManifest({}, f.options)).files[0];
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'New desktop edit');
  const doc = await document('paper.md', 'Phone change'), file = await documentDescriptor(doc);
  await assert.rejects(uploadLibraryFile(f.client, file, documentBytes(doc), before.sha256), { status: 409 });
  await assert.rejects(libraryRemove({ name: before.name, expected: before.sha256 }, f.options), { status: 409 });
  await assert.rejects(libraryRead({ name: before.name, sha256: before.sha256 }, f.options), { status: 409 });
  assert.equal(await readFile(path.join(f.libraryDir, 'paper.md'), 'utf8'), 'New desktop edit');
});

test('a skipped desktop file keeps a pending phone deletion until it can be compared safely', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'Original')); await f.sync();
  await f.store.remove('paper.md'); await writeFile(path.join(f.libraryDir, 'paper.md'), Buffer.from([255]));
  assert.equal((await f.sync()).skipped.length, 1); assert.equal(f.state().files['paper.md'], hash('Original'));
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'Original');
  assert.equal((await f.sync()).deleted, 1); assert.equal(f.store.snapshot.documents.length, 0);
});

test('uploads resume after interruption, tolerate repeated chunks, and reject incorrect contents', async t => {
  const f = await fixture(t), doc = await document('large.md', 'A'.repeat(900000)), file = await documentDescriptor(doc);
  const first = { file, offset: 0, data: Buffer.from('A'.repeat(768 * 1024)).toString('base64') };
  await libraryUploadChunk(first, f.options); await libraryUploadChunk(first, f.options);
  assert.equal((await libraryUploadStatus({ file }, f.options)).offset, 768 * 1024);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(uploadLibraryFile(f.client, file, documentBytes(doc), null, controller.signal));
  await uploadLibraryFile(f.client, file, documentBytes(doc), null);
  assert.equal(await readFile(path.join(f.libraryDir, 'large.md'), 'utf8'), doc.content);
  const invalid = { name: 'bad.md', bytes: 4, sha256: hash('good') };
  await assert.rejects(libraryUploadChunk({ file: invalid, offset: 0, data: Buffer.from('oops').toString('base64') }, f.options), /checksum/);
  assert.equal((await libraryUploadStatus({ file: invalid }, f.options)).offset, 0);
});

test('sync rejects traversal and linked files without modifying targets', async t => {
  const f = await fixture(t), file = { name: '../outside.md', bytes: 4, sha256: hash('text') };
  await assert.rejects(libraryCommit({ file, expected: null }, f.options));
  await writeFile(path.join(f.libraryDir, 'outside'), 'Keep');
  await symlink(path.join(f.libraryDir, 'outside'), path.join(f.libraryDir, 'linked.md'));
  await link(path.join(f.libraryDir, 'outside'), path.join(f.libraryDir, 'hard.md'));
  for (const name of ['linked.md', 'hard.md']) await assert.rejects(libraryRemove({ name, expected: hash('Keep') }, f.options));
  assert.equal(await readFile(path.join(f.libraryDir, 'outside'), 'utf8'), 'Keep');
  const sub = path.join(f.libraryDir, 'sub'); await mkdir(sub); await symlink(f.libraryDir, path.join(sub, '.pageborne'));
  await assert.rejects(libraryManifest({}, { libraryDir: sub }), /Unsafe/);
});

test('new library identity does not inherit old deletions; final phone size is checked before mutations', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'Phone'));
  await f.sync({ saved: { id: 'another-library', files: { 'paper.md': hash('Phone') } } });
  assert.equal(await readFile(path.join(f.libraryDir, 'paper.md'), 'utf8'), 'Phone');
  const client = { serverInfo: f.client.serverInfo, async api(route) {
    assert.equal(route, 'pageborne/library');
    return { version: 1, id: 'large', directory: '/fixture', files: Array.from({ length: Math.floor(MAX_LIBRARY_BYTES / MAX_PDF_BYTES) + 1 }, (_, i) => ({ name: `${i}.pdf`, bytes: MAX_PDF_BYTES, sha256: hash(String(i)) })) };
  } };
  await assert.rejects(f.sync({ client }), error => error.code === 'library-capacity'
    && /phone limit is 1024 MiB/.test(error.message) && error.totalBytes > MAX_LIBRARY_BYTES);
  assert.equal(f.store.snapshot.documents.length, 1);
});

test('Ask keeps stable original snapshots inside the library across desktop edits', async t => {
  const f = await fixture(t); const doc = await document('my paper.md', '# Heading\n\nThe shared text.');
  await writeFile(path.join(f.libraryDir, 'other.md'), 'Another paper');
  const layout = nativeLayout(parseDocument(doc.content));
  const bundle = await paperAttachments({ document: doc, layout, y: 0 });
  const attachment = await syncPaperFiles(f.client, 'identity', bundle, undefined, () => {}, { cwd: '/old/session', workspaceId: 'old' });
  const original = attachment.files.find(file => file.name.startsWith('original.')).path;
  assert.equal(path.dirname(original), path.dirname(attachment.index));
  assert.equal(await readFile(original, 'utf8'), doc.content);
  assert.equal(attachment.library.synced, true);
  assert(attachment.index.startsWith(path.join(f.libraryDir, '.pageborne/reflow') + '/'));
  assert.equal(attachment.library.id, (await libraryManifest({}, f.options)).id);
  assert.deepEqual((await libraryManifest({ name: doc.id }, f.options)).files.map(f => f.name), [doc.id]);
  const reads = f.calls.filter(c => c.route === 'pageborne/files/chunk');
  assert(reads.every(c => !c.body.file.name.startsWith('original.')), 'original is not uploaded twice');
  const count = f.calls.filter(c => c.route.endsWith('/chunk')).length;
  await syncPaperFiles(f.client, 'identity', bundle, undefined, () => {});
  assert.equal(f.calls.filter(c => c.route.endsWith('/chunk')).length, count);
  await writeFile(path.join(f.libraryDir, doc.id), 'Changed by an agent');
  const followup = await syncPaperFiles(f.client, 'identity', bundle, undefined, () => {});
  assert.equal(followup.library.synced, false);
  assert.equal(followup.index, attachment.index);
  assert.equal(f.calls.filter(c => c.route.endsWith('/chunk')).length, count);
  assert.equal(await readFile(original, 'utf8'), doc.content);
  assert.equal(await readFile(path.join(f.libraryDir, doc.id), 'utf8'), 'Changed by an agent');
});

test('Ask can upload an unseen reader revision without changing desktop content or sync baseline', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'Baseline')); await f.sync();
  const baseline = f.state();
  await f.store.put(await document('paper.md', 'Reader edit'), f.store.snapshot.documents[0]);
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'Desktop edit');
  const doc = f.store.snapshot.documents[0], layout = nativeLayout(parseDocument(doc.content));
  const bundle = await paperAttachments({ document: doc, layout, y: 0 });
  const saved = await syncPaperFiles(f.client, 'identity', bundle, undefined, () => {});
  assert.equal(saved.library.synced, false); assert.deepEqual(f.state(), baseline);
  assert.equal(await readFile(saved.files.find(f => f.name === 'original.md').path, 'utf8'), 'Reader edit');
  assert.equal(await readFile(path.join(f.libraryDir, 'paper.md'), 'utf8'), 'Desktop edit');
  assert.equal((await f.sync()).conflicts, 1, 'Ask must not disguise conflicting edits as an earlier successful sync');
  assert.equal(f.store.snapshot.documents.find(d => d.id === 'paper.md').content, 'Desktop edit');
  assert(f.store.snapshot.documents.some(d => d.content === 'Reader edit'));
});

test('desktop edits during Ask upload and after commit leave every attached file stable', async t => {
  const f = await fixture(t), doc = await document('racing.md', 'Reader snapshot');
  const layout = nativeLayout(parseDocument(doc.content)), bundle = await paperAttachments({ document: doc, layout, y: 0 });
  let edits = 0;
  const client = { ...f.client, async api(route, options) {
    if (['pageborne/library/commit', 'pageborne/files/status', 'pageborne/files/chunk', 'pageborne/files/commit'].includes(route)) {
      await writeFile(path.join(f.libraryDir, doc.id), `Desktop edit ${++edits}`);
    }
    return f.client.api(route, options);
  } };
  const saved = await syncPaperFiles(client, 'identity', bundle, undefined, () => {});
  assert.equal(saved.library.synced, false); assert(edits >= 4);
  await writeFile(path.join(f.libraryDir, doc.id), 'Edited while the agent is reading');
  for (const file of saved.files) assert.equal(hash(await readFile(file.path)), file.sha256);
  assert.equal(await readFile(saved.files.find(f => f.name === 'original.md').path, 'utf8'), doc.content);
  assert.equal(await readFile(path.join(f.libraryDir, doc.id), 'utf8'), 'Edited while the agent is reading');
  const body = { paperId: 'identity', library: saved.library, files: bundle.files };
  await assert.rejects(paperFilesStatus({ ...body, library: { ...saved.library, id: 'another-library' } }, f.options), /library has changed/);
  await assert.rejects(paperFilesStatus({ ...body, library: { ...saved.library, name: '../outside.md' } }, f.options), /filename/);
  await assert.rejects(paperFilesStatus({ ...body, library: { ...saved.library, sha256: hash('different') } }, f.options), /snapshot/);
});

test('snapshot upgrade reintroduces stable paths to existing sessions; legacy uploads still protect the desktop', async t => {
  const f = await fixture(t), doc = await document('legacy.md', 'Original');
  const layout = nativeLayout(parseDocument(doc.content)), bundle = await paperAttachments({ document: doc, layout, y: 0 });
  const legacy = { ...f.client, serverInfo: async () => ({ pageborne: { documents: 1, librarySync: 1 } }) };
  const before = await syncPaperFiles(legacy, 'identity', bundle, undefined, () => {});
  assert.equal(before.files.find(f => f.name === 'original.md').path, path.join(f.libraryDir, doc.id));
  const after = await syncPaperFiles(f.client, 'identity', bundle, undefined, () => {});
  assert.equal(after.revision, before.revision); assert.notEqual(after.index, before.index);
  assert.notEqual(after.files.find(f => f.name === 'original.md').path, before.files.find(f => f.name === 'original.md').path);
  await writeFile(path.join(f.libraryDir, doc.id), 'Desktop edit');
  await assert.rejects(syncPaperFiles(legacy, 'identity', bundle, undefined, () => {}), /Sync the library/);
  assert.equal(await readFile(path.join(f.libraryDir, doc.id), 'utf8'), 'Desktop edit');
});

test('Ask retains the linked session across revisions and only records actually synced originals', async t => {
  const f = await fixture(t), prompts = [], baselines = [], messages = [];
  const client = new EvenTerminal({ mode: 'terminal', agent: 'codex', endpoint: 'https://fixture.test', token: 'fixture' }, {
    onLibraryFile: async (_endpoint, file) => baselines.push(file.sha256),
    fetcher: async (url, options) => {
      const request = new URL(url), route = request.pathname.slice('/api/'.length), body = options.body && JSON.parse(options.body);
      if (route === 'info') return Response.json(await f.client.serverInfo());
      if (route.endsWith('/history')) return Response.json({ history: [] });
      if (route === 'messages') return Response.json({ state: 'idle', messages });
      if (route === 'prompt') {
        prompts.push(body); assert.equal(body.sessionId, 'existing-session');
        messages.push({ id: messages.length + 1, type: 'user_prompt', text: body.text });
        messages.push({ id: messages.length + 1, type: 'result', success: true, text: `Answer ${prompts.length}` });
        return Response.json({ sessionId: 'existing-session' });
      }
      return Response.json(await f.client.api(route, { body, query: Object.fromEntries(request.searchParams) }));
    },
  });
  let binding = { sessionId: 'existing-session' }, bundle;
  const send = async content => {
    const doc = await document('paper.md', content), layout = nativeLayout(parseDocument(content));
    bundle = await paperAttachments({ document: doc, layout, y: 0 });
    return client.ask({ paperId: 'same-paper', question: 'Explain this version.', context: { title: 'Paper', passage: '' }, paper: async () => bundle }, binding, value => { binding = value; });
  };
  await send('Original'); const firstFiles = binding.documentFiles;
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'Desktop edit');
  await send('Reader edit');
  assert.equal(prompts.length, 2); assert.equal(binding.sessionId, 'existing-session');
  assert.deepEqual(baselines, [hash('Original')]);
  assert(prompts[1].text.includes('Paper files (read them as needed'));
  assert(prompts[1].text.includes('saved snapshot of the version open in the reader'));
  assert.equal(await readFile(firstFiles.files.find(f => f.name === 'original.md').path, 'utf8'), 'Original');
  assert.equal(await readFile(binding.documentFiles.files.find(f => f.name === 'original.md').path, 'utf8'), 'Reader edit');
  assert.equal(await readFile(path.join(f.libraryDir, 'paper.md'), 'utf8'), 'Desktop edit');
});

test('atomic phone replacement keeps previous content on storage failure and refuses stale mutations', async t => {
  const f = await fixture(t); await f.store.save(await document('paper.md', 'First'));
  const prior = f.store.snapshot.documents[0], set = f.kv.set;
  f.kv.set = async (key, value) => { if (key.includes(':doc:') && value) throw new Error('No space'); return set(key, value); };
  await assert.rejects(f.store.put(await document('paper.md', 'Second'), prior), /No space/);
  f.kv.set = set; const fresh = new PhoneLibrary(f.kv); await fresh.read(); assert.equal(fresh.snapshot.documents[0].content, 'First');
  await fresh.put(await document('paper.md', 'Second'), prior);
  await assert.rejects(fresh.put(await document('paper.md', 'Third'), prior), /changed during sync/);
  await assert.rejects(fresh.remove('paper.md', prior), /changed during sync/);
  assert.equal((await new PhoneLibrary(f.kv).read()).documents[0].content, 'Second');
});

test('stock Terminal produces a clear optional-feature error without file mutations', async t => {
  const f = await fixture(t); const client = { api(route, options) { assert.equal(route, 'pageborne/library'); assert.equal(options.body, undefined); throw Object.assign(new Error('Not found'), { status: 404 }); } };
  await assert.rejects(f.sync({ client }), /updated Pageborne extension/);
  assert.equal(f.calls.length, 0);
});

test('sync backfills original addition dates without downloading bodies or reloading the active PDF', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.libraryDir, 'older.txt'), 'Older');
  await new Promise(resolve => setTimeout(resolve, 15));
  await writeFile(path.join(f.libraryDir, 'newer.txt'), 'Newer');
  const old = new Date('2000-01-01');
  await utimes(path.join(f.libraryDir, 'newer.txt'), old, old);
  await f.sync();
  const manifest = await libraryManifest({}, f.options);
  for (const doc of f.store.snapshot.documents) {
    assert.equal(doc.addedAt, manifest.files.find(file => file.name === doc.id).addedAt);
    delete doc.addedAt; delete doc.modifiedAt; // Legacy snapshot, bodies already synced.
  }
  f.calls.length = 0; const changes = [];
  await f.sync({ changed: async (_result, id) => changes.push(id) });
  assert.deepEqual(changes, [null], 'date-only refresh must not reopen a document');
  assert.ok(!f.calls.some(call => /\/(read|chunk)$/.test(call.route)));
  const reopened = new PhoneLibrary(f.kv); await reopened.read();
  assert.deepEqual(reopened.snapshot, f.store.snapshot);
  const docs = reopened.snapshot.documents;
  const added = docs.find(doc => doc.id === 'newer.txt').addedAt;
  assert.deepEqual(orderedDocuments(docs, { openedAt: { 'older.txt': added - 1 } }).map(doc => doc.id), ['newer.txt', 'older.txt']);
});


test('lazy sync exchanges edits and conflict copies without keeping document bodies in the catalog', async t => {
  const f = await fixture(t, true);
  await f.store.save(await document('paper.md', 'original'));
  await f.sync();
  const reads = [], get = f.kv.get.bind(f.kv); f.kv.get = key => { reads.push(key); return get(key); };
  await f.sync();
  assert.equal(reads.filter(key => key.includes(':doc:')).length, 0, 'unchanged sync uses saved content hashes');
  await writeFile(path.join(f.libraryDir, 'paper.md'), 'desktop edit');
  await f.store.put(await document('paper.md', 'phone edit'), f.store.snapshot.documents[0]);
  await f.sync();
  const docs = f.store.snapshot.documents;
  assert(docs.every(doc => !('content' in doc)));
  assert.equal((await f.store.loadDocument(docs.find(doc => doc.id === 'paper.md'))).content, 'desktop edit');
  assert.equal((await f.store.loadDocument(docs.find(doc => doc.id !== 'paper.md'))).content, 'phone edit');
  assert.equal(await readFile(path.join(f.libraryDir, docs.find(doc => doc.id !== 'paper.md').id), 'utf8'), 'phone edit');
});

test('legacy lazy libraries hash originals once and persist hashes for subsequent syncs', async t => {
  const f = await fixture(t, true);
  await f.store.save(await document('old.txt', 'legacy'));
  for (const doc of f.store.catalog.documents) delete doc.sha256;
  await f.store.commit(f.store.catalog);
  await f.store.read();
  let bodies = 0; const get = f.kv.get.bind(f.kv); f.kv.get = key => { if (key.includes(':doc:')) bodies++; return get(key); };
  await f.sync(); assert(bodies > 0);
  bodies = 0; await f.store.read(); await f.sync();
  assert.equal(bodies, 0);
});
