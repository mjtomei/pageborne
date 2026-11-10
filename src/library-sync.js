import { base64ToBytes, bytesToBase64 } from './binary.js';
import { readLocalFile, hashDocument, MAX_DOCUMENTS, MAX_LIBRARY_BYTES } from './library.js';
import { libraryTimestamp } from './library-order.js';
import { validWordCount } from './reading-estimates.js';

const CHUNK_BYTES = 768 * 1024, encoder = new TextEncoder();
const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
export const documentBytes = doc => {
  if (typeof doc?.content !== 'string') throw new Error('Load the document before reading its contents.');
  return doc.format === 'pdf' ? base64ToBytes(doc.content) : encoder.encode(doc.content);
};
export async function documentDescriptor(doc) {
  const bytes = documentBytes(doc);
  return { name: doc.id, bytes: bytes.length, sha256: await digest(bytes) };
}
function validateManifest(remote) {
  if (remote.version !== 1 || typeof remote.id !== 'string' || typeof remote.directory !== 'string' || !Array.isArray(remote.files)
    || remote.files.some(f => typeof f.name !== 'string' || f.name.startsWith('.') || /[\x00-\x1f\x7f/\\]/.test(f.name)
      || encoder.encode(f.name).length > 220 || !/\.(md|markdown|txt|pdf)$/i.test(f.name) || !/^[a-f0-9]{64}$/.test(f.sha256)
      || !Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > (/\.pdf$/i.test(f.name) ? 16 : 4) * 1024 * 1024)
    || remote.files.some(f => f.title != null && (typeof f.title !== 'string' || f.title.length > 2000)
      || f.words != null && (!Number.isSafeInteger(f.words) || f.words < 0))
    || new Set(remote.files.map(f => f.name)).size !== remote.files.length) throw new Error('The desktop returned an invalid library. No files were changed.');
  return remote;
}
export async function desktopLibrary(client, signal, name) {
  // Probe the authenticated file endpoint directly: syncing does not need a
  // running Claude/Codex process or an available model/account-info request.
  try { return validateManifest(await client.api('pageborne/library', { signal, query: { reading: '1', ...(name ? { name } : {}) } })); }
  catch (error) {
    if (error.status === 404) throw new Error('Library sync needs the updated Pageborne extension in Even Terminal. Reading and Ask still work without it.');
    throw error;
  }
}

