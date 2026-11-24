import { renderPdfPage } from '../../src/pdf-render.js';
import { normalizePdfColors, pdfColorProfile } from '../../src/pdf-colors.js';
import { pdfAnalysisViewport, pdfQuarterTurnNeeded, pdfOcrScore } from '../../src/pdf-orientation.js';

export class NanoOcr {
  constructor(fallback, recognize, warning) { Object.assign(this, { fallback, recognizeImage: recognize, warning }); this.results = new Map(); }
  async recognize(page, viewport, key, progress) {
    try {
      let result = await this.recognizeTurn(page, viewport, 0);
      const originalText = result;
      let turn = 0;
      if (pdfQuarterTurnNeeded(result)) {
        let score = pdfOcrScore(result);
        for (const candidate of [90, 270]) {
          const text = await this.recognizeTurn(page, pdfAnalysisViewport(page, candidate), candidate);
          const next = pdfOcrScore(text);
          if (next.letters >= 60 && next.quality > score.quality + 10 && next.score > score.score * 1.3) {
            result = text; score = next; turn = candidate;
          }
          if (turn && score.quality > 50) break;
        }
      }
      this.results.set(page.pageNumber, { model: 'OCRia-nano-1', backend: 'cpu', geometry: 'lines' });
      return { text: result, turn, ...(turn ? { originalText } : {}) };
    } catch (error) {
      if (this.destroyed) throw error;
      this.warning(`Page ${page.pageNumber}: Nano unavailable; using fallback OCR.`);
      this.results.set(page.pageNumber, { model: 'Tesseract', backend: 'wasm', fallback: 'nano-failed' });
      return this.fallback.recognize(page, viewport, key, progress);
    }
  }
  async recognizeTurn(page, viewport, turn) {
    if (this.destroyed) throw Error('PDF closed.');
    const rotation = (page.rotate + turn) % 360;
    const base = page.getViewport({ scale: 1, rotation });
    const scale = Math.min(250 / 72, 4096 / Math.max(base.width, base.height), Math.sqrt(9_000_000 / (base.width * base.height)));
    const raster = page.getViewport({ scale, rotation });
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(raster.width); canvas.height = Math.ceil(raster.height);
    try {
      await renderPdfPage(page, { canvas, viewport: raster, background: '#fff' }).promise;
      const ctx = canvas.getContext('2d'), pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      normalizePdfColors(pixels.data, pdfColorProfile(pixels.data)); ctx.putImageData(pixels, 0, 0);
      const result = await this.recognizeImage({ number: page.pageNumber, png: canvas.toDataURL('image/png').split(',')[1],
        width: viewport.width, height: viewport.height });
      if (this.destroyed) throw Error('PDF closed.');
      return result.extracted.text;
    } finally { canvas.width = canvas.height = 1; }
  }
  // Preserve measured native Roman hints. Do not start Tesseract just to guess a
  // heading when Nano is in use; fallback pages may use its real glyph checks.
  recognizeRomanHeading(...args) { return this.fallback.recognizeRomanHeading(...args); }
  async destroy() { this.destroyed = true; await this.fallback.destroy(); }
}
