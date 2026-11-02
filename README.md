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
- An experimental phone/iPad web reader that shares the desktop library and conversations

## Reading and conversations

G2 supports native text, PDF reflow/figures, page reading, timed autoscroll and speed reading. PDFs can contain up to 1,000 pages within the 16 MiB file limit. Ready pages become readable while the rest prepare.

**Reading history** in the library shows a daily word-count graph and a page-by-page log with titles, locations, short excerpts and links to desktop conversations. It estimates document reading from visible text and dwell time; Ask conversations are excluded. Words count when you move past them at 10–900 words/minute. Overlapping panes retain their dwell without counting the same exposure twice. Fast paging, image-only views, covered/background web pages and views idle for over five minutes are excluded; intentional rereading counts again. This is an estimate, not eye tracking. Web PDFs need an embedded text layer to contribute words.

History starts when this feature is installed, is stored separately from the originals, and remains after document deletion. With the updated optional reader-state extension, it syncs through the desktop library and merges offline entries without duplicates. Linked conversations open in a history viewer even when the source document is gone; the desktop session must still exist and be reachable. Days follow the reading device’s local date.

An optional [desktop OCR daemon](desktop/ocr/README.md) uses Xiaomi-OCR-0 to prepare scanned library PDFs ahead of reading. Completed preparations sync through the shared library and stay cached on the phone. The existing on-device OCR remains available when the desktop has no matching result.

The library supports **1 GiB of originals across up to 1,000 documents** (16 MiB per PDF, 4 MiB per text file). Startup loads the catalog only; document contents load when opened or needed by sync. Existing files and reading positions migrate automatically. Available device storage still applies.

The library defaults to **Recent activity**: the newest addition, modification or explicit opening comes first. **Newest added** and **File name A–Z** are available on the phone. With even-terminal-patch 0.2.3, desktop addition dates are retained separately from original file modification dates and recovered for already-synced files. Older servers use the phone import date for new downloads; legacy files without dates retain their previous relative order.

Markdown and `.txt` files use the same formatting on glasses and the web reader: single newlines within prose flow together, while blank lines separate paragraphs. Headings, lists and fenced code blocks follow Markdown formatting. The stored original stays unchanged.

The glasses menu shows **Contents** when a document has navigable headings. Swipe through chapters and indented subheadings, tap to read, or double tap to cancel. Markdown heading levels 1–6 and PDF bookmarks retain their hierarchy. For PDFs without bookmarks, Pageborne derives sections from printed contents, headings, and OCR chapter/section markers in scanned books, including pages retained as images. Recognition depends on the available text; documents without reliable sections keep **Go to position**. During partial loading, Contents includes only destinations in ready pages. The phone outline shares these destinations, and its percentage slider remains available.

Ask connects to a desktop session you configure; direct API connections are experimental. Optional extensions from the separate [even-terminal-patch](https://github.com/mjtomei/even-terminal-patch) repository add the shared library, conversation histories and passage links to a desktop Terminal server. Claude and Codex keep separate histories for each document. The standard G2 reader can import local Markdown, text and PDF files and read without a desktop connection.

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

## Configuring for a custom Even Terminal

If you run the custom Even Terminal from the [even-terminal-patch](https://github.com/mjtomei/even-terminal-patch) repository, this is where its connection settings go. Copy the example to **`.env.local`**, which Git ignores, and put your deployment settings there:

```sh
cp .env.example .env.local
# Edit .env.local with your own origins and paths.
npm run build:debug    # explicit private profile
npm run pack:debug     # private package; can embed the configured pairing token
npm run build:web      # phone/iPad web frontend
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