// Read-only manifest refresh: never infer a deletion or transfer originals.
// Counts apply only to the exact bytes already saved on this device.
export function preparedWordUpdates(snapshot, remote) {
  const byName = new Map(remote.files.map(file => [file.name, file]));
  return snapshot.documents.flatMap(doc => {
    const file = byName.get(doc.id);
    if (doc.format !== 'pdf' || !/^[a-f0-9]{64}$/.test(doc.sha256 || '') || doc.sha256 !== file?.sha256
      || !validWordCount(file.readingWords) || doc.readingWords === file.readingWords) return [];
    return [{ id: doc.id, expected: doc, readingWords: file.readingWords }];
  });
}
export async function uploadLibraryFile(client, file, bytes, expected, signal, progress = () => {}) {
  const { offset: start } = await client.api('pageborne/library/status', { signal, body: { file } });
  if (!Number.isSafeInteger(start) || start < 0 || start > file.bytes) throw new Error('The desktop returned an invalid upload offset.');
  for (let offset = start; offset < file.bytes; offset += CHUNK_BYTES) {
    signal?.throwIfAborted(); progress(`Sending ${file.name} · ${Math.round(offset / Math.max(1, file.bytes) * 100)}%`);
    await client.api('pageborne/library/chunk', { signal, body: { file, offset, data: bytesToBase64(bytes.subarray(offset, offset + CHUNK_BYTES)) } });
  }
  return client.api('pageborne/library/commit', { signal, body: { file, expected } });
}
export async function downloadLibraryFile(client, file, signal, progress = () => {}) {
  const bytes = new Uint8Array(file.bytes);
  for (let offset = 0; offset < file.bytes;) {
    signal?.throwIfAborted(); progress(`Receiving ${file.name} · ${Math.round(offset / file.bytes * 100)}%`);
    const chunk = await client.api('pageborne/library/read', { signal, body: { name: file.name, sha256: file.sha256, offset } });
    const data = base64ToBytes(chunk.data);
    if (chunk.offset !== offset || chunk.sha256 !== file.sha256 || chunk.bytes !== file.bytes || !data.length || data.length > CHUNK_BYTES || offset + data.length > file.bytes) throw new Error('Invalid document download. Sync again.');
    bytes.set(data, offset); offset += data.length;
  }
  signal?.throwIfAborted();
  progress(`Received ${file.name} · 100%. Verifying download…`);
  if (await digest(bytes) !== file.sha256) throw new Error('Document checksum mismatch. Sync again.');
  signal?.throwIfAborted();
  progress('Opening received document…');
  return { ...await readLocalFile(new File([bytes], file.name), () => {}, { deferReadingWords: true, signal }),
    ...(validWordCount(file.readingWords) ? { readingWords: file.readingWords } : {}),
    ...(libraryTimestamp(file.addedAt) ? { addedAt: file.addedAt } : {}),
    ...(libraryTimestamp(file.modifiedAt) ? { modifiedAt: file.modifiedAt } : {}) };
}
// Authenticate the library identity and exact bytes before an on-demand read.
export async function downloadCatalogDocument(client, doc, { signal, progress } = {}) {
  if (client.config?.endpoint !== doc.remote?.endpoint) throw Error('Reconnect to this document’s desktop library to download it.');
  const remote = await desktopLibrary(client, signal, doc.id);
  const file = remote.files.find(f => f.name === doc.id);
  if (remote.id !== doc.remote.libraryId || file?.sha256 !== doc.sha256 || file.bytes !== doc.bytes)
    throw Error('This document changed or is unavailable on the desktop. Sync your library and try again.');
  return downloadLibraryFile(client, file, signal, progress);
}
function conflictName(name, sha256, used) {
  const dot = name.lastIndexOf('.'), ext = name.slice(dot); let stem = name.slice(0, dot);
  while (encoder.encode(stem).length > 150) stem = [...stem].slice(0, -1).join('');
  for (let n = 1; ; n++) {
    const candidate = `${stem} (phone conflict ${sha256.slice(0, 12)}${n > 1 ? `-${n}` : ''})${ext}`;
    if (!used.has(candidate) || used.get(candidate) === sha256) { used.set(candidate, sha256); return candidate; }
  }
}
// Three-way comparison: only an unchanged counterpart inherits a deletion.
// Conflicting edits and edit/delete conflicts preserve the edited content.
export function planLibrarySync(localFiles, remote, baseline = {}) {
  const local = new Map(localFiles.map(f => [f.name, f])), desktop = new Map(remote.files.map(f => [f.name, f]));
  const excluded = new Set((remote.skipped || []).map(f => f.name));
  const used = new Map([...desktop, ...local].map(([name, f]) => [name, f.sha256]));
  const actions = [];
  for (const name of new Set([...local.keys(), ...desktop.keys(), ...Object.keys(baseline)])) {
    if (excluded.has(name)) continue;
    const l = local.get(name), r = desktop.get(name), base = baseline[name];
    if (l?.sha256 === r?.sha256) continue;
    if (l && r) {
      if (l.sha256 === base) actions.push({ kind: 'download', name, file: r });
      else if (r.sha256 === base) actions.push({ kind: 'upload', name, file: l, expected: r.sha256 });
      else {
        const copy = conflictName(name, l.sha256, used);
        actions.push({ kind: 'conflict', name, copy, file: { ...l, name: copy }, remote: r, expected: desktop.get(copy)?.sha256 || null });
      }
    } else if (l) actions.push(base === l.sha256 ? { kind: 'remove-phone', name } : { kind: 'upload', name, file: l, expected: null });
    else if (r) actions.push(base === r.sha256 ? { kind: 'remove-desktop', name, expected: r.sha256 } : { kind: 'download', name, file: r });
  }
  return actions.sort((a, b) => Number(b.kind === 'remove-phone') - Number(a.kind === 'remove-phone'));
}
export async function syncLibrary({ client, snapshot, store, saved = {}, saveState, changed = () => {}, progress = () => {}, signal }) {
  progress('Checking desktop library…');
  const remote = await desktopLibrary(client, signal), localFiles = [];
  const source = { libraryId: remote.id, endpoint: client.config?.endpoint };
  if (store.onDemand && !source.endpoint) throw Error('Connect to your desktop library before syncing.');
  if (store.readOnly) {
    const result = store.browseRemote(remote, source); await changed(result, null);
    return { ...result, uploaded: 0, downloaded: 0, listed: remote.files.length, deleted: 0, conflicts: 0,
      readOnly: true, directory: remote.directory, skipped: remote.skipped || [] };
  }
  if (store.onDemand && snapshot.documents.some(d => d.remote && (d.remote.libraryId !== source.libraryId || d.remote.endpoint !== source.endpoint)))
    throw Error('These documents belong to a different desktop library. Reconnect to that library before syncing.');
  const load = async doc => {
    signal?.throwIfAborted();
    return typeof doc.content === 'string' ? doc : store.loadDocument(doc, { signal });
  };
  for (const doc of snapshot.documents) {
    signal?.throwIfAborted();
    let sha256 = /^[a-f0-9]{64}$/.test(doc.sha256 || '') ? doc.sha256 : null;
    if (!sha256) {
      progress(`Checking ${doc.id}…`);
      sha256 = await hashDocument(await load(doc));
      await store.cacheHash?.(doc, sha256);
    }
    localFiles.push({ name: doc.id, bytes: doc.bytes, sha256 });
  }
  const baseline = { ...(store.syncBaselineTrusted !== false && saved.id === remote.id ? saved.files || {} : {}) };
  // A saved remote reference is itself a baseline when preferences were lost.
  if (store.onDemand) for (const doc of snapshot.documents) if (doc.remote && !baseline[doc.id]) baseline[doc.id] = doc.remote.sha256;
  const actions = planLibrarySync(localFiles, remote, baseline);
  const finalFiles = new Map(localFiles.map(f => [f.name, f]));
  for (const action of actions) {
    if (action.kind === 'download') finalFiles.set(action.name, action.file);
    if (action.kind === 'remove-phone') finalFiles.delete(action.name);
    if (action.kind === 'conflict') { finalFiles.set(action.copy, action.file); finalFiles.set(action.name, action.remote); }
  }
  const totalBytes = [...finalFiles.values()].reduce((sum, f) => sum + f.bytes, 0);
  if (finalFiles.size > MAX_DOCUMENTS || !store.onDemand && totalBytes > MAX_LIBRARY_BYTES) throw Object.assign(new Error(
    `The synced library needs ${(totalBytes / 1024 / 1024).toFixed(1)} MiB for ${finalFiles.size} files. The phone limit is ${MAX_LIBRARY_BYTES / 1024 / 1024} MiB / ${MAX_DOCUMENTS.toLocaleString('en-US')} files. No files were changed.`),
  { code: 'library-capacity', totalBytes, files: finalFiles.size });
  let current = snapshot; const hashes = { ...baseline };
  const counts = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, ...(store.onDemand ? { listed: 0 } : {}) };
  const persist = async () => saveState({ id: remote.id, directory: remote.directory, files: { ...hashes }, at: Date.now() });
  const put = async (doc, name) => {
    const expected = current.documents.find(d => d.id === name) || null;
    const result = await store.put(doc, expected); current = result.snapshot; await changed(result, name);
  };
  const receive = async file => {
    if (!store.onDemand) return put(await downloadLibraryFile(client, file, signal, progress), file.name);
    const expected = current.documents.find(d => d.id === file.name) || null;
    const result = await store.putRemote(file, source, expected); current = result.snapshot; await changed(result, file.name);
    counts.listed++;
  };
  const confirm = async files => {
    if (!store.onDemand) return;
    const result = await store.confirmRemote(files, source); current = result.snapshot; await changed(result, null);
  };
  const commitState = async () => {
    // Equal files, including already completed operations from a previous
    // interrupted run, establish a baseline without retransferring bytes.
    for (const file of remote.files) if (localFiles.some(l => l.name === file.name && l.sha256 === file.sha256)) hashes[file.name] = file.sha256;
    for (const name of Object.keys(hashes)) if (!finalFiles.has(name) && !remote.files.some(f => f.name === name)
      && !remote.skipped?.some(f => f.name === name)) delete hashes[name];
    await persist();
  };
  // Confirm matching copies before reclaiming any old, fully synced bodies.
  await confirm(remote.files);
  await commitState();
  // Backfill dates and prepared word counts without transferring or
  // rewriting PDF bodies, resetting their caches, or reopening the reader.
  const dates = remote.files.flatMap(file => {
    const expected = current.documents.find(doc => doc.id === file.name);
    if (!expected || !localFiles.some(local => local.name === file.name && local.sha256 === file.sha256)) return [];
    const addedAt = libraryTimestamp(file.addedAt)
      ? Math.min(file.addedAt, libraryTimestamp(expected.addedAt) || Infinity) : 0;
    const readingWords = expected.format === 'pdf' && validWordCount(file.readingWords) ? file.readingWords : undefined;
    if (!(addedAt && addedAt !== expected.addedAt)
      && !(libraryTimestamp(file.modifiedAt) && file.modifiedAt !== expected.modifiedAt)
      && !(validWordCount(readingWords) && readingWords !== expected.readingWords)) return [];
    return [{ id: file.name, addedAt: file.addedAt, modifiedAt: file.modifiedAt, readingWords, expected }];
  });
  if (dates.length && store.updateDates) {
    const result = await store.updateDates(dates); current = result.snapshot; await changed(result, null);
  }
  for (const action of actions) {
    signal?.throwIfAborted(); progress(`Syncing ${action.name}…`);
    const meta = current.documents.find(d => d.id === action.name);
    const doc = ['upload', 'conflict'].includes(action.kind) ? await load(meta) : meta;
    if (action.kind === 'upload') {
      await uploadLibraryFile(client, action.file, documentBytes(doc), action.expected, signal, progress);
      await confirm([action.file]);
      hashes[action.name] = action.file.sha256; counts.uploaded++;
    } else if (action.kind === 'download') {
      await receive(action.file);
      hashes[action.name] = action.file.sha256; if (!store.onDemand) counts.downloaded++;
    } else if (action.kind === 'remove-phone') {
      const result = await store.remove(action.name, doc); current = result.snapshot; await changed(result, action.name);
      delete hashes[action.name]; counts.deleted++;
    } else if (action.kind === 'remove-desktop') {
      const removal = [...(current.libraryRemovals || [])].reverse().find(event => event.document.name === action.name
        && (!event.document.sha256 || event.document.sha256 === action.expected)
        && (!event.libraryId || event.libraryId === remote.id));
      await client.api('pageborne/library/remove', { signal, body: { name: action.name, expected: action.expected,
        ...(removal ? { operationId: removal.id, deletedAt: removal.at,
          ...(validWordCount(removal.document.words) ? { readingWords: removal.document.words } : {}) } : {}) } });
      delete hashes[action.name]; counts.deleted++;
    } else {
      // Save both copies before replacing the phone's original. A dropped
      // response or interrupted save reuses this deterministic conflict name.
      await uploadLibraryFile(client, action.file, documentBytes(doc), action.expected, signal, progress);
      await receive(action.remote);
      hashes[action.name] = action.remote.sha256; await persist();
      await put({ ...doc, id: action.copy, positionKey: undefined }, action.copy);
      await confirm([action.file]);
      hashes[action.copy] = action.file.sha256; counts.conflicts++;
    }
    await persist();
  }
  return { ...counts, directory: remote.directory, skipped: remote.skipped || [], snapshot: current };
}

export async function ensureAskLibraryFile(client, name, original, signal, progress, snapshot = false) {
  const remote = await desktopLibrary(client, signal, name), existing = remote.files.find(f => f.name === name);
  const skipped = remote.skipped?.some(f => f.name === name);
  let synced = existing?.sha256 === original.sha256;
  if (!snapshot && (skipped || existing && !synced)) throw new Error('This document differs on the desktop. Sync the library before asking so both copies are preserved.');
  if (!existing && !skipped) {
    try {
      await uploadLibraryFile(client, { name, bytes: original.bytes, sha256: original.sha256 }, original.data, null, signal, progress);
      synced = true;
    } catch (error) {
      // A desktop edit won the create race. Share the reader's snapshot without
      // overwriting that edit or claiming the two copies have been synced.
      if (!snapshot || error.status !== 409) throw error;
    }
  }
  return { name, sha256: original.sha256, id: remote.id, directory: remote.directory, ...(snapshot ? { snapshot: true, synced } : {}) };
}
