# Compatibility and optional integrations

This release separates a standard reader from optional desktop integrations. It does not claim that custom Terminal routes or provider session-sharing mechanisms are part of the standard Even Hub API.

| Feature | Requirement | Without it |
| --- | --- | --- |
| G2 document import/reading | Even host and pinned Hub SDK 0.0.14; manifest minimum app 2.2.9 | Browser preview for development |
| Local voice | Bundled WASM workers, first-use model download, supported device memory/browser | Typed Ask remains available after setup |
| Basic Ask desktop session | Configured authenticated Terminal API | Reader works; Ask can also use a direct API connection |
| File attachments/workspaces | Server advertises matching Pageborne capabilities | Current passage text through the basic connector |
| Shared library/Librarian directory | Pageborne library/workspace extension | Import documents locally; no desktop library sync |
| Full conversation sync | Conversation extension and provider transcript reader | Basic reply tracking; no guarantee of messages sent elsewhere |
| Shared passage/chat links | Reader-state extension on the same Terminal instance/library | Links remain local |
| Desktop/mobile shared-library hosting | Shared reader plus hosting server and compatible Terminal extensions | No standalone static deployment |
| Native Claude session creation | Custom fork patch and matching desktop tooling | Select an existing supported session |

The client checks advertised `/api/info` capabilities before using custom routes. [Integration instructions](integrations/even-terminal/README.md) describe the helpers and registration points. The historical `native-claude.patch` targets a customized fork based on Terminal 0.8.1; it is **not** a universal patch for arbitrary upstream versions. Run `git apply --check` and review/adapt it to your server. Choose a model supported by your installed CLI; no model entitlement is provided here. The entire custom Terminal/provider stack is not bundled in this repository.

Native text brightness and menu fields exist in the pinned SDK's types. Their visible behavior and capacity still depend on the host/firmware. This project retains native fonts, limits uncertain-word dimming to available containers, and does not include the temporary brightness experiment.

## Experimental account adapter

The optional AI bridge retains its legacy ChatGPT account adapter for existing deployments. It is disabled in the CLI unless `PAGEBORNE_EXPERIMENTAL_CHATGPT=1`; new bridge configs default to `openai-compatible`. Live account sign-in/inference compatibility was not verified for this release. This adapter is not needed for reading, local transcription, configured API providers or Terminal sessions. Logout remains available without opt-in to clear an existing setup.

## Validation boundaries

Unit tests and mocked native/API tests establish protocol behavior, not device or service certification. Browser suites run Chromium and desktop WebKit. Historical physical-phone observations are identified in the [Browser STT engineering and evaluations](https://github.com/mjtomei/browser-stt#engineering-and-evaluations). The GitHub preparation does not certify a new Even firmware release or a current third-party provider version.
