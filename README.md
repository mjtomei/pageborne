# Pageborne

A reader for Even G2 glasses.

- Markdown, plain text and PDF documents
- Hold to speak a question, transcribed on the device ([how it works](https://github.com/mjtomei/browser-stt)), and keep a conversation about what you are reading going in the background
- PDF body text reflowed into native glasses text
- Markdown tables restacked one row at a time for the narrow display
- Figures and tables from PDFs in a gallery on your phone
- Underlined scan text reflowed as prose, with written margin annotations in a separate phone gallery
- Timed autoscroll and speed reading
- Daily reading history with a words-read graph and retained conversation links
- One reading interface for glasses, desktop, phone and iPad, with a full-screen reading view and shared library and conversations

## Reading and conversations

G2 supports native text, PDF reflow/figures, page reading, timed autoscroll and speed reading. PDFs can contain up to 1,000 pages within the 16 MiB file limit. Ready pages become readable while the rest prepare.

**Reading history** in the library shows a daily document-word graph and two time-weighted speeds: documents only, and documents plus Ask. Both accept visible text moved past at 10–900 words/minute, excluding views idle for over five minutes and uncertain background timer gaps. Reading below 100 WPM counts. Ask measures visible questions and answers on acknowledged glasses/preview panes or the clipped phone conversation; composing, recording and activity/status text do not count. Only one surface contributes at a time. Reflowed PDF text counts; image-only pages add no words. This estimates reading, not attention or eye movements.

Every new document/Ask pane exposure is saved **before filtering**, with start/end timestamps, source, location, word count and per-word dwell. Fast flips, image-only panes and idle views stay in the raw log. Adjacent entries remain grouped; expand **Viewing log** for individual intervals and both times, or **Export viewing log** for the complete JSON. Pauses and midnight split exposure intervals; overlapping text keeps a shared identity so it is not counted twice. The history pane also separates qualifying document time from qualifying Ask time for the selected day. Future filter changes can recompute these metrics from retained observations. History recorded before this feature contains only previously accepted readings; skipped older views cannot be recovered. Document deletion preserves history and conversation links.

History starts when this feature is installed, is stored separately from the originals, and remains after document deletion. With the updated optional reader-state extension, it syncs through the desktop library and merges offline entries without duplicates. Linked conversations open in a history viewer even when the source document is gone; the desktop session must still exist and be reachable. Days follow the reading device’s local date.

Each library row shows the estimated time for the full text; the library footer totals all documents, even while filtering. Estimates use your time-weighted average from accepted reading-history entries across devices. Both the footer and Reading History show the document average and a separate average including Ask. Library estimates continue to use document reading alone. Before any qualifying reading, estimates use a labelled 200 wpm default. PDF word counts come from completed local preparation or the updated desktop library extension and persist offline. Missing counts refresh automatically at startup and when opening the library, at most once a minute, using a read-only desktop manifest and matching original-file digests. This never syncs deletions, transfers originals or triggers OCR. Verified counts remain visible for the current session if saving them fails. Unknown counts show a dash and a pending notice; a partial total is marked with `+`. Images do not add words.

Deletion shows progress and any failure beside the confirmation button. Native deletion first discards the unused index copy and records a small deletion intent, then frees the selected original before saving the smaller index. An interrupted deletion resumes on reopening. A confirmed storage refusal can retry after clearing disposable PDF layouts and unfinished voice downloads; timeouts remain guarded because native writes may still finish. Other originals, complete voice models and reading history are preserved. If Even refuses even the deletion intent or cleanup writes, the visible error and debug log identify the failing stage.

An optional [desktop OCR daemon](desktop/ocr/README.md) uses Xiaomi-OCR-0 to prepare scanned library PDFs ahead of reading. Completed preparations sync through the shared library and stay cached on the phone. The existing on-device OCR remains available when the desktop has no matching result.

The library supports **1 GiB of originals across up to 1,000 documents** (16 MiB per PDF, 4 MiB per text file). Startup loads the catalog only; document contents load when opened or needed by sync. Existing files and reading positions migrate automatically. Available device storage still applies.

The library defaults to **Recent activity**: the newest addition, modification or explicit opening comes first. **Newest added**, **File name A–Z** and **Reading time — shortest first** are available on the phone; the glasses picker uses the same choice. Reading time sorts the full text using the same word counts as the estimates, with unknown counts last and file names breaking ties. With even-terminal-patch 0.2.3, desktop addition dates are retained separately from original file modification dates and recovered for already-synced files. Older servers use the phone import date for new downloads; legacy files without dates retain their previous relative order.

Reading totals, time and both WPM averages exclude sessions with only one qualifying text pane. Read at least two distinct panes at 10–900 words/minute for a session to count; pauses over five minutes start a new session. Documents and Ask qualify separately. Every pane remains in the viewing log with its original start/end times, so filters can be changed later. Existing logs are recalculated; older records without session IDs use consecutive document locations and time gaps.

Use **Full screen** (⛶) above the glasses view to fill the device screen. The same pages, PDF reflow, menus, reading modes and Ask view work on every device. Swipe to navigate and use the displayed tap/hold guidance. **Hold to talk** uses the device microphone when supported; release to review, then choose Send. Glasses gestures continue to use the glasses microphone. Browser microphone access requires HTTPS or localhost and permission. Exit with ✕ or Escape; your reading and conversation positions are preserved. On browsers without native fullscreen, the view fills the available browser viewport. Inside the Even app, a portrait viewport uses a rotated landscape view, including touch controls and swipe directions. Outside Even, fullscreen follows normal device rotation.

Markdown and `.txt` files use the same formatting on glasses and the web reader: single newlines within prose flow together, while blank lines separate paragraphs. Headings, lists and fenced code blocks follow Markdown formatting. The stored original stays unchanged.

The glasses menu shows **Contents** when a document has navigable headings. Swipe through chapters and indented subheadings, tap to read, or double tap to cancel. Markdown heading levels 1–6 and PDF bookmarks retain their hierarchy. For PDFs without bookmarks, Pageborne derives sections from printed contents, headings, and OCR chapter/section markers in scanned books, including pages retained as images. Recognition depends on the available text; documents without reliable sections keep **Go to position**. During partial loading, Contents includes only destinations in ready pages. The phone outline shares these destinations, and its percentage slider remains available.

Ask connects to a desktop session you configure; direct API connections are experimental. Optional extensions from the separate [even-terminal-patch](https://github.com/mjtomei/even-terminal-patch) repository add the shared library, conversation histories and passage links to a desktop Terminal server. Claude and Codex keep separate histories for each document. The standard G2 reader can import local Markdown, text and PDF files and read without a desktop connection.

**Even Terminal sessions**, immediately below **Librarian** in the glasses document menu, browses Claude and Codex sessions together, most recently active first. Swipe to choose, tap to open, then hold to dictate and release to review before sending. Tap Back to return to the list; hold there to refresh. It requests up to 100 sessions per provider and displays the list through scrolling native text, independently of the stock Terminal app’s ten-session list. A notice appears when a provider is unavailable or reaches that limit. Existing sessions keep their desktop model, tools and permissions; approvals remain on the desktop. Recent chat history syncs through the conversation extension. Each session has its own local history and draft, separate from document and Librarian links; opening it does not attach the current document.

With even-terminal-patch 0.2.1 or later, shared chats also show dimmed tool actions. With patch 0.2.2, shell commands include longer text and fill up to two lines, with an ellipsis at the end when needed. Older desktop summaries still fit on one line. The original Even Terminal glasses app keeps its existing summaries. Recent actions are retained across devices and reloads, separately from answers; they do not create unread-reply notifications. Activity is bounded to 24 entries and 4,000 characters per question, including optional command detail (up to 1,000 characters per command). Thinking entries are excluded from chat history; live progress still appears in the status indicator.

Dictation uses filenames from the active document's recent chat, including replies still arriving. For example, “todo dot txt” and “agents dot em dee” can become `todo.txt` and `AGENTS.md`. Known filenames supply exact case and separators; common suffixes also work without chat context. This runs locally and honors the context-vocabulary setting.

## Build

Use Node **22.13+** and npm. No private server or credentials are needed to build.

```sh
npm ci
npm test
npm run build          # public/release profile, no private pairing preset
npm run pack           # creates even-reader.ehpk from the release profile
```

Install the package using your Even Hub development/publishing workflow. `app.json` retains the existing application identity so private updates remain compatible; choose your own identity before publishing an independent Hub listing. Branding assets are in [branding/](branding/README.md).

Model weights download on first voice setup (about 249 MB total) and are cached on the device. Inference runtime assets ship with the application. npm fetches a pinned [Browser STT](https://github.com/mjtomei/browser-stt) source revision and builds its workers during installation; no speech-engine tarball is stored here. See [speech package notes](SPEECH-PACKAGE.md). [Third-party notices](LICENSING.md) list the terms for the downloaded models and bundled runtimes.

If Even refuses a storage write during setup, Pageborne clears disposable cached PDF layouts and unfinished model downloads and retries once if space was reclaimed. Original documents, complete voice models, chats and reading history remain saved. PDF layouts will need to be fetched or prepared again. If setup still fails, **Continue without voice** opens the library and typed Ask; use **Retry voice** in Settings when ready. Recovery controls appear above the collapsible model details. **Free cached space** also remains available manually. Native timeouts and inference failures do not trigger automatic cleanup or retries. A storage refusal does not establish the phone's free space or Even's exact app quota.

## Configuring for a custom Even Terminal

If you run the custom Even Terminal from the [even-terminal-patch](https://github.com/mjtomei/even-terminal-patch) repository, this is where its connection settings go. Copy the example to **`.env.local`**, which Git ignores, and put your deployment settings there:

```sh
cp .env.example .env.local
# Edit .env.local with your own origins and paths.
npm run build:debug    # explicit private profile
npm run pack:debug     # private package; can embed the configured pairing token
npm run build:web      # hosting bundle; same reader interface
npm run start:web      # reads .env.local; serves the authenticated web reader
```

Release builds ignore all private debug connection presets, even when `.env.local` exists. Only explicitly configured `PAGEBORNE_RELEASE_ASK_ORIGINS` extend the release network allowlist; users enter their endpoint and token in the app. Runtime web credentials stay on the companion server. **Do not distribute a private debug package.**

[Configuration](CONFIGURATION.md) covers the network allowlist, private pairing, web server and Tailscale setup. [Compatibility](COMPATIBILITY.md) distinguishes standard reading, optional custom Terminal extensions and experimental adapters. [Ask details](ASK-ABOUT-THIS.md) and [PDF details](PDF-READING.md) include implementation notes and historical changes.

## Checks and GitHub preparation

```sh
npm run release:audit
npm run build:debug
npm run test:build-profiles  # Chromium; CHROME_PATH may override its executable
npm run test:web            # Chromium and WebKit; WEBKIT_PATH may override WebKit
# After committing a clean reviewed tree:
npm run release:export -- /path/outside/repo/pageborne-source.tar.gz
```

The export contains the committed source for all build profiles, with no Git history, local config, pairing credentials, models, user documents or built debug packages. Existing development history is not included. The audit checks known private deployment markers and sensitive file types; it is not a general secret-detection guarantee.
