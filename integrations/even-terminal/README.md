# Paper files and optional session directories inside Even Terminal

Stock Even Terminal works without this extension. Pageborne defaults to normal new-session behavior, using Terminal's project directory; existing-directory overrides use its existing `cwd` API.

This extension adds paper file transfer and optional automatic session folders to a custom server. It is part of that server process, with the same port, HTTPS transport, CORS and pairing-token authentication. It neither starts agents nor changes the standard prompt/cwd behavior. The local shared-session fork includes it; stock packages are untouched.

Copy `pageborne-workspaces.js`, `pageborne-files.js`, `pageborne-library.js` and `pageborne-session-titles.js` alongside `dist/routes/core.js`. In that router:

```js
import { installPaperWorkspaces, workspaceCapabilities } from './pageborne-workspaces.js';
const router = Router();
installPaperWorkspaces(router);
```

When returning the existing `/info` response, add:

```js
res.json({ ...info, pageborne: workspaceCapabilities() });
```

Keep that router behind the server's existing `/api` authentication middleware. Restart the Terminal server to load the extension. No new dependency, service, token, or listener is needed.

### Paper session names

New Pageborne conversations start their first prompt with the library document title (or `Untitled paper`). Stock Terminal can use this readable heading in its first-prompt preview; its own summaries or user-assigned names still take precedence. It receives no new API fields.

