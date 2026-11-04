import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { installLibrarySync } from '../integrations/even-terminal/pageborne-library.js';
import { installReaderState, createReaderState } from '../integrations/even-terminal/pageborne-reader-state.js';
import { pdfFixture } from '../test/fixtures/pdfs.mjs';
import { displayProbe } from './display-probe.mjs';
import { createWebApp } from '../server/web-app.js';
import { displayQuestion } from '../integrations/even-terminal/pageborne-conversation.js';
const root = await mkdtemp(path.join(tmpdir(), 'web-reader-'));
const libraryDir = path.join(root, 'library'); await mkdir(libraryDir);
const options = { libraryDir, stateDir: path.join(root, 'state') };
await writeFile(path.join(libraryDir, 'paper.md'), '# Reading on a smaller screen\n\nA **formatted** introduction with [a safe link](https://example.com).\n\n' + Array.from({ length: 25 }, (_, i) => `## Chapter ${i+1}\n\n` + 'A long paragraph about reading and understanding complicated ideas. '.repeat(12)).join('\n\n') + '\n\n<script>window.unsafeMarkdown = true</script>');
await writeFile(path.join(libraryDir, 'original.pdf'), pdfFixture());
const store = createReaderState(options);
await store.update({ document: 'paper.md', agent: 'codex', sessionId: 'shared-paper', anchors: [{ id: 'question-1', aliases: [], position: 60 }] });
await store.update({ document: 'original.pdf', agent: 'codex', sessionId: 'shared-pdf', anchors: [{ id: 'question-1', aliases: [], position: 60, page: 2 }] });
const app = express(); app.use(express.json({ limit: '2mb' }));
const api = express.Router(); installLibrarySync(api, options); installReaderState(api, options);
let turns = [{ id: 'question-1', question: 'What is the main idea?', answer: 'The answer from the existing desktop session.', state: 'complete' }];
turns[0].activities = [{ id: 'thinking', kind: 'thinking', text: 'Checking the relevant passage.', state: 'complete' },
 { id: 'tool', kind: 'tool', text: 'Shell node scripts/inspect.mjs…', detail: 'Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose Shell node scripts/inspect.mjs --input documents/notes.md --format markdown --include-annotations --verbose ', state: 'complete' }];
let busy = false, prompts = [], messages = [];
api.get('/info', (_req,res) => res.json({ pageborne: { conversationSync: 1, librarySync: 1 } }));
api.get('/pageborne/conversation', (req,res) => res.json({ version: 1, sessionId: req.query.sessionId, state: busy ? 'busy' : 'idle', turns }));
api.get('/events', (req,res) => { res.setHeader('Content-Type','text/event-stream'); res.write(': connected\n\n'); const timer = setInterval(() => res.write(': ping\n\n'), 1000); req.on('close', () => clearInterval(timer)); });
api.get('/sessions/history', (_req,res) => res.json({ sessions: [] }));
api.get('/sessions/:id/history', (_req,res) => res.json({ history: [] }));
api.get('/messages', (_req,res) => res.json({ state: busy ? 'busy' : 'idle', messages }));
api.post('/prompt', (req,res) => {
 const parsed = displayQuestion(req.body.text); prompts.push(req.body); busy = true;
 messages.push({ id: messages.length + 1, type: 'user_prompt', text: req.body.text });
 turns.push({ id: parsed.marker, ...parsed, answer: '', state: 'pending' });
 res.json({ sessionId: req.body.sessionId });
});
app.use('/api', api);
const backend = app.listen(0,'127.0.0.1'); await new Promise(r => backend.once('listening',r));
const built = !!process.env.WEB_BUILT;
const vite = built ? null : await createServer({ mode: 'web', plugins: [displayProbe(), { name: 'web-fixture', transform(code,id) {
 if (id.endsWith('/src/pdf.js')) return code.replace("  async open(content, mode, onProgress = () => {}, options = {}) {", "  async open(content, mode, onProgress = () => {}, options = {}) { if (window.__holdPdfOpen) await new Promise(resolve => { window.__releasePdfOpen = resolve; });");
 }, configureServer(server) { server.middlewares.use('/web/config', (req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ mode: 'terminal', endpoint: `http://${req.headers.host}`, token: 'fixture', agent: 'claude' })); }); } }], cacheDir: '.state/vite-web-test', server: { host:'127.0.0.1', port:0, hmr:false, watch:null, proxy: { '/api': `http://127.0.0.1:${backend.address().port}` } }, clearScreen: false });
