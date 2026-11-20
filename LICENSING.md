# Third-party notices

Pageborne downloads Fluid Speech Mini at first voice setup; no model weights are included in this repository or its source export. Browser STT's `fluid-mini.json` pins each download by immutable revision, byte length and SHA-256, and the app verifies those hashes before use.

**Fluid Speech Mini by FluidVoice. Built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra.** All three models use [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [Upstream model and attribution](https://huggingface.co/FluidVoice-Labs/fluid-speech-mini-onnx). Model weights are unmodified; Browser STT adapts preprocessing and greedy decoding for browser workers and adds streaming integration. Original license and notice are in `vendor/stt/fluid-mini-LICENSE` and `fluid-mini-NOTICE` in the dependency and copied into built application assets.

The standalone Browser STT dependency retains its optional Conformer CTC Small and Zipformer 20M (Apache-2.0) and Moonshine Base (MIT) APIs and notices. Pageborne no longer downloads or runs those models.

Bundled runtimes and libraries keep their own licenses, and their notices are copied into built assets:

- sherpa-onnx, ONNX Runtime, kaldi-native-fbank and linked components: `vendor/ensemble-runtime` inside the Browser STT dependency
- Transformers.js (Apache-2.0): the Browser STT `NOTICE` describes the adapted session loader
- PDF.js, Tesseract.js with its language data, and jsQR: emitted under `licenses/` by the Vite build
- wordfreq code and data: `vendor/wordfreq`

Preserve these notices when distributing builds.

## Scope of the reviewed obligations

Reviewed 2026-10-24 against Pageborne 0.8.113, its lockfile, vendored data and
built browser assets. No reviewed component requires all Pageborne source to
adopt a single license. The following parts have obligations beyond attribution:

- **wordfreq data:** the derived English frequency table remains CC BY-SA 4.0.
  This applies to the data and its adaptations. The separate table, original
  attributions, transformation description and license are distributed together
  under `licenses/wordfreq/`. See [CC BY-SA terms](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en).
- **Eigen in Browser STT's WASM:** MPL-2.0 applies to covered Eigen files. The
  installed engine includes source download/version/hash information in
  `vendor/ensemble-runtime/SOURCES.md`, copied alongside the runtime. It does
  not relicense separately authored app files. See [Mozilla's explanation](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).
- **PDF.js's Liberation Sans 1.07.4 fonts:** GPL v2 with the Liberation font
  exception. These are not the newer OFL fonts. The unmodified, complete SFD
  sources/build scripts and original notices are included in
  `vendor/licenses/liberation/` and emitted into every build. Font GPL terms
  remain applicable to the fonts; bundling these independent font resources
  does not make Pageborne's application code a font derivative. See
  [PDF.js's exact font provenance](https://github.com/mozilla/pdf.js/blob/v6.3.289/external/standard_fonts/README.md).
- **sharp/libvips:** the lockfile includes optional native LGPL dependencies
  through Transformers.js. Browser builds exclude them and fail if sharp is
  included. Shipping an installed native dependency tree would require a
  separate review of its library source and relinking requirements. See
  [sharp's licensing notes](https://sharp.pixelplumbing.com/install/#licensing).

PDF.js's qcms decoder and wrapper are MIT in this pinned release; OpenJPEG and
JBIG2 carry their accompanying permissive notices. The font requirement above
would not be visible from PDF.js's top-level Apache-2.0 package declaration alone.

## Upstream packaging gaps

`@evenrealities/pretext` 0.1.4 declares MIT in its npm metadata but ships no
license/copyright file or source repository reference. Builds preserve that
metadata in `licenses/bundled/@evenrealities/pretext/package-notice.json`.
The complete upstream copyright/permission notice still needs to be obtained
before treating this attribution item as resolved; no attribution is invented.

`@evenrealities/evenhub-cli` 0.1.14 has no license declaration/file in the
installed package. It is used as an external packaging tool and is not copied
into Pageborne's source export or browser build. Its use does not by itself
apply a license to generated app code; do not redistribute the CLI as part of
Pageborne without clarifying its terms. `qrcode-terminal` lacks the lockfile
field but includes an Apache-2.0 license in its installed package.

`licenses/bundled/manifest.json` records actual bundled npm modules and available
notices for each build. Dependency/version changes require renewed review;
this inventory does not cover unrelated research branches or user documents.
