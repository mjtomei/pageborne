## Mini CPU threading — 2026-11-23

Version 0.8.172 pins Browser STT 0.1.22 at `ec131dc6e515b51e3f4cdb78b8a7e4ccde2de865`. Mini retains SIMD and uses up to four CPU threads in isolated/shared-memory hosts, with a one-thread fallback. The private web server supplies isolation headers; the embedded Even host controls its own headers. Debug logs and enabled recording metadata include actual worker thread counts. GPU execution is not enabled, model weights are unchanged, and the existing Ask preload remains in use. The engine rechecks Mini for the changed inference configuration without redownloading intact weights.

725 unit tests pass with one existing skip. Debug/release packages, the web build, public/private profile checks, and source/built audits pass. Installed engine source and the Mini manifest match the pinned revision.

The real AskUI/display-queue regression passes in Chromium and WebKit, including prewarming, cancellation, PDF priority, remote/paused voice settings and immediate latest/final text delivery. Six built-web cases (both browsers at phone, tablet and desktop sizes) pass with isolation enabled, covering Markdown/PDF reading, full screen, synchronized Ask and recoverable startup requests. Public and private build settings remain separate.

The web check uncovered a preload problem: PDF opening waited for a missing voice-model download. Reading now cancels preparation still in the download stage; initialization already using memory retains its existing completion/unload guard. The regression deliberately stalls model downloads and requires the PDF to open. Polling assertions allow multiple four-second polling intervals rather than racing a five-second test deadline.

Actual four-thread Chromium/WebKit inference, native-transcript comparisons, long-stream handling, cancellation and offline reload are recorded in Browser STT's VALIDATION.md. The desktop single-clip probe's roughly threefold throughput gain is not a physical iPhone, first-word, release-delay, memory or battery measurement. Even host thread availability remains unverified on hardware.

## Voice latency — 2026-11-20

Version 0.8.171 starts loading Mini on opening Ask and submits changed live/final transcription text immediately. Existing serialized native calls and latest-frame coalescing remain in use. Preloading yields to the pane, is cancelled by closing it, skips hidden panes and PDF preparation, and respects remote voice/continue-without-voice settings. Model weights, memory settings and saved verification remain unchanged.

725 unit tests pass with one existing skip. The new Chromium/WebKit regression uses the real AskUI, native SDK and frame queue with recognizer/host fixtures. New words enter the queue synchronously (1–5 ms in the fixture), including while an 80 ms display call is outstanding; calls never overlap, and the latest and final reviewed words arrive. It also checks preload cancellation, PDF priority and voice settings. Phone hold/release/cancel/retry and glasses source-routing regression passes. These are browser integration checks, not physical-phone or BLE measurements. Actual Mini inference/streaming checks are recorded separately in Browser STT's VALIDATION.md.

Final pinned Browser STT 0.1.21 revision `b184c49833a101f539003c55f028828d7a7f08b1` matches installed source/model manifests. Debug/release packages, web build, source/built audit and public/private profile isolation pass. Ask followups, voice during a reply, recording collection, reconnection and no-automatic-resend regression passes. The new latency regression is included in CI.

# Publication checks — 2026-10-24

The shared source supports release glasses builds, explicitly configured debug
builds, and the phone/tablet web reader. Private settings remain in ignored
local configuration. These checks cover the publication preparation snapshot;
they do not represent a new physical-glasses or phone certification.

- Pageborne unit tests: 491 passed, one existing FFmpeg-dependent test skipped.
- Release package, web build and debug build: passed using the source-built
  Browser STT dependency pinned in the lockfile.
- Build-profile browser checks: passed with private debug configuration present.
  Release has no automatic Terminal connection or diagnostic storage calls.
- Built web reader: Chromium and WebKit at phone and tablet sizes, all four
  cases passed, including startup-request recovery, PDF/Markdown, chat and keyboard.
- Source and public artifact scans: passed, including decompressed web assets.
  No private deployment configuration/token was copied into public builds.
- License resources: verified the complete Liberation font source archive,
  Eigen source-availability notice, runtime notices and separate wordfreq data
  are present in release, web and debug outputs. Native sharp/libvips is absent
  from actual bundled browser modules.
- Browser STT: 136 unit tests, strict API types, full/CPU builds and real-model
  Chromium/WebKit ensemble smoke checks passed. Runtime/model identity is
  unchanged; the engineering report and fixture summaries live in its repository.

The [third-party review](LICENSING.md) records the unresolved upstream notice
omission in `@evenrealities/pretext` and the external packaging CLI's metadata
gap. Neither has been silently assigned a license or invented copyright notice.

## Final public dependency and source snapshot

Browser STT revision `9ab003685b66ca3baf9b24b8dc565949840d27cd` was
installed directly from its public GitHub repository. Its WASM and CPU ensemble
worker match the versions exercised with real models in Chromium and WebKit.
The Sherpa runtime removes private compiler paths without changing model or
verification identity.

With that dependency, 491 units passed with the existing one-test skip; release
packaging, web/debug builds, profile isolation and all four built-web
Chromium/WebKit phone/tablet cases passed again. This profile run used default
configuration; the earlier configured-debug isolation result remains above.
The public source/build audit passed, and an additional scan of 205 public
artifact files found no known private credentials, deployment hosts, local
paths or personal email. Upstream copyright contacts and ONNX Runtime's public
CI build paths remain third-party metadata. Publication commits use a GitHub
noreply identity and exclude the original development history.