await vite?.listen();
let production;
if (built) { production = createWebApp({ distDir: path.resolve(process.env.WEB_DIST || 'dist-web'), upstream: `http://127.0.0.1:${backend.address().port}`, upstreamToken: 'fixture', allowLocal: true }).listen(0, '127.0.0.1'); await new Promise(r => production.once('listening', r)); }
const baseUrl = production ? `http://127.0.0.1:${production.address().port}` : vite.resolvedUrls.local[0];
await mkdir('test-results/web-reader', { recursive: true });
const results = [];
try {
 for (const engine of (process.env.WEBKIT_ONLY ? [webkit] : process.env.WEB_BROWSER === 'chromium' ? [chromium] : [chromium, webkit])) {
  const browser = await engine.launch({ executablePath: engine === chromium ? process.env.CHROME_PATH || '/usr/bin/google-chrome' : process.env.WEBKIT_PATH, headless: true,
    args: engine === chromium ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--js-flags=--max-old-space-size=384'] : [] });
  try { for (const viewport of [{ width:393,height:852 },{ width:834,height:1194 },{ width:1440,height:900 }]) {
   const page = await browser.newPage({ viewport }); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
   let startupAttempts = 0;
   if (built) await page.route(/\/assets\/main-[\w-]+\.js$/, async route => { if (++startupAttempts === 1) await route.abort('failed'); else await route.continue(); });
   try {
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 30000 });
    await expect(page.locator('[data-document-id="paper.md"]')).toBeAttached({ timeout:30000 });
    if (built) { assert.equal(startupAttempts, 2); assert.equal(await page.locator('link[rel="modulepreload"]').count(), 0); }
    await page.locator('[data-document-id="paper.md"] .document-card').click();
    await expect(page.locator('#preview')).toBeVisible();
    await expect(page.locator('#passage')).toContainText('formatted');
    assert.equal(await page.evaluate(()=>window.unsafeMarkdown), undefined);
    assert.equal(await page.locator('#web-reading, #web-chat-dialog').count(), 0);
    await expect(page.locator('#preview-speak')).toBeEnabled();
    const before = await page.locator('#position').inputValue();
    // Reject native fullscreen, as on an unsupported browser; CSS must still work.
    await page.evaluate(() => { window.__nativeFullscreen = document.documentElement.requestFullscreen; document.documentElement.requestFullscreen = () => Promise.reject(new Error('Not supported')); });
    await page.locator('#preview-fullscreen').click();
    await expect(page.locator('.reader-fullscreen')).toBeVisible();
    await expect(page.locator('#preview-fullscreen')).toHaveAttribute('aria-label', 'Exit full screen');
    const checkFit = async () => {
      await expect.poll(async () => {
        const b = await page.locator('#preview').boundingBox(), v = page.viewportSize();
        return b.width > 200 && b.x >= 0 && b.y >= 0 && b.x+b.width <= v.width+1 && b.y+b.height <= v.height+1 && Math.abs(b.width / b.height - 2) < .01;
      }).toBe(true);
    };
    await checkFit();
    await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-fullscreen.png`});
    // Existing keyboard and touch navigation act on this same live view.
    await page.locator('#preview').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#position')).not.toHaveValue(before);
    const moved = await page.locator('#position').inputValue();
    await page.setViewportSize({width:852,height:393}); await checkFit();
    await page.keyboard.press('Escape');
    await expect(page.locator('.reader-fullscreen')).toHaveCount(0);
    await expect(page.locator('#position')).toHaveValue(moved);
    await page.setViewportSize(viewport);
    await page.locator('#ask-open').click();
    await expect(page.locator('#ask-messages')).toContainText('existing desktop session', {timeout:15000});
    await expect(page.locator('#ask-messages')).not.toContainText('Checking the relevant passage.');
    await expect(page.locator('.ask-message-activity')).toHaveCount(1);
    await expect(page.locator('#ask-chat-model')).toHaveValue('codex');
    await page.getByRole('button',{name:/^Go to the passage/}).first().click();
    assert(Number(await page.locator('#position').inputValue()) > 50);
    await page.locator('#ask-open').click();
    turns = [...turns,{id:'external',question:'Sent elsewhere',answer:'A synchronized reply.',state:'complete'}];
    if (!built) await page.evaluate(()=>window.__askUI.pollFooter());
    await expect(page.locator('#ask-messages')).toContainText('Sent elsewhere');
    await page.locator('#ask-question').fill('Unified first question'); await page.locator('#ask-send').click();
    await expect.poll(() => prompts.length).toBe(1);
    await page.locator('#ask-question').fill('Follow-up while busy'); await page.locator('#ask-send').click();
    await expect.poll(() => prompts.length).toBe(2);
    assert(prompts.every(p => p.sessionId === 'shared-paper'));
    turns.at(-2).state = 'complete'; turns.at(-2).answer = 'First answer';
    turns.at(-1).state = 'complete'; turns.at(-1).answer = 'Second answer'; busy = false;
    await expect(page.locator('#ask-messages')).toContainText('First answer');
    await expect(page.locator('#ask-answer')).toHaveText('Second answer');
    if (!built && engine === chromium) {
      // Real browser microphone + AudioWorklet; substitute only model inference.
      await page.evaluate(() => {
        const ask = window.__askUI;
        ask.speech.open = () => {}; ask.speech.vocabulary = () => [];
        ask.stream = { start(){}, receive(bytes){ window.__audioBytes = (window.__audioBytes || 0) + bytes.length; }, cancel(){}, finish: async () => ({ text: 'Question from the device microphone.' }) };
        const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => window.__micStream = await get(options);
        ask.returnToReading();
      });
      await page.locator('#preview-fullscreen').click();
      const hold = async selector => { const b = await page.locator(selector).boundingBox(); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down(); };
      await hold('#preview-speak');
      await expect.poll(() => page.evaluate(()=>window.__askUI.session.status)).toBe('listening');
      await expect.poll(() => page.evaluate(()=>window.__audioBytes || 0)).toBeGreaterThan(3200);
      await page.mouse.up();
      await expect.poll(() => page.evaluate(()=>window.__askUI.session.review?.text)).toBe('Question from the device microphone.');
      assert(await page.evaluate(()=>window.__micStream.getTracks().every(t=>t.readyState==='ended')));
      assert.equal(prompts.length,2,'release reviews without sending');
      await page.evaluate(()=>window.__askUI.cancelReview());
      await hold('#preview');
      await expect.poll(() => page.evaluate(()=>window.__askUI.session.status)).toBe('listening');
      await page.locator('#preview').dispatchEvent('pointercancel', {pointerId:1});
      await page.mouse.up();
      await expect.poll(() => page.evaluate(()=>window.__micStream.getTracks().every(t=>t.readyState==='ended'))).toBe(true);
      await page.keyboard.press('Escape');
      // Permission failure produces an actionable error and leaves typing usable.
      await page.evaluate(()=>{ navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Microphone permission denied','NotAllowedError');}; });
      await hold('#preview-speak'); await page.mouse.up();
      await expect.poll(() => page.evaluate(()=>window.__askUI.phoneMic.capturing)).toBe(false);
    }
    if (await page.locator('#library-panel').getAttribute('data-open') !== 'true') await page.locator('#library-toggle').click();
    if (!built) await page.evaluate(() => { window.__holdPdfOpen = true; });
    await page.locator('[data-document-id="original.pdf"] .document-card').click();
    if (!built) {
      await expect.poll(() => page.evaluate(() => typeof window.__releasePdfOpen),{timeout:30000}).toBe('function');
      await expect(page.locator('#preview-speak')).toBeDisabled();
      await expect(page.locator('#preview-speak')).toHaveText('PDF loading');
      assert.equal(await page.evaluate(() => window.__askUI.open()), false);
      await page.evaluate(() => { window.__holdPdfOpen = false; window.__releasePdfOpen(); });
    }
    await expect.poll(async()=>Number(await page.locator('#page-number').getAttribute('max')),{timeout:30000}).toBeGreaterThan(1);
    await expect(page.locator('#preview-speak')).toBeEnabled({timeout:30000});
    await expect(page.locator('#pdf-passage canvas').first()).toBeAttached({timeout:30000});
    if (!built) assert(await page.evaluate(()=>window.__askUI.snapshot().layout.blocks.some(block=>block.page === 2)));
    await page.locator('#preview-fullscreen').click(); await checkFit();
    await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-pdf.png`});
    await page.keyboard.press('Escape');
    await page.locator('#ask-open').click();
    await page.getByRole('button',{name:/^Go to the passage/}).first().click();
    await expect.poll(async()=>Number(await page.locator('#position').inputValue())).toBeGreaterThan(0);
    if (!built) assert.equal(await page.evaluate(async()=>{const {pdfAnchor}=await import('/src/pdf-layout.js'); const {layout,y}=window.__askUI.snapshot(); return pdfAnchor(layout,y).pdf.page;}),2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if (viewport.width === 1440 && engine === chromium) {
      await page.evaluate(() => { document.documentElement.requestFullscreen = window.__nativeFullscreen; });
      await page.locator('#preview-fullscreen').click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
      await page.evaluate(() => document.exitFullscreen());
      await expect(page.locator('.reader-fullscreen')).toHaveCount(0);
      assert.equal(await page.locator('.app').evaluate(el=>el.inert),false);
    }
    assert.deepEqual(errors,[]);
    results.push({browser:engine.name(),width:viewport.width,passed:true});
   } catch(error) { await page.screenshot({path:`test-results/web-reader/${engine.name()}-${viewport.width}-failure.png`}); console.error({errors,state:!built ? await page.evaluate(()=>{const a=window.__askUI,s=a.snapshot();return {y:s.y,paperKey:a.paperKey,turns:a.chat.turns(a.paperKey),page2:s.layout?.blocks.filter(b=>b.page===2).slice(0,1)}}) : null,text:(await page.locator('body').innerText()).slice(-1000)}); throw error; }
   finally { await page.close(); turns=turns.slice(0,1); busy=false; prompts=[]; messages=[]; }
  }} finally { await browser.close(); }
 }
 console.log(JSON.stringify(results,null,2));
} finally { await vite?.close(); production?.closeAllConnections(); production?.close(); backend.closeAllConnections(); backend.close(); await rm(root,{recursive:true,force:true}); }
