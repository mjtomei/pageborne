import { bundledNotices } from './scripts/bundled-notices.mjs';
import { defineConfig, loadEnv } from 'vite';
import { buildProfile, profilePaths } from './scripts/build-profile.mjs';
import { debugTerminalConnection } from './scripts/debug-terminal.mjs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { speechAssets } from './scripts/stt-assets.mjs';

// Bundle fonts, CMaps and image decoders with the app. PDF rendering never
// depends on a CDN, even when importing a new file while already offline.
export function pdfResources() {
  const root = path.resolve('node_modules/pdfjs-dist');
  const folders = { cmaps: 'cMapUrl', standard_fonts: 'standardFontDataUrl', wasm: 'wasmUrl' };
  return { name: 'local-pdf-resources',
    resolveId(id) { if (id === 'virtual:pdf-resources') return '\0pdf-resources'; },
    load(id) {
      if (id !== '\0pdf-resources') return;
      const assets = {};
      for (const [folder, kind] of Object.entries(folders)) for (const filename of readdirSync(path.join(root, folder))) {
        if (/\.(?:bcmap|ttf|pfb|wasm)$/.test(filename) && !filename.startsWith('quickjs')) assets[`${kind}/${filename}`] = readFileSync(path.join(root, folder, filename)).toString('base64');
      }
      const fallbacks = Object.fromEntries(['openjpeg', 'jbig2'].map(name => {
        const filename = `${name}_nowasm_fallback.js`;
        return [filename, readFileSync(path.join(root, 'wasm', filename), 'utf8')];
      }));
      return `export const decoderFallbacks = ${JSON.stringify(fallbacks)}; export default ${JSON.stringify(assets)}`;
    },
    generateBundle() {
      for (const file of readdirSync('vendor/licenses/liberation')) this.emitFile({ type: 'asset', fileName: `licenses/pdfjs/liberation/${file}`, source: readFileSync(`vendor/licenses/liberation/${file}`) });
      for (const folder of ['', ...Object.keys(folders)]) for (const file of readdirSync(path.join(root, folder))) {
        if (file.startsWith('LICENSE')) this.emitFile({ type: 'asset', fileName: `licenses/pdfjs/${folder ? folder + '/' : ''}${file}`, source: readFileSync(path.join(root, folder, file)) });
      }
    },
  };
}

export function ocrResources() {
  return {
    name: 'local-ocr-resources',
    resolveId(id) { if (id === 'virtual:ocr-resources') return '\0ocr-resources'; },
    load(id) {
      if (id !== '\0ocr-resources') return;
      return `export default ${JSON.stringify({
        core: readFileSync('node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'utf8'),
        simdCore: readFileSync('node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'utf8'),
        worker: readFileSync('node_modules/tesseract.js/dist/worker.min.js', 'utf8'),
        english: readFileSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz').toString('base64'),
      })}`;
    },
    generateBundle() {
      for (const [name, license] of [['tesseract.js', 'LICENSE.md'], ['tesseract.js-core', 'LICENSE']]) this.emitFile({ type: 'asset',
        fileName: `licenses/${name}/LICENSE`, source: readFileSync(`node_modules/${name}/${license}`) });
      this.emitFile({ type: 'asset', fileName: 'licenses/tessdata/LICENSE', source: readFileSync('vendor/licenses/tessdata/LICENSE') });
      this.emitFile({ type: 'asset', fileName: 'licenses/tesseract.js/worker.min.js.LICENSE.txt', source: readFileSync('node_modules/tesseract.js/dist/worker.min.js.LICENSE.txt') });
    },
  };
}

export default defineConfig(({ mode }) => {
  const web = mode === 'web';
  const envMode = ['debug', 'development'].includes(mode) ? 'debug' : 'release';
  const env = { ...loadEnv(envMode, process.cwd(), 'PAGEBORNE_'), ...process.env };
  const profile = buildProfile(mode, env);
  const automaticTerminal = debugTerminalConnection(profile, env);
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  return {
    base: './',
    define: { __STT_CPU_ONLY__: 'true' },
    plugins: [bundledNotices(), { name: 'build-profile',
      resolveId(id) { if (id === 'virtual:build-profile') return '\0build-profile'; },
      load(id) { if (id === '\0build-profile') return `export const DEBUG = ${profile.diagnostics}; export const BUILD_CHANNEL = ${JSON.stringify(profile.channel)}; export const WEB = ${web};`; },
      transformIndexHtml: { order: 'pre', handler(html) {
        html = html.replace(/<!-- debug:start -->([\s\S]*?)<!-- debug:end -->/g, (_, content) => profile.diagnostics ? content : '');
        return web ? html.replace('/src/main.js', '/src/web-entry.js').replace('<html', '<html data-platform="web"') : html;
      } },
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ ...profile, version, automaticTerminal: !!automaticTerminal }) }); },
    }, { name: 'automatic-terminal',
      resolveId(id) { if (id === 'virtual:automatic-terminal') return '\0automatic-terminal'; },
      load(id) { if (id === '\0automatic-terminal') return `export default ${JSON.stringify(automaticTerminal)}`; },
    }, { name: 'qr-license', generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'licenses/jsqr/LICENSE', source: readFileSync('node_modules/jsqr/LICENSE', 'utf8') });
    } }, { name: 'ask-origins',
      resolveId(id) { if (id === 'virtual:ask-origins') return '\0ask-origins'; },
      load(id) { if (id === '\0ask-origins') return `export default ${JSON.stringify(profile.origins)}`; },
      generateBundle() { this.emitFile({ type: 'asset', fileName: 'ask-origins.json', source: JSON.stringify(profile.origins) }); },
    }, { name: 'word-frequency-data', generateBundle() {
      for (const file of readdirSync('vendor/wordfreq')) this.emitFile({ type: 'asset', fileName: `licenses/wordfreq/${file}`, source: readFileSync(`vendor/wordfreq/${file}`) });
    } }, pdfResources(), speechAssets({ ensemble: true, refinement: false, benchmarks: false, acceleration: true }), ocrResources(), ...(web ? [{ name: 'compressed-web-assets', writeBundle(options, bundle) {
      for (const item of Object.values(bundle)) {
        if (!/\.(js|css)$/.test(item.fileName)) continue;
        // Vite finalizes preload references late in generateBundle. Compress
        // the written bytes, not an intermediate chunk with placeholders.
        const file = path.join(options.dir, item.fileName);
        writeFileSync(`${file}.gz`, gzipSync(readFileSync(file), { level: 9 }));
      }
    } }] : [])],
    worker: { format: 'es' },
    build: { target: web ? 'safari18' : 'esnext', outDir: web ? 'dist-web' : profilePaths(profile.channel).dist,
      // Failed speculative preloads can remain poisoned across Safari reloads:
      // https://bugs.webkit.org/show_bug.cgi?id=270357
      ...(web ? { modulePreload: false } : {}) },
  };
});
