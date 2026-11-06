# Desktop library OCR

This optional Linux/NVIDIA daemon prepares scanned library PDFs with
[Xiaomi-OCR-0](https://huggingface.co/xiaomi-research/Xiaomi-OCR-0). The phone
keeps its existing OCR implementation and can read without the daemon. A
completed desktop preparation is downloaded when the matching PDF is opened,
then cached on the phone for offline reading. Reopen a document to pick up a
new preparation; a background result never changes the layout while reading.

The daemon uses the same PDF layout, running-header removal, reflow, annotation
gallery and whole-image handling as the glasses reader. Digital PDFs with usable
text keep their embedded text. For scans, Tesseract provides word geometry and
Xiaomi provides a second transcription, using its upstream prompt. A conservative
alignment pass transfers supported word and capitalization corrections onto that
geometry. Agreement also contributes to the layout acceptance score, while the
original OCR confidence is retained separately. Matching paragraph boundaries
and overlapping underline-damaged text boxes are repaired before reflow.
Unaligned words, tables and figures are preserved. This is not yet a
complete replacement of Tesseract with Xiaomi: missing words without reliable
geometry can remain missing, and ambiguous pages can still fall back to an image.
Raw Xiaomi output is saved with each page for inspection and future improvements.
The worker supports `checkpointOnly: true` for CPU-only layout regression and
rebuilds. It fails on any missing checkpoint instead of starting recognition;
the desktop browser test exercises both replay and this failure path. Old
recognition must be explicitly selected and checked against the source PDF and
model configuration when migrating between cache namespaces.

## Setup

Use a Linux desktop with a supported NVIDIA GPU, Node 22.13+, Python, and a
CUDA-compatible PyTorch installation. These instructions are for the optional
desktop service; they do not install a model on the phone.

1. Install the repository's npm dependencies, including development dependencies,
   and build the worker:

   ```sh
   npm ci
   npm run build:ocr
   npx playwright install chromium
   ```

   An existing Chrome installation can instead be selected with `chromePath` in
   the private config.

2. Create a Python environment outside Git, install the appropriate CUDA PyTorch
   build for your machine, then install `desktop/ocr/requirements.txt`. Download
   the original model, processor and tokenizer files from Xiaomi's model
   repository into a private directory. Retain its `LICENSE` and third-party
   notices. This integration does not redistribute the weights. Model loading
   is local-only; the daemon never downloads weights while processing a PDF.

3. Copy `config.example.json` to `.state/desktop-ocr.json` (Git ignores `.state`).
   Set absolute paths for `libraryDir`, `python` and `modelPath`, and the SHA-256
   of `model.safetensors`. Verify this against the downloaded revision's checksum,
   rather than accepting an unverified download. Start with `batchSize: 1` and
   `gpuMemoryGiB: 4`. Optional `priority` is an array of library filenames.

4. Install the matching `integrations/even-terminal/pageborne-library.js` on your
   existing library server. It adds the authenticated
   `POST /api/pageborne/library/preparation` route. Older servers remain compatible
   with ordinary reading but cannot supply desktop preparations. Build/install
   the Pageborne client from the same revision. No additional phone-facing port
   or credentials are introduced.

5. Copy `pageborne-ocr.service.example` to
   `~/.config/systemd/user/pageborne-ocr.service`, replace its absolute paths,
   and run `systemctl --user daemon-reload`. Start the service manually first:

   ```sh
   systemctl --user start pageborne-ocr
   journalctl --user -u pageborne-ocr -f
   ```

   The service's `flock` prevents duplicate workers. Keep the process memory and
   swap limits. Only enable automatic startup after validating your machine.
   A model failure stops processing and requires an explicit restart; it does
   not repeatedly reload CUDA. To stop: `systemctl --user stop pageborne-ocr`.

## Scheduling, memory and recovery

The service scans the library every 30 seconds. Requested formatting variants
take priority, followed by configured priority documents and recent additions.
It starts new work only below 70% system RAM use with at least 22 GiB physically
free. Separate Node and Python watchdogs stop its own processes at 76% RAM use
or less than 12 GiB physically free, leaving headroom below the 80% ceiling.
Linux `MemAvailable` is used for the utilization measure; the physical-free check
is additional headroom for unified-memory GPUs. The service uses no swap.

Batch size is limited to 1–4, defaulting to 1. The PyTorch allocator defaults to
4 GiB and cannot be configured above 6 GiB. On the tested GB10, batch 4 improved
throughput over 1, but batch 8 regressed and was running during two system freezes.
Larger batches are therefore disabled. These limits reduce risk; neither cgroups
nor the PyTorch allocator can guarantee recovery from a GPU-driver hang or cap
allocations made by other applications.

Completed page results are atomically saved and reused after restart. When a
healthy model reaches its token or generation-time budget, that page is saved
as an explicit image fallback: its incomplete transcription is discarded, its
original page stays whole in the reader/gallery, and its geometry and reason
are retained for later repair. Other pages and documents continue using the same
model process. The daemon logs `ocr-page-fallback`; completed artifacts include
the page warning. This does not raise the token, time, memory or batch limits.
Memory watchdog stops, unexpected exits, malformed results and outer inference
timeouts remain fatal and require an inspected restart. The original PDF
stays unchanged. The cache identity includes the source bytes, model weights and
processor configuration, worker/preparation code, and requested reading settings.
Changing a PDF or layout format cannot reuse an incompatible preparation.

Derived files live in the library's private `.pageborne/ocr/` directory:

- `daemon.json`: current document, page, phase and heartbeat.
- `<engine>/pages/<source-sha>/<page>.json`: resumable geometry and raw model output.
- `<engine>/prepared/`: completed reader layouts, served in verified chunks.
- `<engine>/failures/`: bounded error descriptions and per-document retry time.
- `telemetry/`: flushed memory samples, rotated at 4 MiB with bounded old logs.

No partial layout is served by this API. Until a complete preparation is ready,
the phone uses its existing progressive OCR. Complete downloads are validated and
cached; an unavailable desktop, corrupt response or changed document falls back
to local reading. Completed preparations have no fixed file-size or transfer
cap. The server serves bounded chunks, reusing a checksum only while the file
is unchanged. The phone's cache budget evicts older preparations; a book larger
than that budget is kept on its own. Available storage and browser memory still
determine whether a particular device can open and retain a large preparation.

An intentional OCR worker shutdown after a document error does not poison the
next job. Unexpected model exits and inference timeouts still stop the service
for inspection rather than repeatedly restarting CUDA.

## Tests

```sh
npm run test:ocr
npm run build:ocr
CHROME_PATH=/path/to/chrome node scripts/desktop-ocr-browser-test.mjs
```

The browser test processes an original synthetic scan, interrupts and resumes
preparation, and downloads the result through the library API into the phone
cache. Its model responses are fixtures: it uses no GPU and is not an OCR
accuracy benchmark. Python tests cover conservative word correction and killing
a child process under simulated memory pressure without allocating excess RAM.

## Chapter detection checks

Chapter metadata is versioned separately from OCR and page layout. Updating the
chapter detector rebuilds this metadata from saved page recognition, including
pages displayed as full-page images. It does not rerun the model or change the
reading content. The phone requests an upgraded desktop artifact once when its
cached navigation is older. Publisher PDF bookmarks retain priority.

For derived navigation, the detector requires heading geometry on both sides of
a line, recognizes left-aligned numbered headings and nested section numbers,
and reads printed contents from OCR word boxes. Contents references are matched
to actual headings. A page offset can resolve an image-only destination only
when at least three independent heading matches agree; inconsistent pagination
leaves the reference unresolved. Missing OCR dots are repaired only with a
unique continuation of the preceding section number. Repeated numbers with
different titles are retained and flagged, since the source itself may repeat a
number.

Preparations store a `navigation.sanity` report; phone debug logs include a
`pdf-navigation-check` event. Checks flag invalid or backward destinations,
duplicate headings or section numbers, prose-like derived titles and unresolved
printed contents. These are review signals, not a claim of complete detection.
The unit suite includes synthetic scanned-textbook geometry, cross-references
inside prose, nested headings, page-offset conflicts and metadata cache upgrades.

Audit completed preparations without loading OCR models or writing the cache:

```sh
npm run audit:pdf-navigation -- --root /path/to/library/.pageborne/ocr/ENGINE \
  --output /private/path/navigation-report.json
```

Optional `--expect /private/path/expectations.json` checks known document
regressions. Keys are PDF source SHA-256 values; each value may contain
`chapters` (physical PDF page numbers), `entries` (`title`, `page`, optional
`level`), and `noIssues: true` or an exact `issues` list. Keep source PDFs,
expectations and reports with private library data, outside Git.

## Text left as images

The desktop daemon also compares final reading blocks against the saved text
from **before** layout. A full-page fallback no longer contains text boxes, so
checking only those final boxes would miss this failure. Each completed
preparation stores `layout.reflowSanity`, and the daemon emits a
`pdf-reflow-check` event when it first audits a new or existing preparation.
This audit reads checkpoints one page at a time; it never starts recognition,
changes layout, or needs a GPU. Missing checkpoints make the audit incomplete.

It flags full-page images containing substantial recognized prose, short prose
continuations and contents lists; pages where most recognized text remains in
image blocks; and recognized prose with no reading blocks. Reports give physical
PDF page numbers, recognized and reflowed word counts, and confidence/structured
content evidence. Sparse covers and labels are not flagged just for having text.
Tables, diagrams and screenshots can legitimately trigger review, especially
when mixed with prose. A flag is not proof that all of the page can safely be
reflowed, and it never removes an original image or forces uncertain text into
the reader.

Audit the entire completed library without rendering PDFs or writing the cache:

```sh
npm run audit:pdf-reflow -- --root /path/to/library/.pageborne/ocr/ENGINE \
  --output /private/path/reflow-report.json
```

Add `--strict` to fail on any flagged page. For regression checks, pass
`--expect /private/path/reflow-expectations.json`. Each source SHA-256 maps to:

```json
{
  "PDF_SOURCE_SHA256": {
    "mustReflow": [12, 16],
    "imagePages": [1, 2, 85],
    "knownIssues": [{ "page": 85, "code": "text-page-as-image" }]
  }
}
```

This fails for a newly rasterized page, lost expected text, a new warning,
missing recognition or an unaccounted-for document. Fewer image pages are allowed
as fixes land. Known issues stay visible in the report and still fail `--strict`;
recording a baseline does not declare existing bugs fixed. Keep actual source
hashes, reports and book-specific expectations private. Synthetic unit and
command-line tests cover these checks in the public test suite.
