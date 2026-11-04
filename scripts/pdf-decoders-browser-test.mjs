import { chromium, webkit } from '@playwright/test';
import assert from 'node:assert/strict';
import { build } from 'vite';
import { createApp } from '../server/app.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scannedPdfFixture } from '../test/fixtures/pdfs.mjs';

const output = path.resolve(process.env.PDF_DECODER_RESULTS || 'test-results/pdf-decoders');
await mkdir(output, { recursive: true });
const entry = path.join(output, 'entry.js'), bundle = path.join(output, 'bundle');
await writeFile(entry, `export { PdfDocument } from ${JSON.stringify(path.resolve('src/pdf.js'))};
export { PdfDecoderFallbacks } from ${JSON.stringify(path.resolve('src/pdf-resources.js'))};`);
await build({ mode: 'release', build: { outDir: bundle, emptyOutDir: true, lib: { entry, formats: ['es'], fileName: () => 'decoders.js' } } });
const server = createApp({ distDir: bundle }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
// Original 16x16 lossless gray JPEG 2000: two black rectangles on white.
// Generated with Pillow/OpenJPEG, no source PDF or third-party image content.
const fixture = scannedPdfFixture(16, 16, await readFile('test/fixtures/jpeg2000.j2k'), { jpeg2000: true }).toString('base64');
const reports = [];
try {
  for (const engine of (process.env.PDF_DECODER_BROWSERS || 'chromium').split(',')) {
    const browser = await (engine === 'webkit' ? webkit.launch({ executablePath: process.env.WEBKIT_PATH })
      : chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] }));
    const deadline = setTimeout(() => browser.close(), 120_000);
    try {
      for (const forcedFallback of engine === 'chromium' ? [false, true] : [false]) {
        const context = await browser.newContext(); const page = await context.newPage();
        const errors = [], warnings = [], networkRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
        await page.route('**/__decoders', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>PDF decoders</title>' }));
        await page.goto(`http://127.0.0.1:${server.address().port}/__decoders`);
        if (forcedFallback) await page.evaluate(() => {
          const NativeBlob = window.Blob;
          window.Blob = class extends NativeBlob {
            constructor(parts, options) {
              // Change only the bundled PDF worker; keep its normal bootstrap
              // and message delivery, including the first initialization event.
              if (options?.type?.startsWith('text/javascript') && parts.some(part => typeof part === 'string' && part.includes('WorkerMessageHandler'))) {
                parts = [`WebAssembly.instantiate = async () => { throw new WebAssembly.CompileError('Forced decoder fallback'); };\n`, ...parts];
              }
              super(parts, options);
            }
          };
        });
        await page.evaluate(async () => { Object.assign(window, await import('/decoders.js')); });
        // WebKit's automation offline flag also blocks local Blob modules/workers.
        // Deny HTTP instead there; all decoder work still has zero network access.
        await context.route(/^https?:/, route => { networkRequests.push(route.request().url()); return route.abort(); });
        if (engine === 'chromium') await context.setOffline(true);
        const result = await page.evaluate(async bytes => {
          const fallbacks = new PdfDecoderFallbacks();
          try {
            // Exercise both dispatch paths even on engines that support WASM.
            for (const name of ['openjpeg', 'jbig2']) {
              const { default: factory } = await import(`${fallbacks.wasmUrl}${name}_nowasm_fallback.js`);
              if (typeof factory !== 'function') throw new Error(`Missing ${name} fallback`);
              const decoder = await factory();
              if (typeof decoder[name === 'jbig2' ? '_jbig2_decode' : '_jp2_decode'] !== 'function') throw new Error(`Broken ${name} fallback`);
            }
          } finally { fallbacks.destroy(); }
          const decoderUrls = [], revoked = new Set(), revoke = URL.revokeObjectURL;
          URL.revokeObjectURL = url => { revoked.add(url); return revoke.call(URL, url); };
          const ink = canvas => {
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let count = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 128) count++;
            return count / (pixels.length / 4);
          };
          let saved;
          const preparationCache = { read: async () => saved, write: async (_, value) => { saved = value; return true; } };
          const pdf = new PdfDocument({ preparationCache }); let blocks, scanInk;
          try {
            const layout = await pdf.open(bytes, 'auto', () => {}, { reflow: false });
            blocks = layout.blocks.length;
            scanInk = ink((await pdf.renderPage(1)).canvas);
            // Cleanup between preparation batches must leave fallback imports usable.
            await pdf.releasePreparationMemory();
            if (ink((await pdf.renderPage(1)).canvas) < .2) throw new Error('Blank scan after cleanup');
          } finally { decoderUrls.push(...pdf.decoderFallbacks.urls); await pdf.destroy(); }
          const restored = new PdfDocument({ preparationCache });
          try {
            const layout = await restored.open(bytes, 'auto', () => {}, { reflow: false });
            if (!restored.progress.cached || layout.blocks.length !== blocks) throw new Error('Preparation cache was not restored');
            if (ink((await restored.renderPage(1)).canvas) < .2) throw new Error('Blank scan from cache');
          } finally { decoderUrls.push(...restored.decoderFallbacks.urls); await restored.destroy(); }
          return { blocks, scanInk, remainingUrls: decoderUrls.filter(url => !revoked.has(url)) };
        }, fixture);
        assert.ok(result.blocks > 0, 'scan produces reader blocks');
        assert.ok(result.scanInk > .2 && result.scanInk < .5, 'glasses scan retains the black rectangles');
        assert.deepEqual(result.remainingUrls, [], 'closing readers releases all decoder Blob URLs');
        assert.deepEqual(errors, []);
        assert.deepEqual(networkRequests, [], 'no network requests after loading the bundle');
        assert.ok(!warnings.some(text => /Unable to decode|failed to initialize|#getJsModule/.test(text)), warnings.join('\n'));
        if (forcedFallback) assert.ok(warnings.some(text => text.includes('Forced decoder fallback')), 'forced path exercised');
        reports.push({ engine, forcedFallback, ...result, warnings, passed: true });
        console.log(JSON.stringify(reports.at(-1)));
        await context.close();
      }
    } finally { clearTimeout(deadline); await browser.close(); }
  }
} finally {
  await writeFile(path.join(output, 'results.json'), JSON.stringify(reports, null, 2));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
