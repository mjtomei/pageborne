// This entry is built only for the desktop service. Phone OCR is unchanged.
import { PdfDocument } from '../../src/pdf.js';
import { packPdfPreparation, pdfPreparationKey, PDF_PREPARATION_VERSION } from '../../src/pdf-cache.js';
import { version } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { base64ToBytes } from '../../src/binary.js';
import { renderPdfPage } from '../../src/pdf-render.js';
import { pdfColorProfile } from '../../src/pdf-colors.js';
import { pdfAnalysisViewport, pdfSourceTransform } from '../../src/pdf-orientation.js';

window.desktopPdfInfo = { version, preparationVersion: PDF_PREPARATION_VERSION };
window.prepareDesktopPdf = async ({ content, settings, batchSize = 1, checkpointOnly = false }) => {
  const reader = new PdfDocument();
  const originalRead = reader.readPageText.bind(reader);
  const originalPrepare = reader.preparePageContents.bind(reader);
  const ready = new Map();
  const fallbacks = new Map();
  const remember = page => {
    if (page.fallback?.code === 'ocr-output-limit') fallbacks.set(page.number, page.fallback);
    if (page.turn) reader.pageTurns.set(page.number, page.turn);
    ready.set(page.number, page.extracted);
  };
  reader.preparePageContents = async (number, settings) => {
    if (!fallbacks.has(number)) return originalPrepare(number, settings);
    // Keep the complete original page in one glasses pane / gallery image.
    // The checkpoint still contains geometry for audits and a future repair.
    const { canvas, page, viewport } = await reader.renderAnalysisPage(number);
    const bounds = { x: 0, y: 0, width: canvas.width, height: canvas.height };
    const block = { ...bounds, kind: 'figure', fullPage: true, lines: [], text: '' };
    if (settings.normalizeColors) block.colorProfile = pdfColorProfile(
      canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
    const turn = reader.pageTurns.get(number);
    if (turn) Object.assign(block, { turn, pageRotation: viewport.rotation,
      sourceTransform: pdfSourceTransform(pdfAnalysisViewport(page), viewport) });
    reader.marginMasks.set(number, []);
    reader.warnings.push(`Page ${number}: OCR reached its output limit; the original page is shown as an image.`);
    return { page: { number, width: canvas.width, height: canvas.height, bounds,
      blocks: [block], annotations: [], columns: false, marginMasks: [] }, endMatter: settings.endMatter };
  };
  reader.readPageText = async (number, reflow, progress) => {
    // An explicit layout-only replay must never silently fall through to OCR.
    // Existing Roman hints remain available; no new recognition is scheduled.
    if (checkpointOnly) reader.ocr.recognizeRomanHeading = async () => null;
    if (ready.has(number)) { const page = ready.get(number); ready.delete(number); return page; }
    const pending = [];
    for (let n = number; n <= Math.min(reader.pdf.numPages, number + batchSize - 1); n++) {
      await window.desktopProgress({ stage: 'recognizing', page: n, pages: reader.pdf.numPages });
      const cached = await window.desktopPageRead(n);
      if (cached) {
        remember(cached); continue;
      }
      if (checkpointOnly) throw new Error(`Missing OCR checkpoint for page ${n}; no recognition was started.`);
      const extracted = await originalRead(n, reflow, progress);
      if (reader.ocrFailed) throw new Error('Desktop geometry OCR failed; preparation will retry.');
      const turn = reader.pageTurns.get(n) || 0;
      let png = null;
      if (reflow && extracted.needsOcr) {
        const page = await reader.pdf.getPage(n);
        const base = page.getViewport({ scale: 1, rotation: (page.rotate + turn) % 360 });
        const viewport = page.getViewport({ scale: 2048 / Math.max(base.width, base.height), rotation: base.rotation });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        try {
          await renderPdfPage(page, { canvas, viewport, background: '#fff' }).promise;
          png = canvas.toDataURL('image/png').split(',')[1];
        } finally { canvas.width = canvas.height = 1; page.cleanup(); }
      }
      pending.push({ number: n, extracted, turn, png });
    }
    if (pending.length) for (const page of await window.desktopPageBatch(pending)) remember(page);
    const page = ready.get(number); ready.delete(number); return page;
  };
  try {
    const layout = await reader.open(content, settings.mode, () => {}, settings);
    if (reader.ocrFailed || reader.headingOcrFailed) throw new Error('Incomplete desktop OCR.');
    const key = await pdfPreparationKey(base64ToBytes(content), settings, version);
    return { key, saved: packPdfPreparation(layout, reader.marginMasks, reader.pageScales), warnings: reader.warnings };
  } finally { await reader.destroy(); }
};