The custom server additionally sets the native Codex thread name. Add `threadSetName(threadId, name)` to the Codex app-server client, calling `thread/name/set` with `{threadId, name}`, and expose `setSessionTitle(id, title)` on its provider. This is the user-facing thread name returned by `thread/list`; see [OpenAI's app-server protocol](https://learn.chatgpt.com/docs/app-server). The installed local protocol schema also confirms these fields. The local adapter includes these methods; no change to thread creation, directories, agent permissions or turn handling is needed.

Import `sessionTitleCapabilities` and `nameNewPaperSession` from `pageborne-session-titles.js` in the existing core router. Merge `sessionTitleCapabilities(provider)` into `/info`'s `pageborne` object. This advertises `sessionTitles: 1` only for providers implementing the method. In `/prompt`, wrap the **single** accepted result:

```js
const result = await nameNewPaperSession(targetProvider,
  await targetProvider.prompt(sessionId, text, cwd),
  { sessionId, sessionTitle: req.body.sessionTitle });
```

Return the existing session ID/provider as usual (and optionally `result.sessionTitle`). The extension attempts naming only when creating a session, normalizes the title to one line / 300 Unicode characters, and returns the accepted session even if naming fails or takes more than 1.5 seconds. It never retries a prompt. Linked/existing sessions and desktop title edits are preserved. Native Claude connectors retain the name of the session selected on the desktop; no unsupported renaming API is claimed. This helper is separate from workspace capabilities so servers must not advertise it unless their provider implements naming.

In Pageborne, enable **Create separate session folders · custom Terminal**. The base defaults to `~/.pageborne/papers`; override on the phone or with `PAGEBORNE_PAPER_BASE` on the server. Folder requests contain stable `paperId` and per-conversation `workspaceId` values, plus optional `title` and `baseDir`; they return an absolute `cwd`. Existing sessions are not moved. A new conversation gets a new directory, while a retried directory request is idempotent. Folder names derive from hashes, symlinked paper/session children are rejected, and metadata is created exclusively with owner-only permissions.

On older clients, or servers without `librarySync: 1`, file transfer is advertised automatically by `workspaceCapabilities()` as `documents: 1`, independent of optional session directories. Asking shares only the selected paper with this desktop, while the phone keeps its local library. The updated extension also advertises `documentWorkspaces: 1`: when Pageborne created a session folder, files go in its `files` child. This honors the created path, including custom bases, even after the phone's default changes. A prepared folder can also be retained for files when linking a manually started session. No linked session's working directory is changed.

Without a created folder (or with an older extension), files use the server's `PAGEBORNE_PAPER_BASE` or `~/.pageborne/papers`, under `paper-<identity hash>/files`. Existing arbitrary cwd overrides do not become upload targets. Old shared copies remain when a managed session upgrades to the new destination; the next question introduces the new paths even if the contents are unchanged.

The protocol adds three authenticated POST routes:

- `/api/pageborne/files/status`: `{paperId, files: [{name, bytes, sha256}]}` returns missing filenames and resumable offsets.
- `/api/pageborne/files/chunk`: `{paperId, file: {name, bytes, sha256}, offset, data}` stores a base64-encoded chunk up to 768 KiB. Chunks may be repeated, but mismatched offsets/data or hashes are rejected.
- `/api/pageborne/files/commit`: the status payload verifies every complete file and returns a revision, immutable absolute file paths and a manifest path.

For the legacy paper-file routes, exactly one original (`original.pdf`, `original.md` or `original.txt`), `reflow.md` and `index.json` are accepted, each up to 16 MiB. IDs are hashed; filenames are fixed; symlinked/hardlinked target files and symlinked child directories are rejected. Files are created with owner-only permissions. JSON requests fit below Terminal's existing 10 MiB limit. No file contents are sent through `/api/prompt`; the agent gets paths and a position pointer and reads what it needs. Its existing tool permissions still apply. The exported index uses friendly logical filenames resolved through the manifest/file list.

With `documentWorkspaces: 1`, all three file requests may include `workspace: {cwd, workspaceId}`. The server checks the absolute canonical directory, hashed paper/session names, and existing `paper.json` identity before writing inside it. Missing, mismatched or symlinked workspaces fail instead of silently saving elsewhere. Older clients omit this field and continue using the shared paper folder.

Unchanged files in the same destination are deduplicated by hash and interrupted uploads resume. Reflow revisions produce new files rather than moving older line references. Desktop copies and old versions remain until removed on the desktop; deleting the phone copy or unlinking a session does not remove them. A stock server without the advertised capability receives current text context on every question, including changed positions and newly prepared PDF text, in the same conversation. Scrolling alone does not submit anything. These files and the reader's tests are versioned here; this does not publish or alter the separate public Terminal patch repository.

## Bidirectional library sync

The updated extension advertises `librarySync: 1`. Pageborne's document picker has **Sync library** on the phone and **Hold to sync** at the bottom right on glasses. The glasses hold and the preview/keyboard hold use the same action path; they do not open the microphone while the document picker is visible. Sync runs while the reader stays usable, reports progress in both interfaces, and offers Cancel on the phone. File import/deletion controls wait during sync. No agent prompt is sent, and no running model is required.

All originals live directly in `~/.pageborne/library`. Override this once on the desktop with `PAGEBORNE_LIBRARY_DIR=/absolute/path` (or `~/path`) before starting Terminal. This is distinct from `PAGEBORNE_PAPER_BASE`, which still controls optional session working directories. Drop `.pdf`, `.md`, `.markdown` and UTF-8 `.txt` files into the folder, or use scp/rsync/normal file tools. Files keep their readable names. Hidden files, other extensions and directories are not imported; linked, oversized, invalid or unreadable documents are reported as skipped and never interpreted as remote deletions. Subdirectories are not traversed.

```text
~/.pageborne/library/
  paper.pdf
  notes.md
  .pageborne/
    library.json             # durable directory identity
    history/<name hash>/     # name.json + checksum.ext versions
    reflow/<name hash>/      # versioned original, reflow.md, index.json, manifests
    uploads/                 # resumable transfers
```

The phone remembers each filename's last agreed checksum, scoped to the Terminal endpoint and this directory's durable identity. A new or changed file transfers in the appropriate direction. Deleting a previously synced, otherwise unchanged file removes its counterpart on next sync. Edit/delete conflicts retain the edit. Different edits to the same filename keep the desktop name plus a deterministic `name (phone conflict <hash>).ext` copy on both sides. Initial same-name/different-content files are also preserved as conflicts. Renames behave as deletion plus addition. A different/recreated directory identity starts a fresh comparison rather than inheriting old deletions. Do not delete `.pageborne/library.json` to clear a transfer cache.

Every version observed by sync is copied into `.pageborne/history/<SHA-256 of filename>/`. `name.json` records its original filename; each `checksum.ext` contains the original bytes. To recover, copy the desired version back into the library root with its original name, then sync. History is retained until removed manually. Files deleted on the desktop before Pageborne ever sees them cannot be recovered by Pageborne. Reading positions, bookmarks, Ask sessions and device settings remain local; this synchronizes original documents, not phone preferences or PDF caches. Ask adds derived files only for papers that are opened and queried, without preparing every PDF during a library sync.

When `librarySync: 1` and `documentSnapshots: 1` are available, Ask shares a missing original into the library without overwriting an existing desktop file. Each question uses immutable, checksum-named original/reflow/index files under `.pageborne/reflow/<filename hash>/`. Matching originals are copied from archived library history without another client upload; a reader version not yet saved there is uploaded in chunks. Changes to the desktop root during upload or reply generation cannot invalidate those snapshots. Only actually matching/shared originals update the sync baseline, preserving later conflict detection. Library identity and safe filenames are validated; session links and working directories do not change. Snapshot manifests have a separate suffix so upgrading an existing conversation introduces its stable paths even when the content revision is unchanged. Old manifests and uploads remain untouched. Older clients/extensions retain the original sync-first behavior and cannot overwrite a differing desktop copy.

Authenticated routes, mounted inside the existing Terminal `/api` router:

- `GET /pageborne/library`: `{version:1, id, directory, files:[{name,bytes,sha256}], skipped}`. Also saves recoverable copies of observed versions. Optional `?name=filename` checks just the current Ask paper.
- `POST /pageborne/library/status`: `{file}` returns resumable byte offset.
- `POST /pageborne/library/chunk`: `{file,offset,data}` accepts at most 768 KiB of base64-decoded bytes. Repeated identical chunks are safe; complete content must match its checksum.
- `POST /pageborne/library/commit`: `{file,expected}` publishes the verified upload. `expected` is the previous checksum, or `null` for a new name. Concurrent server requests are serialized per target; changed counterparts return HTTP 409.
- `POST /pageborne/library/read`: `{name,sha256,offset}` returns a bounded base64 chunk for that exact version.
- `POST /pageborne/library/remove`: `{name,expected}` archives and removes that version; changed counterparts return HTTP 409.

The paper-file routes also accept `library:{name,sha256}`. They validate that original and return its actual root path, using the hidden reflow directory for derived files. They never accept an arbitrary upload path. The earlier `workspace` destination is retained for older clients. These routes stay behind the same pairing-token authentication, CORS and transport as Terminal; there is no extra sync daemon or credential. Direct filesystem editors do not participate in the server's locks: finish edits before pressing Sync. Hash checks detect edits during transfer; retry a reported conflict.

Limits match the reader: 16 MiB per PDF, 4 MiB per text file, 1 GiB / 1,000 documents on the phone. Startup reads document metadata only; file contents load on demand, and sync hashes are saved per revision. The original 64 MiB library migrates automatically, preserving reading identities. The final phone size is checked before transfers; changed files commit individually. Cancellation/network or storage failure keeps completed work, resumes partial uploads next time, and never installs an incomplete downloaded document. The phone's replacement journal preserves its prior file until the new body and index commit.

Validation: `npm test` covers reconciliation, deletions/history, conflict recovery, checksums/resume, stale writes, traversal, symlink/hardlink rejection, phone storage failures and Ask path sharing. `npm run test:library-sync` uses authenticated HTTP and a simulated Even bridge for picker holds, multi-file PDF/text transfers, edits, deleting on each side, reloads and cancellation. Use `WEBKIT_PATH=... npm run test:library-sync -- --webkit` for desktop WebKit. Browser checks do not establish physical BLE timing.

## Shared Codex conversation history

The local shared-daemon adapter also supports `conversationSync: 1`. Copy `pageborne-conversation.js` beside `core.js`, call `installConversationSync(router, getProvider)` after provider validation, and merge `conversationCapabilities(provider)` into `/info`'s `pageborne` object. Keep the router behind the existing authentication. Only advertise this when the provider implements `getConversation(sessionId)`.

The Codex implementation attaches to the existing thread, merges recent paginated history and local rollout recovery into its durable `CodexTranscript`, and returns `transcript.snapshot()`. Its dedicated history read may fetch 80 text items; the legacy `getHistory()` ten-message limit remains unchanged. Preserve turn/item IDs and identity aliases in the snapshot. No thread or prompt is created by syncing.

`GET /api/pageborne/conversation?provider=codex&sessionId=...` returns `{version:1, sessionId, state, turns:[{id, aliases, marker?, question, answer, state}]}`. Turn state is `pending`, `complete` or `error`; the top-level state is the provider status. Only user and assistant text is included. Recognized Pageborne passage/prompt wrappers are removed from displayed questions; tool output and system instructions are excluded. Recent entries retain stable IDs, including repeated/steering questions; commentary and final text following a question share its answer. The response keeps at most 40 entries and 100,000 total characters, with question/answer caps of 64,000/16,000. Full older history stays in Codex.

Pageborne refreshes the current linked conversation on opening and approximately every four seconds while visible. Unread replies do not stop synchronization. Pending local submissions retain their existing correlation/recovery path and sync history after completion. Matching identities preserve local read anchors and passage links; reconnect/reload backfills missed messages without duplicates. The first history snapshot and older backfills are imported quietly; later new replies and pending replies completing notify. Version 0.8.106 clears false unread flags from previously imported 0.8.105 history. Restoring saved answers or supplementing completed replies with historical commentary does not notify again. Phone and glasses share that retained conversation without automatic view switching. In Ask, Go to latest replaces Go to position in the menu and dismisses older unread navigation without marking unseen frames as physically read. Session bindings, document positions and device preferences are still local: another phone must select the same session to see its shared conversation. Servers without this capability retain the existing latest-reply behavior.

Validation: `test/shared-conversation.test.js` covers wrapper removal, repeats, legacy cache migration, identity aliases and read-only capability gating. `npm run test:ask-sync` covers backfill, unread/offline catch-up, reload, phone/glasses anchors and stale-session responses in Chromium and WebKit. Root Terminal tests cover paginated history and durable live transcript recovery.
# Native Claude sessions

`native-claude.patch` adds opt-in native session creation and shared conversation snapshots to the deployed Even Terminal fork (the 0.8.105 conversation extension must already be installed). Apply from that fork's root with `git apply --check /path/to/native-claude.patch`, then `git apply /path/to/native-claude.patch`. The patch was checked against the deployed pre-change source and compared with the running implementation.

Configure the desktop's `.state/pageborne-claude.json` with `{"model":"YOUR_INSTALLED_CLAUDE_MODEL","cli":"/absolute/path/to/claude"}` and restart the bridge. This leaves the general Terminal default provider unchanged. For the private Pageborne build, set `PAGEBORNE_DEBUG_TERMINAL_AGENT=claude` in `.env.debug.local`. Public builds still use the user's connection settings.

New owners run in a private `tmux -L pageborne-claude` server, using normal Claude Remote Control and default permission mode. Their UUID creation keys are reserved under `~/.pageborne/claude-sessions`; retries cannot duplicate an owner or submit a question. The shared library must have completed normal Claude workspace setup. A stopped owner must be reopened on the desktop or replaced explicitly with New session in Ask. Bridge restarts leave owners running. Native mobile/desktop messages sync through the existing authenticated conversation extension, using stable event UUIDs. Existing Codex histories are retained separately, and attaching an existing Claude owner keeps its model and permissions.

## Shared reader links

Copy `pageborne-reader-state.js`, `pageborne-reading-activity.js` and the matching `pageborne-library.js` beside `dist/routes/core.js`, then import `installReaderState` and call `installReaderState(router)` on the existing authenticated API router. Restart only the HTTP bridge, preserving its state directory and pairing token; native Claude/Codex owners keep running.

The reader-state installer also provides authenticated `GET /pageborne/reading-activity` (day/revision index), `GET /pageborne/reading-activity/:day` (events) and `POST /pageborne/reading-activity/:day` (`{entries}`, up to 50 per request). Events merge by UUID; only their discovered session links may grow. They include title, original filename/reading identity, local day, timestamps, word count, dwell, location, a 240-character excerpt and session references, never pairing credentials. Each Terminal instance stores separate atomic daily JSON files in `<library>/.pageborne/reading-activity/<instance-id>/`. Document removal does not remove these files. Old clients and the stock glasses Terminal app are unaffected. Older extensions return 404; Pageborne continues recording locally until the extension is upgraded.

Authenticated `GET /api/pageborne/reader-state` returns the Terminal instance ID, library ID and per-document/model session links. `POST` accepts `{ document, agent, sessionId, cwd?, anchors }`; `document` is a library filename or null for Librarian, and an anchor has `{ id, aliases, position, page? }`. Coordinates merge by stable question identity without replacing another device's older questions. No question/answer text, pairing token or model weights are saved in this metadata.

Terminal identity persists in `$EVEN_TERMINAL_STATE_DIR/pageborne-instance.json`. Metadata is atomically stored in `<library>/.pageborne/reader-state/<instance-id>.json` with owner-only permissions, separately for each instance. Keep the instance file when moving the same Terminal installation. Copying just a library to a different instance does not activate the old links. Old session records are retained when another session is linked, and Claude and Codex use separate records. The first linked session is the initial default for a fresh device; explicit local session selections remain local. Existing device-only links migrate once into the instance/library namespace. Full conversation contents are still obtained from the existing shared-session conversation endpoint.
