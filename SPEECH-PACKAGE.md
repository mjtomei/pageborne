# Browser STT integration

Speech inference, streaming, ensemble voting, model caching and verification belong to the separate [Browser STT repository](https://github.com/mjtomei/browser-stt). Its [README](https://github.com/mjtomei/browser-stt#engineering-and-evaluations) now owns the engineering report and recorded evaluations.

Pageborne depends on a reviewed Git commit of `@pageborne/browser-stt` in `package.json` and `package-lock.json`. `npm ci` fetches that source and runs its `prepare` lifecycle to build browser workers. No engine tarball lives in this repository. Model weights still download on first voice setup and remain device-local; installing/building the source does not redownload model weights on the phone.

Use Node 22.13+ and Git, and allow npm lifecycle scripts. The standalone engine carries its source, types, pinned compiled Sherpa runtime and upstream notices. Worker builds do not require Emscripten; rebuilding the native WASM dependency is documented there.

## Updating the dependency

Publish the reviewed Browser STT commit first, then run:

```sh
npm install 'git+https://github.com/mjtomei/browser-stt.git#FULL_COMMIT_SHA'
npm test
npm run build:debug
npm run pack:release
npm run test:build-profiles
```

Commit both package files. A fixed revision makes builds repeatable; normal installs do not follow a moving branch. To develop locally, clone Browser STT alongside this project, run `npm ci` there, then temporarily use `npm install --no-save --package-lock=false ../browser-stt`. Rebuild the engine after source edits. Do not commit that local override.

Pageborne selects `modelIds: ['fluid-mini']` with `miniAcceleration: 'auto'` and retires only the superseded three speech models and their setup receipts. Mini uses the pinned ONNX implementation, retaining multi-thread CPU when available and trying WebGPU otherwise with a fresh CPU fallback; its upstream attribution is in README.md and LICENSING.md. Original documents, reading history and chats are untouched.

Pageborne owns the microphone/display integration, context vocabulary ranking and review/send UI. It imports the engine through its public package API. Native storage adapters remain in Pageborne; the engine also supports ordinary browser storage.

## Consumer checks

```sh
PAGEBORNE_TEST_MODEL_DIR=/absolute/path/to/models npm run test:speech:verification
PAGEBORNE_TEST_MODEL_DIR=/absolute/path/to/models npm run test:speech
```

The production verification check uses `fluid-mini.json`; the older ensemble benchmark uses `ensemble-models.json`. Keep their model directories and filenames intact. The full speech suite also uses audio from `BROWSER_STT_RESEARCH=/absolute/path/to/browser-stt`. Browser fixtures and reports are distinct from physical-phone measurements. Third-party notices remain in the installed dependency and built app assets; see [notices](LICENSING.md).
