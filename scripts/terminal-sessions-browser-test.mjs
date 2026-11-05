// Real app and SDK gesture dispatch, with synthetic desktop and STT results.
// Does not submit to real sessions, download models, or claim BLE/audio accuracy.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { displayProbe } from './display-probe.mjs';
import { showLibrary } from './ui-helpers.mjs';
const out = 'test-results/terminal-sessions'; await mkdir(out, { recursive: true });
const vite = await createServer({ mode: 'release', plugins: [displayProbe(), { name: 'session-speech-fixture', transform(code, id) {
  if (id.endsWith('/src/speech-setup.js')) return code.replace('start(initialize) {', 'start(initialize) { this.blocked = false; return Promise.resolve();');
} }], cacheDir: '.state/vite-terminal-sessions', server: { host: '127.0.0.1', port: 0, hmr: false, watch: null }, clearScreen: false });
await vite.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--disable-gpu', '--js-flags=--max-old-space-size=384'] });
const report = { passed: false, errors: [], physicalGlasses: false }, prompts = [], lists = [], conversations = new Map(), storage = new Map();
let page;
try {
  page = await browser.newPage({ viewport: { width: 440, height: 806 } });
  page.on('pageerror', e => report.errors.push(e.message));
  await page.exposeFunction('__storage', ({ method, data }) => {
    if (method === 'getLocalStorage') return storage.get(data.key) || '';
    storage.set(data.key, data.value); return true;
  });
  await page.addInitScript(() => {
    window.__boxes = {}; window.__audio = [];
    window.flutter_inappwebview = { async callHandler(_, payload) {
      const m = JSON.parse(payload);
      if (m.method.endsWith('LocalStorage')) return window.__storage(m);
      if (m.method === 'audioControl') window.__audio.push(m.data);
      if (['createStartUpPageContainer', 'rebuildPageContainer'].includes(m.method)) window.__boxes = {};
      for (const t of (m.method === 'textContainerUpgrade' ? [m.data] : m.data?.textObject || [])) window.__boxes[t.containerName] = { ...window.__boxes[t.containerName], ...t };
      return ['createStartUpPageContainer', 'updateImageRawData'].includes(m.method) ? 0 : true;
    } };
  });
  let failClaude = false, listGate;
  const turns = (provider, id) => {
    const key = provider+':'+id;
    if (!conversations.has(key)) conversations.set(key, [{ id: 'original', question: `Earlier ${key} question`, answer: `Earlier ${key} answer`, state: 'complete' }]);
    return conversations.get(key);
  };
  await page.route('https://terminal.example/**', async route => {
    const u = new URL(route.request().url()), provider = u.searchParams.get('provider'), id = u.searchParams.get('sessionId');
    let result;
    if (u.pathname === '/api/sessions') {
      lists.push({ provider, limit: u.searchParams.get('limit') });
      // The loading frame must be replaced even when selection stays at zero.
      await new Promise(resolve => setTimeout(resolve, 450));
      if (listGate) await listGate;
      if (provider === 'claude' && failClaude) { await route.fulfill({ status: 503, body: '' }); return; }
      result = { sessions: Array.from({ length: provider === 'claude' ? 27 : 44 }, (_, i) => ({ id: `session-${i}`, title: `${provider} work ${i}`, timestamp: new Date(1700000000000+i*2000+(provider === 'codex' ? 1000 : 0)).toISOString(), status: 'idle' })) };
    } else if (u.pathname === '/api/info') result = { provider, pageborne: { conversationSync: 1, documents: 1 } };
    else if (u.pathname === '/api/pageborne/conversation') result = { version: 1, sessionId: id, state: 'idle', turns: turns(provider, id) };
    else if (u.pathname.endsWith('/history')) result = { history: [] };
    else if (u.pathname === '/api/messages') result = { state: 'idle', messages: turns(provider, id).flatMap((t, i) => [{ id: i*2+1, type: 'user_prompt', text: t.raw || t.question }, { id: i*2+2, type: 'result', success: true, text: t.answer }]) };
    else if (u.pathname === '/api/prompt') {
      const body = route.request().postDataJSON(); prompts.push(body);
      assert(body.sessionId, 'must continue an existing owner');
      // Deliberately emulate the old server returning our new wrapper raw.
      turns(provider, body.sessionId).push({ id: `new-${prompts.length}`, question: body.text, raw: body.text, answer: `Reply ${prompts.length}`, state: 'complete' });
      result = { sessionId: body.sessionId };
    } else if (u.pathname === '/api/events') { await route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }); return; }
    else if (['/api/pageborne/reader-state', '/api/pageborne/reading-activity'].includes(u.pathname)) { await route.fulfill({ status: 404, body: '' }); return; }
    else throw new Error('Unexpected API '+u.pathname);
    await route.fulfill({ json: result });
  });
  const boot = async () => {
    await page.goto(vite.resolvedUrls.local[0]);
    await expect(page.locator('#library-librarian')).toBeEnabled({ timeout: 30000 });
    await page.evaluate(() => {
      const ui = window.__askUI, options = ui.options.bind(ui);
      ui.options = () => ({ ...options(), origins: ['https://terminal.example'] });
      ui.saveConfig({ mode: 'terminal', endpoint: 'https://terminal.example', token: 'fixture', agent: 'claude', paperDirectories: true, cwd: '/unrelated/default' });
      ui.speech.open = () => {}; ui.stream.start = () => {}; ui.stream.cancel = () => {};
      ui.stream.finish = async () => ({ text: 'Update todo dot txt and agents dot md.', words: [] });
      ui.speech.result = () => {};
      const stop = ui.mic.stop.bind(ui.mic);
      ui.mic.stop = async () => { await stop(); return { kind: 'pcm-stream', bytes: 8000 }; };
    });
  };
  const gesture = eventType => page.evaluate(eventType => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { sysEvent: { eventType } } })), eventType);
  const menu = itemID => page.evaluate(itemID => window.dispatchEvent(new CustomEvent('evenHubEvent', { detail: { menuItemClickEvent: { itemID } } })), itemID);
  const selected = () => page.evaluate(() => { const p=window.__displayFrame?.picker; return p?.items[p.index]?.title; });
  const body = () => page.evaluate(() => window.__boxes.body?.content || '');
  const selectSession = async (provider, id) => {
    for (let i=0; i<80; i++) {
      const item=await page.evaluate(() => { const p=window.__displayFrame?.picker; return p?.items[p.index]?.session; });
      if (item?.provider===provider && item.id===id) { await gesture(0); return; }
      const before=await selected(); await gesture(2); await expect.poll(selected).not.toBe(before);
    }
    throw new Error('Session unreachable');
  };
  await boot();
  await expect.poll(selected).toBe('Librarian'); await gesture(2);
  await expect.poll(selected).toBe('Even Terminal sessions'); await gesture(0);
  await expect.poll(body).toContain('71 sessions'); assert(lists.every(r=>r.limit==='100'));
  await selectSession('codex','session-20');
  await expect(page.locator('#ask-history')).toContainText('Earlier codex:session-20 answer', { timeout: 15000 });
  await expect(page.locator('.ask-title-label')).toHaveText('Even Terminal');
  await expect(page.locator('#preview-speak')).toBeEnabled();
  await expect(page.locator('#ask-chat-model')).toBeDisabled(); await expect(page.locator('#ask-session-new')).toBeHidden();
  const key=await page.evaluate(()=>window.__askUI.paperKey);
  // Real hold/release dispatch and native microphone controls; STT output is synthetic.
  await page.evaluate(()=>window.__glasses.onAction('ask-hold'));
  await expect.poll(()=>page.evaluate(()=>window.__askUI.session.status)).toBe('listening');
  await page.evaluate(()=>window.__glasses.onAction('ask-release'));
  await expect.poll(()=>page.evaluate(()=>window.__askUI.session.review?.text)).toBe('Update todo.txt and agents.md.');
  await gesture(0);
  await expect.poll(()=>prompts.length).toBe(1);
  await expect.poll(()=>page.evaluate(()=>window.__askUI.session.status)).toBe('answer');
  assert.equal(prompts[0].sessionId,'session-20'); assert.equal(prompts[0].provider,'codex');
  assert.deepEqual(Object.keys(prompts[0]).sort(),['provider','sessionId','text']); assert(!prompts[0].text.includes('Reading context'));
  await expect(page.locator('#ask-history')).toContainText('Update todo.txt and agents.md.');
  await page.locator('#ask-question').fill('Draft for Codex');
  await gesture(0); await expect.poll(selected).toBe('Codex · codex work 20');
  await selectSession('claude','session-20');
  await expect(page.locator('#ask-history')).toContainText('Earlier claude:session-20 answer', { timeout: 15000 });
  await expect(page.locator('#ask-history')).not.toContainText('Update todo');
  await page.locator('#ask-question').fill('Draft for Claude');
  await gesture(0); await expect.poll(selected).toBe('Claude · claude work 20');
  await selectSession('codex','session-20');
  await expect(page.locator('#ask-question')).toHaveValue('Draft for Codex');
  assert.equal(await page.evaluate(()=>window.__askUI.paperKey),key);
  turns('codex','session-20').push({id:'other-device',question:'Sent from another device',answer:'Reply from another device',state:'complete'});
  await page.evaluate(()=>window.__askUI.pollFooter());
  await expect(page.locator('#ask-history')).toContainText('Reply from another device', { timeout:15000 });
  assert.equal(await page.evaluate(()=>window.__askUI.chat.turns(window.__askUI.paperKey).filter(t=>t.question.startsWith('Update todo')).length),1);
  await page.screenshot({path:`${out}/session.png`});
  await gesture(0); await expect.poll(body).toContain('71 sessions');
  failClaude=true; await page.evaluate(()=>window.__glasses.onAction('ask-hold')); await page.evaluate(()=>window.__glasses.onAction('ask-release'));
  await expect.poll(body).toContain('44 sessions'); await expect.poll(body).toContain('Claude unavailable');
  await page.locator('#preview').screenshot({path:`${out}/list.png`});
  failClaude=false; let release; listGate=new Promise(resolve=>{release=resolve;});
  await page.evaluate(()=>window.__glasses.onAction('ask-hold')); await page.evaluate(()=>window.__glasses.onAction('ask-release'));
  await gesture(3); await expect.poll(selected).toBe('Even Terminal sessions'); release(); listGate=null;
  await new Promise(resolve=>setTimeout(resolve,300)); await expect.poll(selected).toBe('Even Terminal sessions');
  // A document remains independently linked while browsing arbitrary sessions.
  await page.locator('#file-picker').setInputFiles({name:'paper.md',mimeType:'text/markdown',buffer:Buffer.from('# Paper\n\n'+ 'A private reading passage. '.repeat(120))});
  await showLibrary(page); await page.locator('[data-document-id="paper.md"] .document-card').click();
  await page.evaluate(()=>{const ui=window.__askUI;ui.open();ui.saveBinding(ui.paperKey,{sessionId:'document-owner'});});
  const documentKey=await page.evaluate(()=>window.__askUI.paperKey);
  await gesture(0); await menu(7);
  await expect.poll(selected).toBe('Paper'); await gesture(1); await expect.poll(selected).toBe('Even Terminal sessions'); await gesture(0);
  await expect.poll(body).toContain('71 sessions'); await selectSession('claude','session-19');
  await expect.poll(()=>page.evaluate(()=>window.__askUI.terminalSession)).toBe(true);
  assert.equal(await page.evaluate(k=>window.__askUI.readBindings()[k].sessionId,documentKey),'document-owner');
  assert.equal(await page.evaluate(()=>window.__askUI.session.context.passage),'');
  assert.equal(await page.evaluate(()=>window.__askUI.session.context.position),undefined);
  await gesture(0); await expect.poll(body).toContain('71 sessions'); await gesture(3); await gesture(3);
  await expect.poll(()=>page.evaluate(()=>window.__displayFrame?.picker)).toBeNull();
  // Reload preserves session history, not only the in-memory list.
  await boot(); await menu(7); await expect.poll(selected).toBe('Paper'); await gesture(1); await gesture(0);
  await expect.poll(body).toContain('71 sessions'); await selectSession('codex','session-20');
  await expect(page.locator('#ask-history')).toContainText('Update todo.txt and agents.md.');
  assert.equal(prompts.length,1,'no replay on switching or reload');
  await gesture(0); await expect.poll(selected).toBe('Codex · codex work 20');
  await page.evaluate(()=>{const ui=window.__askUI;ui.saveConfig({...ui.readConfig(),token:'other-fixture'});});
  await gesture(0);
  await expect(page.locator('#ask-panel')).toBeHidden();
  await expect.poll(body).toContain('71 sessions');
  assert.equal(prompts.length,1,'stale catalog cannot open a session under a changed connection');
  assert.deepEqual(report.errors,[]);
  Object.assign(report,{passed:true,sessionCount:71,overTenReachable:true,bothProviders:true,voiceReview:true,isolatedHistoryAndDrafts:true,liveSync:true,partialFailure:true,staleListIgnored:true,documentLinkPreserved:true,reload:true});
} catch(error) {
  report.error=error.stack; report.listRequests=lists;
  report.state=await page?.evaluate(()=>({body:window.__boxes.body?.content,status:window.__askUI?.session.status,error:window.__askUI?.session.error})).catch(()=>null);
  await page?.screenshot({path:`${out}/failure.png`}); throw error;
} finally { await writeFile(`${out}/results.json`,JSON.stringify(report,null,2)); await browser.close(); await vite.close(); }
console.log(JSON.stringify(report));
