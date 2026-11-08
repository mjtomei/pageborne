import { getDocument, PDFWorker, Util, OPS, version as pdfjsVersion } from 'pdfjs-dist/legacy/build/pdf.mjs';
import PdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?worker&inline';
import { LocalPdfResources, PdfDecoderFallbacks } from './pdf-resources.js';
import { MAX_PDF_PAGES } from './pdf-limits.js';
import { PdfWork } from './pdf-work.js';
import { reconcilePdfOcr } from './pdf-ocr-consensus.js';
import { pdfScanMarks, pdfUnderlineBlock, pdfScanRuleFragment } from './pdf-scan-marks.js';
import { pdfBlankScan, pdfWholePageImage, removePdfScanBorderFragments, pdfScanPageFallback } from './pdf-page-image.js';
import { base64ToBytes } from './binary.js';
import { analyzePdfPage, createPdfLayout, groupPdfDrawings, PDF_WIDTH, PDF_SCREEN } from './pdf-layout.js';
import { paintedPdfPaths, ruledPdfTables } from './pdf-drawings.js';
import { pdfColorProfile, normalizePdfColors } from './pdf-colors.js';
import { reflowPdfBlock, joinPdfTextTails, joinPdfTextFragments } from './pdf-reflow.js';
import { PdfOcr } from './pdf-ocr.js';
import { PdfRaster, PDF_RASTER_TILE } from './pdf-raster.js';
import { readPdfText, pdfFontAscent, pdfTextNeedsOcr, pdfWordGeometryNeedsOcr, restorePdfOcrMarkers, splitPdfOcrColumns, pdfHasScanTranscript, pdfRomanHeadingHints, restorePdfRomanHeadings } from './pdf-text.js';
import { pdfAnalysisViewport, pdfSourceTransform, pdfSourcePoint } from './pdf-orientation.js';
import { pdfContentsEntries, markPdfContents } from './pdf-contents.js';
import { repeatedPdfTextMasks, pdfPageNumberMasks, pdfGraphicFurnitureMasks, removeRepeatedPdfDividers, pdfFurnitureText, pdfFurniturePages } from './pdf-furniture.js';
import { pdfBodySize, separatePdfAnnotations, pdfSectionOrder, labelPdfAnnotation, pdfEndMatterStart, pdfFootnoteStyle } from './pdf-annotations.js';
import { insidePdfMargin } from './pdf-margins.js';
import { renderPdfPage } from './pdf-render.js';
import { measureNativeText } from './native-text.js';
import { pdfPreparationKey, packPdfPreparation, unpackPdfPreparation } from './pdf-cache.js';
import { pdfImageFrame } from './pdf-image-frame.js';
import { associatePdfCaptions, reunitePdfFigureFragments, protectPdfCaptionedExhibits } from './pdf-captions.js';
import { readPdfNavigation } from './document-contents.js';
import { pdfNavigationCandidates, pdfNavigationSections, pdfNavigationSanity, PDF_NAVIGATION_VERSION } from './pdf-navigation.js';

