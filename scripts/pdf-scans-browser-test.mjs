// Original scans exercise blank-leaf detection, readable digitization credits,
// small-cap headings, original-image inspection and saved preparation reuse.
import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';

const out = process.env.PDF_SCANS_RESULTS || 'test-results/pdf-scans'; await mkdir(out, { recursive: true });
const server = await createServer({ optimizeDeps: { entries: ['index.html'] }, server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await server.listen();
const engine = process.env.PDF_BROWSER || 'chromium';
const browser = await (engine === 'webkit' ? webkit.launch({ executablePath: process.env.WEBKIT_PATH })
  : chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-gpu'] }));
const result = { engine, passed: false, errors: [], cases: [] };
try {
  const page = await browser.newPage(); page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/__scans', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Scans</title>' }));
  await page.goto(new URL('/__scans', server.resolvedUrls.local[0]).href);
  for (const kind of ['blank', 'credit', 'contents', 'unresolved']) {
    const pixels = await page.evaluate(kind => {
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 800;
      const ctx = canvas.getContext('2d'); const paper = ctx.createLinearGradient(0, 0, 600, 0);
      paper.addColorStop(0, '#f6f6e9'); paper.addColorStop(1, '#ebebdf'); ctx.fillStyle = paper; ctx.fillRect(0, 0, 600, 800);
      ctx.fillStyle = '#888'; ctx.fillRect(0, 0, 3, 800); ctx.fillRect(300, 700, 1, 1);
      if (kind === 'credit') {
        ctx.fillStyle = '#ddd'; ctx.fillRect(120, 160, 360, 50); ctx.fillRect(120, 580, 360, 40);
        for (const x of [140, 240, 340, 440]) ctx.fillRect(x, 220, 24, 340);
        ctx.fillStyle = '#555'; ctx.font = '24px sans-serif';
        ctx.fillText('Digitized by the Example Library', 120, 380); ctx.fillText('in 2020', 260, 430);
        ctx.fillStyle = '#111'; ctx.font = '28px sans-serif'; ctx.fillText('https://example.org/book', 90, 740);
      }
      if (kind === 'contents') {
        ctx.fillStyle = '#111'; ctx.font = '28px serif'; ctx.fillText('CONTENTS', 200, 100);
        ctx.font = '22px serif'; ctx.fillText('1. READ THE BOOK . . . . . 3', 55, 200);
        ctx.fillText('II. TURN THE PAGE . . . . . 7', 55, 280);
        ctx.fillText('III. FIND THE STORY . . . . . 9', 55, 360);
        ctx.font = '20px serif'; ctx.fillText('A guide to reading and exploring a book.', 55, 440);
      }
      if (kind === 'unresolved') {
        ctx.fillStyle = '#222'; ctx.font = '20px serif';
        for (let i = 0; i < 7; i++) ctx.fillText('A printed paragraph explains the drawing below.', 60, 100 + i * 35);
        ctx.fillRect(100, 400, 3, 250); ctx.fillRect(100, 647, 380, 3);
        ctx.beginPath(); ctx.moveTo(105, 620); ctx.lineTo(210, 510); ctx.lineTo(300, 580); ctx.lineTo(470, 410); ctx.stroke();
      }
      const data = ctx.getImageData(0, 0, 600, 800).data, rgb = [];
      for (let i = 0; i < data.length; i += 4) rgb.push(data[i], data[i + 1], data[i + 2]); return rgb;
    }, kind);
    const textLayer = kind === 'contents' ? [{ text: 'CONTENTS', x: 200, y: 100, size: 28 },
      { text: '1. Read the Book 3', x: 55, y: 200, size: 22 }, { text: 'II. Turn the Page 7', x: 55, y: 280, size: 22 },
      { text: 'III. Find the Story 9', x: 55, y: 360, size: 22 }] : [];
    const bytes = scannedPdfFixture(600, 800, Buffer.from(pixels), { textLayer });
    const check = await page.evaluate(async ({ content, kind }) => {
      const { PdfDocument } = await import('/src/pdf.js'); const { pdfGalleryItems } = await import('/src/pdf-captions.js');
      const { pdfNativeWindow } = await import('/src/pdf-native.js');
      let saved; const preparationCache = { read: async () => saved, write: async (_, value) => { saved = value; } };
      const first = new PdfDocument({ preparationCache }); let recognized;
      const read = first.readPageText.bind(first); first.readPageText = async (...args) => { recognized = await read(...args); return recognized; };
      try {
        if (kind === 'blank') {
          let message = ''; try { await first.open(content, 'auto'); } catch (error) { message = error.message; }
          if (!/no visible content/.test(message)) throw new Error('Blank shaded scan became reading content');
          const original = new PdfDocument();
          try { const layout = await original.open(content, 'auto', () => {}, { reflow: false });
            if (!layout.blocks.some(b => b.fullPage)) throw new Error('Original scan lost');
          } finally { await original.destroy(); }
          return { kind, omittedFromReflow: true, originalRetained: true };
        }
        const layout = await first.open(content, 'auto');
        if (kind === 'unresolved') {
          if (layout.blocks.length !== 1 || !layout.blocks[0].fullPage) throw new Error('Unresolved scanned content was cropped');
          const items = pdfGalleryItems(layout);
          if (items.length !== 1 || items[0].block.sourceY !== 0) throw new Error('Extra or cropped gallery fallback');
          const image = await first.drawFigure(items[0].block, { maxWidth: 1000, maxHeight: 1400 });
          const reopening = new PdfDocument({ preparationCache });
          try {
            const restored = await reopening.open(content, 'auto');
            if (!reopening.progress.cached || restored.blocks.length !== 1 || !restored.blocks[0].fullPage) throw new Error('Full-page fallback lost after cache reload');
            const again = await reopening.drawFigure(pdfGalleryItems(restored)[0].block, { maxWidth: 1000, maxHeight: 1400 });
            if (again.toDataURL() !== image.toDataURL()) throw new Error('Cached fallback image changed');
          } finally { await reopening.destroy(); }
          return { kind, wholePage: true, singleGalleryImage: true, cache: true };
        }
        if (kind === 'contents') {
          const lines = recognized.text.map(line => line.text);
          if (!lines.some(line => /Read the Book/.test(line)) || !lines.some(line => /Turn the Page/.test(line))) throw new Error(`Contents casing: ${lines.join(' | ')}`);
          return { kind, headings: lines };
        }
        if (!layout.blocks.some(b => b.reflow && b.digitizationCredit) || layout.blocks.some(b => b.fullPage)) throw new Error('Credit stayed an image in reading order: ' + JSON.stringify({text: recognized.text.map(({text,confidence}) => ({text,confidence})), warnings: first.warnings}));
        if (!/Digitized by/.test(pdfNativeWindow(layout, 0)?.content)) throw new Error('Credit missing from native pane');
        const item = pdfGalleryItems(layout)[0]; if (!item?.block.fullPage) throw new Error('Original page missing from gallery');
        const image = await first.drawFigure(item.block, { maxWidth: 1000, maxHeight: 1400 });
        if (image.width < 900 || image.height < 1200) throw new Error('Original gallery image clipped');
        const reopening = new PdfDocument({ preparationCache });
        try { const restored = await reopening.open(content, 'auto');
          if (!reopening.progress.cached || pdfGalleryItems(restored).length !== 1 || !restored.blocks[0].reflow) throw new Error('Credit cache changed');
          const again = await reopening.drawFigure(pdfGalleryItems(restored)[0].block, { maxWidth: 1000, maxHeight: 1400 });
          if (again.toDataURL() !== image.toDataURL()) throw new Error('Cached original image changed');
        } finally { await reopening.destroy(); }
        document.body.append(image); return { kind, nativeCredit: true, originalInGallery: true, cache: true };
      } finally { await first.destroy(); }
    }, { content: bytes.toString('base64'), kind });
    result.cases.push(check);
  }
  assert.deepEqual(result.errors, []); result.passed = true; console.log(JSON.stringify(result));
} catch (error) { result.error = error.stack; throw error; }
finally { await writeFile(`${out}/${engine}.json`, JSON.stringify(result, null, 2)); await browser.close(); await server.close(); }
