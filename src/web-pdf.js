import { getDocument, PDFWorker, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readingWords } from './reading-activity.js';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker&inline';
import { LocalPdfResources, PdfDecoderFallbacks } from './pdf-resources.js';
import { base64ToBytes } from './binary.js';
import { readPdfText } from './pdf-text.js';
import { renderPdfPage } from './pdf-render.js';

// Original pages for browser reading. No OCR, column splitting, or glasses
// reflow. Pixels exist only for the pages currently near the viewport.
export class WebPdf {
  constructor() { this.tasks = new Map(); this.closed = false; }
  async open(content) {
    this.port = new PdfWorker();
    const workerFailure = new Promise((_, reject) => {
      this.port.addEventListener('error', event => reject(new Error(event.message || 'The PDF worker could not start.')));
      this.port.addEventListener('messageerror', () => reject(new Error('Could not read the PDF worker response.')));
    });
    this.worker = new PDFWorker({ port: this.port });
    this.decoderFallbacks = new PdfDecoderFallbacks();
    this.task = getDocument({ data: base64ToBytes(content), worker: this.worker,
      BinaryDataFactory: LocalPdfResources, wasmUrl: this.decoderFallbacks.wasmUrl, useWorkerFetch: false, isEvalSupported: false,
      enableXfa: false, cMapPacked: true, canvasMaxAreaInBytes: 16_000_000 });
    this.task.onPassword = () => { this.passwordError?.(new Error('Remove the PDF password before opening it.')); };
    this.pdf = await Promise.race([this.task.promise, workerFailure, new Promise((_, reject) => { this.passwordError = reject; })]);
    const blocks = []; let y = 0;
    for (let number = 1; number <= this.pdf.numPages; number++) {
      if (this.closed) throw new Error('PDF closed.');
      const page = await this.pdf.getPage(number), viewport = page.getViewport({ scale: 1 });
      const height = viewport.height * 552 / viewport.width;
      blocks.push({ index: number - 1, kind: 'image', page: number, y, height, x: 0, width: viewport.width,
        sourceY: 0, sourceHeight: viewport.height, sourceWidth: viewport.width, scale: 552 / viewport.width, text: '' });
      y += height + 16;
    }
    this.layout = { format: 'pdf', blocks, rows: [], blockY: blocks.map(b => b.y), pages: blocks.map(b => b.y), height: y,
      maxY: Math.max(0, y - 288), width: 552, headings: blocks.map(b => ({ text: `Page ${b.page}`, index: b.index, y: b.y })),
      preparation: { complete: true, totalPages: blocks.length, readyPages: blocks.length } };
    await this.text(1);
    return this.layout;
  }
  text(number) {
    this.textRequests ||= new Map();
    if (!this.textRequests.has(number)) this.textRequests.set(number, this.loadText(number).finally(() => this.textRequests.delete(number)));
    return this.textRequests.get(number);
  }
  async loadText(number) {
    const block = this.layout?.blocks[number - 1];
    if (!block || block.textLoaded || this.closed) return;
    const page = await this.pdf.getPage(number), text = await readPdfText(page);
    if (!this.closed) {
      const viewport = page.getViewport({ scale: block.scale });
      block.readingItems = text.items.flatMap((item, index) => {
        const words = readingWords(item.str); if (!words || !item.transform) return [];
        const t = Util.transform(viewport.transform, item.transform), height = Math.hypot(t[2], t[3]);
        return [{ key: `pdf:${number}:${index}`, words, text: item.str, page: number, y: t[5] - height, height }];
      });
      block.text = text.items.map(item => item.str || '').join(' '); block.textLoaded = true; this.layout.textRevision = (this.layout.textRevision || 0) + 1;
    }
  }
  async render(number, canvas, width) {
    const page = await this.pdf.getPage(number);
    if (this.closed || !canvas.isConnected) return;
    const original = page.getViewport({ scale: 1 });
    const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(4_000_000 / (width * width * original.height / original.width)));
    const viewport = page.getViewport({ scale: width / original.width * ratio });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    // Let PDF.js request its own CPU canvas options before any getContext call.
    // A default accelerated context misrenders resumed text batches in WebKit.
    const task = renderPdfPage(page, { canvas, viewport });
    this.tasks.set(canvas, task);
    try { await task.promise; } finally { this.tasks.delete(canvas); }
  }
  cancel(canvas) { this.tasks.get(canvas)?.cancel(); }
  async destroy() {
    this.closed = true;
    for (const task of this.tasks.values()) task.cancel();
    await Promise.allSettled([...this.tasks.values()].map(task => task.promise));
    await this.task?.destroy().catch(() => {});
    this.port?.terminate();
    this.decoderFallbacks?.destroy();
  }
}