function textBoxes(content, viewport) {
  return content.items.filter(item => item.str?.trim()).map(item => {
    const m = Util.transform(viewport.transform, item.transform);
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    const length = Math.hypot(m[0], m[1]) || 1;
    const dx = m[0] / length * item.width * viewport.scale;
    const dy = m[1] / length * item.width * viewport.scale;
    const x = m[4] + m[2] * ascent; const y = m[5] + m[3] * ascent;
    const xs = [x, x + dx, x - m[2], x + dx - m[2]];
    const ys = [y, y + dy, y - m[3], y + dy - m[3]];
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), text: item.str };
  });
}
export class PdfDocument {
  constructor({ diagnostics, selection, preparationCache } = {}) {
    this.diagnostics = diagnostics; this.selection = selection;
    this.preparationCache = preparationCache;
    this.cache = new Map(); this.pending = new Map(); this.marginMasks = new Map(); this.pageScales = new Map(); this.pageTurns = new Map(); this.destroyed = false;
    this.renders = new Set(); this.work = new PdfWork();
  }
  checkpoint(stage, details = {}) {
    if (this.destroyed) throw new Error('PDF closed.');
    this.progress = { ...this.progress, ...details, stage, selection: this.selection };
    if (this.diagnostics) { this.diagnostics.pdf = { ...this.progress }; this.diagnostics.log('pdf-stage', this.progress); }
  }
  async yieldPreparation() {
    await new Promise(resolve => setTimeout(resolve, 0));
    if (this.destroyed) throw new Error('PDF closed.');
  }
  releasePage(number) {
    const cached = this.cache.get(number);
    if (!cached) return;
    cached.canvas.width = cached.canvas.height = 1;
    cached.page.cleanup(); this.cache.delete(number);
  }
  async releasePreparationMemory() {
    if (this.destroyed) return;
    await this.raster.cleanup(async () => {
      if (this.destroyed) return;
      for (const number of this.cache.keys()) this.releasePage(number);
      // page.cleanup() alone leaves the worker's shared resource/font caches
      // alive. Bound them between batches of this document, while retaining
      // the extracted text/layout and already-rendered preview pixels.
      await this.pdf.cleanup();
      this.diagnostics?.log('pdf-memory-released', { selection: this.selection, page: this.progress.page });
    });
  }
  report(type, error, context = {}) {
    if (!this.destroyed) this.diagnostics?.error(type, error, { ...this.progress, ...context });
  }
  async open(content, mode, onProgress = () => {}, options = {}) {
    try { return await this.prepare(content, mode, onProgress, options); }
    catch (error) {
      this.openError = error;
      if (this.destroyed) this.diagnostics?.log('pdf-cancelled', { selection: this.selection });
      else this.report('pdf-open-error', error);
      throw error;
    }
  }
  async prepare(content, mode, onProgress, { keepMarginNotes = false, keepRepeatedText = false, normalizeColors = true, reflow = true, textSize = 20, onPartial } = {}) {
    this.checkpoint('initializing', { pdfjsVersion, encodedBytes: content.length, mode, keepMarginNotes, keepRepeatedText, normalizeColors, reflow, textSize });
    await this.yieldPreparation();
    this.normalizeColors = normalizeColors;
    this.warnings = []; this.ocr = new PdfOcr();
    textSize = [20, 24, 28].includes(Number(textSize)) ? Number(textSize) : 20;
    this.checkpoint('decoding-file');
    const data = base64ToBytes(content);
    let cacheKey; let restored;
    if (this.preparationCache) {
      this.checkpoint('checking-preparation-cache');
      onProgress('Opening saved PDF…');
      try {
        cacheKey = await pdfPreparationKey(data, { mode, keepMarginNotes, keepRepeatedText, normalizeColors, reflow, textSize }, pdfjsVersion);
        const saved = await this.preparationCache.read(cacheKey);
        if (saved) restored = unpackPdfPreparation(saved);
        this.diagnostics?.log(restored ? 'pdf-cache-hit' : 'pdf-cache-miss', { selection: this.selection });
      } catch (error) { this.report('pdf-cache-read-error', error); }
    }
    if (this.destroyed) throw new Error('PDF closed.');
    const measuring = document.createElement('canvas').getContext('2d'); measuring.font = `${textSize}px sans-serif`;
    const measure = value => Math.max(measuring.measureText(value).width, measureNativeText(value) * 552 / 544);
    this.checkpoint('starting-worker');
    this.port = new PdfWorker();
    this.port.addEventListener('error', event => this.report('pdf-worker-error', event.error || new Error(event.message || 'PDF worker failed.'), { stage: 'worker', line: event.lineno, column: event.colno }));
    this.port.addEventListener('messageerror', () => this.report('pdf-worker-error', new Error('Could not decode a PDF worker message.'), { stage: 'worker-message' }));
    this.worker = new PDFWorker({ port: this.port });
    this.checkpoint('loading-document', { bytes: data.length });
    this.decoderFallbacks = new PdfDecoderFallbacks();
    this.task = getDocument({ data, worker: this.worker, BinaryDataFactory: LocalPdfResources,
      wasmUrl: this.decoderFallbacks.wasmUrl,
      useWorkerFetch: false, isEvalSupported: false, enableXfa: false, stopAtErrors: true, cMapPacked: true,
      // Let PDF.js downsample large scans to the canvas budget. maxImageSize
      // rejects them outright, dropping 600dpi article pages from the layout.
      canvasMaxAreaInBytes: 32_000_000 });
    const password = new Promise((_, reject) => { this.task.onPassword = () => reject(new Error('Remove the PDF password before adding this document.')); });
    this.pdf = await Promise.race([this.task.promise, password]);
    this.checkpoint('document-loaded', { pages: this.pdf.numPages });
    if (this.destroyed) throw new Error('PDF closed.');
    if (this.pdf.numPages > MAX_PDF_PAGES) throw new Error(`This PDF exceeds the ${MAX_PDF_PAGES.toLocaleString('en-US')}-page limit. Split it into smaller files.`);
    this.navigation = await readPdfNavigation(this.pdf);
    this.navigation.version = PDF_NAVIGATION_VERSION;
    this.navigation.sections = [];
    this.navigationCandidates = [];
    if (this.destroyed) throw new Error('PDF closed.');
    if (restored) {
      onProgress('Restoring prepared PDF…');
      this.layout = restored.layout; this.layout.pdf = this;
      const prior = this.layout.navigation;
      const validPrior = prior?.version === PDF_NAVIGATION_VERSION && Array.isArray(prior.sections) && prior.sections.length <= 8192
        && prior.sections.every(e => typeof e.title === 'string' && e.title.length <= 500 && Number.isInteger(e.page)
          && e.page > 0 && e.page <= this.pdf.numPages && (!e.point || Number.isFinite(e.point.x) && Number.isFinite(e.point.y)));
      if (validPrior) { this.navigation.sections = prior.sections; this.navigation.sanity = prior.sanity; }
      else if (!this.navigation.outline.length) {
        // Old preparations retain OCR inside raster fallbacks only in the
        // original PDF's hidden text layer. Recover navigation without rerunning
        // OCR, rendering pages, or discarding the existing preparation.
        for (let number = 1; number <= this.pdf.numPages; number++) {
          if (this.destroyed) throw new Error('PDF closed.');
          if (number % 10 === 1) onProgress(`Reading contents ${number} of ${this.pdf.numPages}…`);
          try {
            const page = await this.pdf.getPage(number), viewport = pdfAnalysisViewport(page);
            this.navigationCandidates.push(...pdfNavigationCandidates({ text: textBoxes(await readPdfText(page), viewport),
              width: viewport.width, height: viewport.height }, number));
            page.cleanup();
          } catch (error) { this.report('pdf-contents-page-error', error, { page: number }); }
          if (number % 10 === 0) { await this.pdf.cleanup(); await this.yieldPreparation(); }
        }
        this.navigation.sections = pdfNavigationSections(this.navigationCandidates, { pages: this.pdf.numPages });
        this.navigation.sanity = pdfNavigationSanity(this.navigation.sections, { candidates: this.navigationCandidates, pages: this.pdf.numPages });
      }
      this.layout.navigation = this.navigation;
      this.marginMasks = restored.marginMasks; this.pageScales = restored.pageScales;
      this.pageTurns = new Map(this.layout.blocks.filter(block => block.turn).map(block => [block.page, block.turn]));
      this.raster = new PdfRaster(this.pdf, this.pageScales, normalizeColors, this.work);
      if (!validPrior && cacheKey && !this.destroyed) {
        try {
          const saved = packPdfPreparation(this.layout, this.marginMasks, this.pageScales);
          if (restored.desktopEngine) saved.desktopEngine = restored.desktopEngine;
          if (restored.desktopSha256) saved.desktopSha256 = restored.desktopSha256;
          await this.preparationCache.write(cacheKey, saved, () => !this.destroyed);
        }
        catch (error) { this.report('pdf-contents-cache-error', error); }
      }
      this.diagnostics?.log('pdf-navigation-check', this.navigationReport());
      this.checkpoint('ready', { totalBlocks: this.layout.blocks.length, cached: true });
      return this.layout;
    }
    this.raster = new PdfRaster(this.pdf, this.pageScales, normalizeColors, this.work);
    const settings = { mode, keepMarginNotes, keepRepeatedText, normalizeColors, reflow, textSize, measure };
    const earlyPages = []; const earlyPreparations = []; let earlyEndMatter = false;
    // Keep only layout objects already needed by the readable prefix, never
    // full-page pixels. Whole-document analysis can change footnotes, running
    // headers or Roman headings; reuse a page only if all those inputs agree.
    const pageInputs = (number, context, endMatter) => {
      const source = textPages[number - 1];
      return { text: source.text, layoutText: source.layoutText,
        context: JSON.stringify([context.repeatedMasks[number - 1], context.bodySize,
          context.noteStyle, endMatter, !!this.romanSections, !!this.ocrFailed, !!this.headingOcrFailed]) };
    };
    const publish = pages => {
      if (this.destroyed || !onPartial || pages.length >= this.pdf.numPages) return;
      const partial = this.buildLayout(pages, settings);
      if (!partial.blocks.length) return;
      partial.preparation = { complete: false, readyPages: pages.length, totalPages: this.pdf.numPages };
      this.layout = partial;
      this.diagnostics?.log('pdf-partial-ready', { selection: this.selection, pages: pages.length, total: this.pdf.numPages });
      onPartial(partial);
    };
    // Recognize text before comparing running furniture and note sizes, including
    // image-only scans. Retain boxes, not full-page canvases, between passes.
    const textPages = [];
    for (let number = 1; number <= this.pdf.numPages; number++) {
      if (this.destroyed) throw new Error('PDF closed.');
      onProgress(`Reading PDF text ${number} of ${this.pdf.numPages}…`);
      this.checkpoint('extracting-text', { page: number });
      const extracted = await this.readPageText(number, reflow, onProgress);
      await this.restorePageFurniture(number, extracted);
      textPages.push(extracted);
      if (!this.navigation.outline.length) {
        const page = textPages.at(-1);
        // Corrected OCR coordinates must remain in the original page space.
        let entries = pdfNavigationCandidates(page, number);
        if (this.pageTurns.get(number)) {
          const original = await this.pdf.getPage(number);
          const mapping = { sourceTransform: pdfSourceTransform(pdfAnalysisViewport(original), pdfAnalysisViewport(original, this.pageTurns.get(number))) };
          entries = entries.map(entry => ({ ...entry, point: pdfSourcePoint(mapping, entry.point) }));
        }
        this.navigationCandidates.push(...entries);
      }
      // Make a provisional prefix readable while later pages are extracted
      // or recognized; the final pass still compares the whole
      // document for recurring furniture, heading sizes and footnote styles.
      // A short prefix is enough while extracting embedded text. Preparing
      // every page here often renders the whole paper twice: running headers
      // and footnote sizes only settle after the text pass. Scanned documents
      // keep publishing throughout their much slower OCR pass.
      if (onPartial && (number <= 6 || reflow && textPages.some(page => page.needsOcr)) && number < this.pdf.numPages
        && (number === 1 || number % 3 === 0)) {
        const context = this.analysisContext(textPages, settings);
        for (let next = earlyPages.length + 1; next <= number; next++) {
          const inputs = pageInputs(next, context, earlyEndMatter);
          const prepared = await this.preparePage(next, { ...settings, ...context, textPages, endMatter: earlyEndMatter });
          earlyPreparations.push({ ...inputs, prepared, masks: this.marginMasks.get(next), romanSections: this.romanSections });
          earlyPages.push(prepared.page); earlyEndMatter = prepared.endMatter;
        }
        publish(earlyPages);
      }
      if (number % 3 === 0) await this.releasePreparationMemory();
      await this.yieldPreparation();
    }
    if (textPages.filter(page => page.romanHints.length).length >= 2) {
      this.romanSections = true;
      for (const page of textPages) if (page.romanHints.length) {
        page.text = restorePdfRomanHeadings(page.text, page.romanHints);
        if (page.layoutFromOcr) page.layoutText = page.text;
      }
    }
    const context = this.analysisContext(textPages, settings);
    let pages = []; let endMatter = false;
    for (let number = 1; number <= this.pdf.numPages; number++) {
      if (this.destroyed) throw new Error('PDF closed.');
      onProgress(`Preparing PDF page ${number} of ${this.pdf.numPages}…`);
      const inputs = pageInputs(number, context, endMatter); const early = earlyPreparations[number - 1];
      let prepared;
      if (early && early.text === inputs.text && early.layoutText === inputs.layoutText && early.context === inputs.context) {
        prepared = early.prepared;
        this.marginMasks.set(number, early.masks); this.romanSections = early.romanSections;
        this.diagnostics?.log('pdf-page-reused', { selection: this.selection, page: number });
      } else prepared = await this.preparePage(number, { ...settings, ...context, textPages, endMatter });
      pages.push(prepared.page); endMatter = prepared.endMatter;
      // Do not replace a long provisional prefix with a shorter final prefix.
      if (number >= earlyPages.length && (number === 1 || number % 3 === 0)) publish(pages);
      if (number % 3 === 0) await this.releasePreparationMemory();
      await this.yieldPreparation();
    }
    this.checkpoint('building-reader');
    await this.releasePreparationMemory();
    await this.ocr.destroy();
    this.layout = this.buildLayout(pages, settings);
    this.layout.preparation = { complete: true, readyPages: this.pdf.numPages, totalPages: this.pdf.numPages };
    if (!this.layout.blocks.length) throw new Error('This PDF contains no visible content.');
    if (cacheKey && !this.ocrFailed && !this.destroyed) {
      this.checkpoint('saving-preparation'); onProgress('Saving prepared PDF…');
      try {
        const saved = await this.preparationCache.write(cacheKey, packPdfPreparation(this.layout, this.marginMasks, this.pageScales), () => !this.destroyed);
        if (saved) this.diagnostics?.log('pdf-cache-saved', { selection: this.selection });
      } catch (error) {
        this.report('pdf-cache-write-error', error);
        this.warnings.push('Could not save the prepared PDF. It may need preparation again next time.');
      }
    }
    if (this.destroyed) throw new Error('PDF closed.');
    this.diagnostics?.log('pdf-navigation-check', this.navigationReport());
    this.checkpoint('ready', { totalBlocks: this.layout.blocks.length, cached: false });
    return this.layout;
  }
  readPageText(number, reflow, onProgress) {
    return this.work.run(async () => {
      const page = await this.pdf.getPage(number); let viewport = pdfAnalysisViewport(page);
      const embedded = textBoxes(await readPdfText(page), viewport);
      let scanTranscript = false;
      if (reflow && embedded.length) {
        const ops = await page.getOperatorList();
        if (ops.fnArray.some((op, i) => op === OPS.setTextRenderingMode && ops.argsArray[i][0] === 3)) {
          await this.renderAnalysisPage(number);
          scanTranscript = pdfHasScanTranscript(ops, OPS, page.imageCoordinates || []);
        }
      }
      const needsOcr = scanTranscript || pdfTextNeedsOcr(embedded);
      let text = embedded; let turn = 0; let orientationMasks = [];
      if (reflow && needsOcr) {
        text = [];
        if (!this.ocrFailed) {
          this.checkpoint('ocr');
          try {
            const result = await this.ocr.recognize(page, viewport, `${this.pdf.fingerprints[0]}:${number}`, percent => {
              if (!this.destroyed) onProgress(`Reading scanned page ${number} of ${this.pdf.numPages}${percent == null ? '…' : ` · ${percent}%`}`);
            });
            turn = result.turn; text = turn ? result.text : reconcilePdfOcr(restorePdfOcrMarkers(result.text, embedded), embedded);
            if (turn) {
              this.pageTurns.set(number, turn);
              const corrected = pdfAnalysisViewport(page, turn);
              const mapping = { sourceTransform: pdfSourceTransform(viewport, corrected) };
              orientationMasks = pdfPageNumberMasks({ width: viewport.width, height: viewport.height, text: result.originalText }).map(box => {
                const points = [[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]]
                  .map(([x,y])=>pdfSourcePoint(mapping,{x,y},true));
                const x = Math.min(...points.map(p=>p.x)); const y = Math.min(...points.map(p=>p.y));
                return { x,y,width:Math.max(...points.map(p=>p.x))-x,height:Math.max(...points.map(p=>p.y))-y };
              });
              viewport = corrected;
            }
          } catch (error) {
            if (this.destroyed) throw error;
            this.report('pdf-ocr-error', error);
            this.ocrFailed = true; await this.ocr.destroy();
            this.warnings.push('OCR could not finish. Unrecognized pages are shown as scans.');
          }
        }
      }
      const extracted = { width: Math.ceil(viewport.width), height: Math.ceil(viewport.height), needsOcr,
        furnitureText: needsOcr && !turn ? pdfFurnitureText(embedded, viewport.height) : [],
        romanHints: scanTranscript && !turn ? pdfRomanHeadingHints(embedded, viewport.width, viewport.height) : [],
        text, orientationMasks, layoutFromOcr: Boolean(turn || scanTranscript || pdfWordGeometryNeedsOcr(embedded)),
        // A corrupt encoding can still have useful line geometry. Keep it
        // for crop/column boundaries, but replace its strings with OCR below.
        layoutText: turn || scanTranscript || pdfWordGeometryNeedsOcr(embedded) ? text : needsOcr ? embedded.filter(box => [box.x, box.y, box.width, box.height].every(Number.isFinite)
          && box.width > 0 && box.height >= 2) : text };
      // OCR renders can use a different rotation and recording mode. The
      // layout pass needs fresh image/operator bounds for its own viewport.
      this.releasePage(number);
      page.cleanup();
      return extracted;
    });
  }
  async restorePageFurniture(number, extracted) {
    if (!extracted.needsOcr || extracted.furnitureText !== undefined) return;
    // Older desktop checkpoints predate furniture evidence. Recover just the
    // hidden edge text without rendering a page or starting another OCR pass.
    const page = await this.pdf.getPage(number);
    try {
      const viewport = pdfAnalysisViewport(page, this.pageTurns.get(number) || 0);
      extracted.furnitureText = pdfFurnitureText(textBoxes(await readPdfText(page), viewport), viewport.height);
    } finally { page.cleanup(); }
  }
  analysisContext(textPages, { keepRepeatedText }) {
    this.checkpoint('detecting-repeated-text');
    const repeatedMasks = keepRepeatedText ? textPages.map(() => []) : repeatedPdfTextMasks(textPages);
    if (!keepRepeatedText) textPages.forEach((page, index) => repeatedMasks[index].push(...page.orientationMasks, ...pdfPageNumberMasks({ ...page,
      text: page.text.filter(box => !insidePdfMargin(box, repeatedMasks[index])) })));
    if (!keepRepeatedText) {
      const furniturePages = pdfFurniturePages(textPages), extra = repeatedPdfTextMasks(furniturePages);
      furniturePages.forEach((page, index) => {
        if (!textPages[index].furnitureText?.length) return;
        repeatedMasks[index].push(...extra[index], ...pdfPageNumberMasks({ ...page,
          text: page.text.filter(box => !insidePdfMargin(box, extra[index])) }));
      });
    }
    const bodySize = pdfBodySize(textPages);
    return { repeatedMasks, bodySize, noteStyle: pdfFootnoteStyle(textPages, bodySize) };
  }
  navigationReport() {
    const navigation = this.layout.navigation;
    const report = navigation.outline?.length ? pdfNavigationSanity(navigation.outline, { source: 'bookmarks', pages: this.pdf.numPages }) : navigation.sanity;
    return { version: PDF_NAVIGATION_VERSION, source: navigation.outline?.length ? 'bookmarks' : 'derived',
      checked: report?.checked || 0, contents: report?.contents || 0,
      issueCount: report?.issues?.length || 0, issues: (report?.issues || []).slice(0, 40) };
  }

