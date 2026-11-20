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