  buildLayout(sourcePages, { reflow, keepRepeatedText, measure, textSize }) {
    // Section ordering annotates its input. Snapshots must not mutate crops
    // that an earlier reader or preview is still using.
    let pages = sourcePages.map(page => ({ ...page, blocks: page.blocks.map(block => ({ ...block,
      ...(block.annotation ? { annotation: { ...block.annotation } } : {}) })) }));
    if (reflow && !keepRepeatedText) pages = removeRepeatedPdfDividers(pages);
    if (!reflow) associatePdfCaptions(pages);
    const readingOrder = reflow ? pdfSectionOrder(pages).flatMap(entry => {
      const block = labelPdfAnnotation(entry.block, measure, textSize);
      return block.annotationLabel ? [{ ...entry, block }, entry] : [{ ...entry, block }];
    }) : null;
    const layout = createPdfLayout(pages, { textSize, readingOrder });
    const sections = pdfNavigationSections(this.navigationCandidates, { pages: this.pdf.numPages });
    layout.navigation = { ...this.navigation, sections,
      sanity: pdfNavigationSanity(sections, { candidates: this.navigationCandidates, pages: this.pdf.numPages }) };
    layout.pdf = { draw: (y, height, inverted, options) => this.draw(y, height, inverted, { ...options, layout: options?.layout || layout }),
      drawFigure: (block, options) => this.drawFigure(block, options) };
    layout.sourcePages = pages;
    return layout;
  }
  preparePage(number, settings) {
    return this.work.run(async () => {
      try { return await this.preparePageContents(number, settings); }
      finally { this.releasePage(number); }
    });
  }
  async preparePageContents(number, { textPages, repeatedMasks, bodySize, noteStyle, mode, keepMarginNotes,
    keepRepeatedText, normalizeColors, reflow, textSize, measure, endMatter }) {
    if (this.destroyed) throw new Error('PDF closed.');
    const { canvas, page, viewport, imageCoordinates, recordedBBoxes } = await this.renderAnalysisPage(number);
    this.checkpoint('reading-pixels');
    const ctx = canvas.getContext('2d');
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const needsOcr = textPages[number - 1].needsOcr;
    const blank = reflow && needsOcr && pdfBlankScan({ width: canvas.width, height: canvas.height,
      data: pixels.data, text: textPages[number - 1].text });
    this.checkpoint('normalizing-colors');
    const colorProfile = normalizeColors ? pdfColorProfile(pixels.data) : null;
    if (normalizeColors) normalizePdfColors(pixels.data, colorProfile);
    await this.yieldPreparation();
    let text = textPages[number - 1].text.filter(box => !insidePdfMargin(box, repeatedMasks[number - 1]));
    this.checkpoint('reading-images', { textItems: text.length });
    const images = []; const coords = imageCoordinates || [];
    for (let i = 0; i < coords.length; i += 6) {
      const xs = [coords[i], coords[i + 2], coords[i + 4], coords[i + 2] + coords[i + 4] - coords[i]].map(x => x * canvas.width);
      const ys = [coords[i + 1], coords[i + 3], coords[i + 5], coords[i + 3] + coords[i + 5] - coords[i + 1]].map(y => y * canvas.height);
      images.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
    // Recorded drawing bounds also keep vector plots/diagrams together.
    // Ignore text operations and page-sized background rectangles.
    this.checkpoint('reading-operators');
    const ops = await page.getOperatorList(); const boxes = recordedBBoxes;
    this.checkpoint('grouping-drawings', { operators: ops.fnArray.length });
    const paths = paintedPdfPaths(ops, boxes, OPS, canvas.width, canvas.height, viewport.transform, colorProfile?.background);
    images.push(...groupPdfDrawings(paths, canvas.width, canvas.height).map(box => ({ ...box, kind: 'drawing' })));
    if (!keepRepeatedText) repeatedMasks[number-1].push(...pdfGraphicFurnitureMasks({ width: canvas.width, height: canvas.height,
      text, images, masks: repeatedMasks[number-1] }));
    const marks = needsOcr && reflow ? pdfScanMarks({ width: canvas.width, height: canvas.height, data: pixels.data, text })
      : { text, annotations: [], masks: [] };
    text = marks.text;
    this.checkpoint('analyzing-layout');
    images.push(...ruledPdfTables(paths, text, canvas.width, canvas.height));
    const contents = reflow ? pdfContentsEntries(text, canvas.width) : [];
    const input = { width: canvas.width, height: canvas.height,
      data: pixels.data, text: textPages[number - 1].layoutFromOcr ? text : textPages[number - 1].layoutText,
      figureText: text, images, mode: contents.length ? 'single' : mode, keepMarginNotes, pageMasks: [...repeatedMasks[number - 1], ...marks.masks] };
    let analysis = pdfWholePageImage({ ...input, text: textPages[number - 1].text, blank, reflow }) || analyzePdfPage(input);
    await this.yieldPreparation();
    if (needsOcr && reflow && analysis.columns && Number.isFinite(analysis.split)) {
      const corrected = splitPdfOcrColumns(text,analysis.split);
      if (corrected.length > text.length) {
        text = corrected;
        analysis = analyzePdfPage({ ...input,figureText:text,text:textPages[number-1].layoutFromOcr ? text : input.text });
      }
    }
    // OCR must not turn a few recognized cover words into a new column
    // layout that pulls discarded binding marks back into the reading crop.
    // Keep the scan's pixel geometry and attach recognized text afterward.
    if (reflow && needsOcr) for (const block of analysis.blocks.filter(block => !block.fullPage && !block.digitizationCredit)) {
      block.lines = text.filter(t => t.x + t.width / 2 >= block.x && t.x + t.width / 2 < block.x + block.width
        && t.y + t.height / 2 >= block.y && t.y + t.height / 2 < block.y + block.height);
      block.text = block.lines.map(t => t.text).join(' ');
      if (block.lines.length && block.kind === 'scan') block.kind = 'text';
    }
    analysis.blocks = reunitePdfFigureFragments(analysis.blocks);
    if (reflow) analysis.blocks = analysis.blocks.filter(block => !pdfUnderlineBlock(block, text));
    analysis.annotations = marks.annotations;
    if (reflow && !analysis.blocks.some(block => block.fullPage)) {
      analysis.blocks = joinPdfTextTails(joinPdfTextFragments(analysis.blocks, pixels.data, canvas.width));
      if (needsOcr && !this.ocrFailed && !this.headingOcrFailed) {
        // Sparse Roman section labels are often omitted or read as 11/111 by
        // whole-page OCR. Re-read only isolated, centered labels above prose,
        // after multiple such labels establish the document's section style.
        const candidates = analysis.blocks.filter(block => block.kind !== 'figure' && block.width < 60 && block.height < 35
          && block.y > canvas.height*(this.romanSections ? .07 : .12) && block.y < canvas.height*.9 && /^[IVXLCDMl1\s]*$/i.test(block.text)
          && analysis.blocks.some(body => body.kind === 'text' && body.text.length > 100 && body.y >= block.y+block.height
            && body.y-block.y-block.height < 70 && Math.abs(body.x+body.width/2-block.x-block.width/2) < body.width*.18));
        this.romanSections ||= candidates.length >= 2;
        if (this.romanSections) for (const block of candidates) {
          try {
            const heading = await this.ocr.recognizeRomanHeading(page,viewport,block);
            if (heading) { block.kind='text';block.lines=[heading];block.text=heading.text; }
          } catch (error) {
            if (this.destroyed) throw error;
            this.headingOcrFailed = true; this.report('pdf-heading-ocr-error',error);
            this.warnings.push('Some section titles could not be recognized and are shown as scans.');
            await this.ocr.destroy(); break;
          }
        }
      }
      analysis.blocks = markPdfContents(analysis.blocks, contents);
      analysis.blocks = separatePdfAnnotations({ ...analysis, width: canvas.width, height: canvas.height },
        { bodySize, endMatter, noteStyle, fontSize: textSize, measure, pixels: pixels.data, pageWidth: canvas.width });
      analysis.blocks = protectPdfCaptionedExhibits({ ...analysis, width: canvas.width, height: canvas.height });
      endMatter ||= Number.isFinite(pdfEndMatterStart(analysis));
    }
    if (reflow && needsOcr) analysis.blocks = removePdfScanBorderFragments({ blocks: analysis.blocks,
      width: canvas.width, height: canvas.height, data: pixels.data,
      originalData: analysis.blocks.some(block => block.kind === 'scan' && !block.fullPage && !block.text.trim())
        ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : undefined });
    if (reflow && needsOcr) analysis.blocks = analysis.blocks.filter(block => !pdfScanRuleFragment(block,
      { width: canvas.width, height: canvas.height, data: pixels.data, text }));
    this.checkpoint('reflowing-text');
    await this.yieldPreparation();
    if (reflow) for (const block of analysis.blocks) {
      // Pencil strokes can make dense scanned prose look like one figure.
      // Require multiple substantial rows and the usual pixel coverage/table
      // checks; explicit exhibits, sparse labels and actual diagrams stay put.
      const scanProse = needsOcr && block.kind === 'figure' && !block.fullPage && !block.captionId
        && !block.figureBounds?.some(box => box.kind === 'table')
        && block.lines.filter(line => line.text.length >= 35 && line.confidence >= 80
          && line.height < 45 && line.width >= block.width * .6).length >= 6;
      block.reflow = reflowPdfBlock(scanProse ? { ...block, kind: 'text' } : block, {
        // The preview and native glasses share row/source coordinates. Wrap
        // to fit both fonts; leave the same firmware allowance as Markdown.
        fontSize: textSize, measure, pixels: pixels.data, pageWidth: canvas.width, allowSparseUncertainty: needsOcr,
      });
      if (scanProse && block.reflow) { block.kind = 'text'; delete block.figureBounds; }
      if (block.reflow) block.reflow.nativeWrap = 1;
    }
    if (reflow && needsOcr) analysis = pdfScanPageFallback(analysis, { width: canvas.width, height: canvas.height, images });
    this.marginMasks.set(number, analysis.marginMasks);
    const turn = this.pageTurns.get(number);
    if (turn) for (const block of [...analysis.blocks, ...analysis.annotations]) Object.assign(block, { turn, pageRotation: viewport.rotation,
      sourceTransform: pdfSourceTransform(pdfAnalysisViewport(page), viewport) });
    // Retain original pixels. A dark callout on a light page can have a
    // different paper color; deriving its profile from an already grayscale
    // page would lose equal-luminance color differences inside it.
    this.checkpoint('normalizing-blocks', { blocks: analysis.blocks.length });
    if (normalizeColors) for (const block of [...analysis.blocks, ...analysis.annotations]) {
      block.colorProfile = pdfColorProfile(ctx.getImageData(Math.floor(block.x), Math.floor(block.y),
        Math.ceil(block.width), Math.ceil(block.height)).data);
    }
    return { page: { number, width: canvas.width, height: canvas.height, ...analysis }, endMatter };
  }
  renderPage(number) { return this.work.run(() => this.renderAnalysisPage(number)); }
  async renderAnalysisPage(number) {
    if (this.destroyed) throw new Error('PDF closed.');
    if (this.cache.has(number)) { const value = this.cache.get(number); this.cache.delete(number); this.cache.set(number, value); return value; }
    if (this.pending.has(number)) return this.pending.get(number);
    const promise = (async () => {
      this.checkpoint('loading-page', { page: number });
      const page = await this.pdf.getPage(number);
      this.checkpoint('sizing-page');
      const viewport = pdfAnalysisViewport(page, this.pageTurns.get(number) || 0);
      this.pageScales.set(number, viewport.scale);
      const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      this.checkpoint('rendering-page', { canvasWidth: canvas.width, canvasHeight: canvas.height });
      const task = renderPdfPage(page, { canvas, viewport, recordImages: true, recordOperations: true, background: '#fff' });
      this.renders.add(task);
      try {
        await task.promise;
        if (this.destroyed) throw new Error('PDF closed.');
      } catch (error) { canvas.width = canvas.height = 1; throw error; }
      finally { this.renders.delete(task); }
      const result = { page, canvas, viewport, imageCoordinates: page.imageCoordinates, recordedBBoxes: page.recordedBBoxes };
      this.cache.set(number, result);
      while (this.cache.size > 2) {
        const oldest = this.cache.keys().next().value;
        this.releasePage(oldest);
      }
      return result;
    })().finally(() => this.pending.delete(number));
    this.pending.set(number, promise); return promise;
  }
  async draw(y, height = PDF_SCREEN, inverted = false, { paging = false, endAt = Infinity, layout = this.layout, centerImages = false, signal } = {}) {
    try { return await this.drawFrame(y, height, inverted, paging, endAt, layout, centerImages, signal); }
    catch (error) { if (!signal?.aborted) this.report('pdf-render-error', error, { stage: 'drawing-frame', y, height, inverted, paging }); throw error; }
  }
  async drawFigure(block, { maxWidth = 1024, maxHeight = 1536, signal } = {}) {
    const check = () => { if (this.destroyed || signal?.aborted) throw new Error('Figure preview closed.'); };
    check();
    // Render the original crop, independently of its glasses fit-to-screen
    // scale. Bound canvas memory and share the existing serial raster queue.
    const scale = Math.min(4, Math.max(1, Math.min(1536, maxWidth)) / block.width,
      Math.max(1, Math.min(1536, maxHeight)) / block.height);
    const crop = { ...block, scale, drawHeight: Math.ceil(block.height * scale) };
    const canvas = document.createElement('canvas'); canvas.width = Math.ceil(block.width * scale); canvas.height = crop.drawHeight;
    try {
      const ctx = canvas.getContext('2d');
      for (let index = 0; index * PDF_RASTER_TILE < canvas.height; index++) {
        check(); const tile = await this.raster.tile(crop, index, signal); check();
        ctx.drawImage(tile, 0, index * PDF_RASTER_TILE);
      }
      ctx.fillStyle = '#fff';
      for (const mask of block.annotation?.kind === 'handwriting' ? [] : this.marginMasks.get(block.page) || []) ctx.fillRect((mask.x - block.x) * scale,
        (mask.y - block.sourceY) * scale, mask.width * scale, mask.height * scale);
      return canvas;
    } catch (error) { canvas.width = canvas.height = 1; throw error; }
  }
  async drawFrame(y, height, inverted, paging, endAt = Infinity, layout = this.layout, centerImages = false, signal) {
    const check = () => { if (this.destroyed || signal?.aborted) throw new Error('PDF preview closed.'); };
    check();
    const canvas = document.createElement('canvas'); canvas.width = PDF_WIDTH; canvas.height = height;
    try {
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, height);
      const frame = centerImages ? pdfImageFrame(layout, y, height, endAt) : { y, end: Math.min(y + height, endAt), top: 0 };
      y = frame.y;
      ctx.save(); ctx.translate(0, frame.top);
      for (const block of layout.blocks) {
        check();
        if (block.y + block.drawHeight <= y || block.y >= frame.end) continue;
        if (paging && block.keepTogether && block.y > y + .5 && block.y + block.drawHeight > y + height) continue;
        if (block.reflow) {
          ctx.save(); ctx.fillStyle = '#000'; ctx.font = `${block.reflow.fontSize}px sans-serif`; ctx.textBaseline = 'top';
          for (const row of block.reflow.rows) if (block.y + row.y + block.reflow.lineHeight > y && block.y + row.y < y + height) {
            ctx.fillText(row.text, 12, block.y + row.y - y + 2);
          }
          ctx.restore(); continue;
        }
        const top = Math.max(y, block.y); const bottom = Math.min(frame.end, block.y + block.drawHeight);
        const left = Math.round((PDF_WIDTH - block.width * block.scale) / 2);
        for (let index = Math.floor((top - block.y) / PDF_RASTER_TILE); index * PDF_RASTER_TILE < bottom - block.y; index++) {
          let source;
          try { source = await this.raster.tile(block, index, signal); }
          catch (error) {
            if (!this.destroyed && !signal?.aborted) this.report('pdf-tile-error', error, { stage: 'rendering-tile', page: block.page, tile: index, kind: block.kind });
            throw error;
          }
          check();
          const tileY = block.y + index * PDF_RASTER_TILE;
          const start = Math.max(top, tileY); const end = Math.min(bottom, tileY + source.height);
          ctx.drawImage(source, 0, start - tileY, block.width * block.scale, end - start,
            left, start - y, block.width * block.scale, end - start);
        }
        // Clear margins AFTER normalization so removed lanes remain unlit even
        // when the original page or this block had a black/colored background.
        ctx.save(); ctx.beginPath(); ctx.rect(left, top - y, block.width * block.scale, bottom - top); ctx.clip();
        ctx.fillStyle = '#fff';
        for (const mask of this.marginMasks.get(block.page) || []) ctx.fillRect(left + (mask.x - block.x) * block.scale,
          block.y - y + (mask.y - block.sourceY) * block.scale, mask.width * block.scale, mask.height * block.scale);
        ctx.restore();
      }
      ctx.restore();
      if (inverted) {
        const pixels = ctx.getImageData(0, 0, PDF_WIDTH, height);
        for (let i = 0; i < pixels.data.length; i += 4) {
          const value = 255 - Math.round(pixels.data[i] * .2126 + pixels.data[i + 1] * .7152 + pixels.data[i + 2] * .0722);
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = value;
        }
        ctx.putImageData(pixels, 0, 0);
      }
      return canvas;
    } catch (error) { canvas.width = canvas.height = 1; throw error; }
  }
  async destroy() {
    if (this.closing) return this.closing;
    this.destroyed = true; this.work.close();
    for (const task of this.renders) task.cancel();
    for (const number of this.cache.keys()) this.releasePage(number);
    this.raster?.destroy();
    this.closing = Promise.allSettled([this.ocr?.destroy(), this.task?.destroy()]).finally(() => {
      this.worker?.destroy(); this.port?.terminate(); this.layout = null;
      this.decoderFallbacks?.destroy();
      this.marginMasks.clear(); this.pageScales.clear(); this.pageTurns.clear();
    });
    return this.closing;
  }
}
