// Glasses read positions are based on acknowledged SDK frames, not phone chat
// rendering or reply arrival. Replies never navigate, including old auto settings.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, showSettings, hideSettings, chooseMode } from './ui-helpers.mjs';
import { displayProbe } from './display-probe.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://unread.test';
const out='test-results/ask-unread'; await mkdir(out,{recursive:true});
const vite=await createServer({plugins:[displayProbe()],cacheDir:'.state/vite-ask-unread',optimizeDeps:{entries:['index.html']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},clearScreen:false});await vite.listen();
const results=[];
try {
  for(const engine of [chromium,webkit].filter(engine=>!process.env.ASK_BROWSER||engine.name()===process.env.ASK_BROWSER)) {
    const browser=await engine.launch({headless:true,args:engine===chromium?['--disable-gpu']:[],executablePath:engine===chromium?(process.env.CHROME_PATH||'/usr/bin/google-chrome'):process.env.WEBKIT_PATH});
    const page=await browser.newPage({viewport:{width:440,height:806}});
    const result={engine:engine.name(),errors:[],passed:false};results.push(result);
    page.on('pageerror',e=>result.errors.push(e.message));
    const storage=new Map(),prompts=[],messages=[];let state='idle';
    try {
      await page.exposeFunction('__storage',({method,data})=>{
        if(method==='getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key))return JSON.stringify({id:'fixture',chunks:1,headers:{}});
        return method==='getLocalStorage'?storage.get(data.key)||'':(storage.set(data.key,data.value),true);
      });
      await page.addInitScript(legacyAuto=>{
        if(!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1',JSON.stringify({...(legacyAuto?{askReplyView:'auto'}:{}),ask:{mode:'terminal',endpoint:'https://unread.test',token:'fixture',agent:'codex'}}));
        const NativeWorker=Worker;
        window.Worker=class {
          constructor(url,options){if(!String(url).includes('ensemble-worker'))return new NativeWorker(url,options);}
          postMessage(data){if(data.operation==='prepare')queueMicrotask(()=>this.onmessage?.({data:{id:data.id,result:{backend:'wasm',verified:true}}}));}
          terminate(){}
        };
        window.__body='';window.__status='';window.__footerColors=[];window.__commandColors=[];
        window.flutter_inappwebview={async callHandler(_,payload){
          const m=JSON.parse(payload);if(m.method.endsWith('LocalStorage'))return window.__storage(m);
          const texts=m.method==='textContainerUpgrade'?[m.data]:m.data?.textObject||[];
          if(window.__holdDisplay && texts.some(t=>t.containerName==='body')) {
            window.__holdDisplay=false;await new Promise(resolve=>window.__releaseDisplay=resolve);
          }
          for(const t of texts){if(t.containerName==='body')window.__body=t.content;if(t.containerName==='status'){window.__status=t.content;window.__footerColors.push(t.textColor);}if(t.containerName==='commands')window.__commandColors.push(t.textColor);}
          return ['createStartUpPageContainer','updateImageRawData'].includes(m.method)?0:true;
        }};
      },engine.name()==='webkit');
      await page.route('https://unread.test/**',async route=>{
        const req=route.request(),url=new URL(req.url()),headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
        const json=value=>route.fulfill({headers,json:value});
        if(url.pathname==='/api/info')return json({provider:'codex'});
        if(url.pathname==='/api/events')return route.fulfill({headers,contentType:'text/event-stream',body:': connected\n\n'});
        if(url.pathname.endsWith('/history'))return json({history:[]});
        if(url.pathname.startsWith('/api/pageborne/'))return route.fulfill({status:404,headers,json:{}});
        if(url.pathname==='/api/messages')return json({state,messages});
        if(url.pathname==='/api/prompt'){prompts.push(req.postDataJSON());state='busy';messages.push({id:messages.length+1,type:'user_prompt',text:req.postDataJSON().text});return json({sessionId:'unread-fixture'});}
        throw Error(`Unexpected route ${url.pathname}`);
      });
      const emit=(text,complete=false)=>{messages.push({id:messages.length+1,type:complete?'result':'text_delta',text,...(complete?{success:true}:{})});if(complete)state='idle';};
      const body=()=>page.evaluate(()=>window.__body);
      const settled=()=>expect.poll(()=>page.evaluate(()=>window.__askUI.session.status),{timeout:15000}).toBe('answer');
      const event=eventType=>page.evaluate(eventType=>window.dispatchEvent(new CustomEvent('evenHubEvent',{detail:{sysEvent:{eventType}}})),eventType);
      const openPaper=async name=>{await showLibrary(page);await page.locator(`[data-document-id="${name}.md"] .document-card`).click();await expect(page.locator('#bookmark')).toBeEnabled();await expect.poll(body).toMatch(new RegExp(`^${name}\\n`));};
      const answer=n=>Array.from({length:32},(_,i)=>`REPLY${n} Step ${i}. Explanation of this point.`).join('\n\n');
      const finishReading=async()=>{
        for(let i=0;i<100;i++) {
          if(await page.locator('#next').isDisabled())return;
          const before=await body();await event(2);await expect.poll(body).not.toBe(before);
          const visibleLines=(await body()).split('\n').map(s=>s.trim()).filter(s=>s.startsWith('REPLY'));
          const priorLines=before.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('REPLY'));
          assert(!visibleLines.some(line=>priorLines.includes(line)),'Ask page turns must not repeat a displayed line');
        }
        throw Error('Conversation never reached the end');
      };
      const ask=async question=>{await page.locator('#ask-open').click();await page.locator('#ask-question').fill(question);await page.locator('#ask-send').click();await expect.poll(()=>prompts.at(-1)?.text||'').toContain(question);};
      await page.goto(vite.resolvedUrls.local[0]);await expect(page.locator('#import')).toBeEnabled();
      await page.locator('#file-picker').setInputFiles(['paper','other','default'].map(name=>({name:`${name}.md`,mimeType:'text/markdown',buffer:Buffer.from(`# ${name}\n\nReading the paper.`)})));
      await openPaper('default');const defaultReading=await body();
      await showSettings(page);await expect(page.locator('#ask-reply-view')).toHaveCount(0);await hideSettings(page);
      await ask('Stay in reading by default');emit('DEFAULT completed reply.',true);
      await expect.poll(()=>page.evaluate(()=>window.__status),{timeout:15000}).toContain('● Hold: speak · Tap: Ask');
      assert.equal(await body(),defaultReading,'reply completion must not leave reading with an unset preference');
      await event(0);await expect.poll(body).toContain('DEFAULT completed reply.');
      await event(0);await expect.poll(body).toBe(defaultReading);
      for(const mode of ['auto','speed']) {
        await chooseMode(page,mode);
        await expect.poll(()=>page.evaluate(()=>window.__status)).toMatch(/Hold: speak · 2×(?: tap)?: Ask$/);
        await event(3);await expect.poll(body).toContain('DEFAULT completed reply.');
        await event(0);await expect.poll(()=>page.evaluate(()=>window.__status)).toMatch(/Hold: speak · 2×(?: tap)?: Ask$/);
      }
      await chooseMode(page,'page');
      result.repliesNeverSwitch=true;result.modeSpecificAskGesture=true;

      await openPaper('paper');const reading=await body();
      await ask('Explain the first part');emit(answer(1));
      await expect(page.locator('#ask-answer')).toContainText('REPLY1 Step 31.',{timeout:15000});assert.equal(await body(),reading);
      emit(answer(1),true);
      await settled();
      assert.equal(await body(),reading,'completed replies never navigate automatically');
      await event(0);await expect.poll(body).toContain('REPLY1 Step 0.');
      assert(!(await body()).includes('Step 31.'),'manual opening must start at the unread beginning');
      const first=await body();await event(0);await expect.poll(body).toBe(reading);
      // Opening only the phone tab must not consume another glasses page.
      await page.locator('#ask-open').click();assert.equal(await body(),reading);
      await event(0);await expect.poll(body).not.toBe(reading);const second=await body();
      assert.notEqual(second,first);assert(!second.includes('Step 0.'));assert(!second.includes('Step 31.'));
      await page.locator('#preview').screenshot({path:`${out}/${engine.name()}-first-unread.png`});
      await finishReading();assert((await body()).includes('REPLY1 Step 31.'));
      const tail=await body();await event(1);await expect.poll(body).not.toBe(tail);const older=await body();
      assert(!older.split('\n').map(s=>s.trim()).filter(s=>s.startsWith('REPLY')).some(line=>tail.split('\n').map(s=>s.trim()).includes(line)),'previous page must not overlap the final page');
      await event(0);await expect.poll(body).toBe(reading);await event(0);await expect.poll(body).toBe(older);
      result.manualFirstUnread=result.partialReturn=result.noUnreadKeepsPlace=result.zeroPageOverlap=true;
      // New replies can finish while the paper remains visible. A stalled SDK
      // frame must not count as read if the reader leaves before it arrives.
      await event(0);
      await ask('Explain the second part');emit(answer(2),true);await expect(page.locator('#ask-answer')).toContainText('REPLY2 Step 31.',{timeout:15000});
      await settled();assert.equal(await body(),reading);
      await page.evaluate(()=>window.__holdDisplay=true);await event(0);await expect.poll(()=>page.evaluate(()=>!!window.__releaseDisplay)).toBe(true);
      await event(0);await page.evaluate(()=>window.__releaseDisplay());await expect.poll(body).toBe(reading);
      await event(0);await expect.poll(body).toContain('REPLY2 Step 0.');
      await event(0);await expect.poll(body).toBe(reading);
      // Persist the unread boundary through another paper and a full reload.
      await openPaper('other');await event(0);await expect.poll(body).toContain('Hold to speak');await event(0);
      await openPaper('paper');await page.reload();await expect(page.locator('#import')).toBeEnabled();await openPaper('paper');
      await event(0);await expect.poll(body).toContain('REPLY2');assert(!(await body()).includes('Step 0.'));assert(!(await body()).includes('Step 31.'));
      await finishReading();await event(0);await expect.poll(body).toBe(reading);
      result.manualFirstUnread=result.onlyAcceptedFrames=result.paperIsolation=result.reload=true;
      // Start reading a streamed reply, leave, and return after it has grown.
      await ask('Explain the third part');emit(answer(3).split('\n\n').slice(0,12).join('\n\n'));
      await expect(page.locator('#ask-answer')).toContainText('REPLY3 Step 11.',{timeout:15000});await event(0);
      await expect.poll(body).toContain('REPLY3 Step 0.');await event(0);await expect.poll(body).toBe(reading);
      emit(answer(3).split('\n\n').slice(12).join('\n\n'));emit(answer(3),true);
      await settled();await event(0);
      await expect.poll(body).toContain('REPLY3');assert(!(await body()).includes('Step 0.'));assert(!(await body()).includes('Step 31.'));
      const held=await body();await page.waitForTimeout(1200);assert.equal(await body(),held,'arriving progress must not pull the unread page to the tail');
      result.streamingUnread=true;
      // Keep Ask open at its end through another submission. A short initial
      // chunk retains the question; a growing reply stops at its first page.
      await finishReading();await ask('Explain the fourth part');
      const fourth=answer(4), firstChunk='REPLY4 Step 0.', middle=fourth.split('\n\n').slice(0,12).join('\n\n'), more=fourth.split('\n\n').slice(0,24).join('\n\n');
      emit(firstChunk);await expect.poll(body,{timeout:15000}).toContain(firstChunk);
      assert((await body()).includes('Explain the fourth part'));
      emit(middle.slice(firstChunk.length));await expect.poll(body,{timeout:15000}).toMatch(/^REPLY4 Step 0\./);
      const firstReply=await body();
      emit(more.slice(middle.length));await expect(page.locator('#ask-answer')).toContainText('REPLY4 Step 23.',{timeout:15000});
      await expect.poll(body).toBe(firstReply);
      await page.locator('#preview').screenshot({path:`${out}/${engine.name()}-open-reply-start.png`});
      await event(2);await expect.poll(body).not.toBe(firstReply);const chosen=await body();
      emit(fourth,true);await settled();
      await expect.poll(body).toBe(chosen);
      result.openReplyStart=result.streamingKeepsChosenPage=true;
      // Final-only responses behave the same, and manual scrolling while
      // waiting takes precedence over opening the beginning of a new reply.
      await finishReading();await ask('Explain the fifth part');emit(answer(5),true);
      await settled();
      await expect.poll(body).toMatch(/^REPLY5 Step 0\./);
      await finishReading();await ask('Explain the sixth part');
      const waiting=await body();await event(1);await expect.poll(body).not.toBe(waiting);const scrolledBack=await body();
      emit(answer(6),true);await settled();
      await expect.poll(body).toBe(scrolledBack);
      result.finalOnlyReplyStart=result.manualScrollWhileWaiting=true;
      // A follow-up asked partway through an answer must resume at that
      // follow-up, not jump backward to the abandoned answer's unread tail.
      await event(0); await expect.poll(body).toBe(reading); await event(0);
      await expect.poll(body).toContain('REPLY6 Step 0.');
      await ask('Explain the seventh part');
      await event(0);await expect.poll(body).toBe(reading);
      emit(answer(7),true);await expect(page.locator('#ask-answer')).toContainText('REPLY7 Step 31.',{timeout:15000});
      await event(0);await expect.poll(body).toContain('REPLY7 Step 0.');
      result.followupReturnStartsNewReply=true;
      await ask('Explain the eighth part');await event(0);await expect.poll(body).toBe(reading);
      await event(0);await expect.poll(body).toContain('Explain the eighth part');
      const eighth=answer(8), partial=eighth.split('\n\n').slice(0,12).join('\n\n');
      emit(partial);await expect.poll(body,{timeout:15000}).toContain('REPLY8 Step 0.');
      await event(0);await expect.poll(body).toBe(reading);emit(eighth,true);await settled();
      await event(0);await expect.poll(body).toContain('REPLY8');assert(!(await body()).includes('Step 0.'));
      result.pendingFollowupReturn=result.partialFollowupReturn=true;
      // Phone chat also follows its latest reply after being hidden. It must
      // not retain the obsolete bottom offset from before that reply arrived.
      await ask('Explain the ninth part');await page.waitForTimeout(100);
      await page.locator('#tab-outline').click();emit(answer(9),true);await settled();
      await page.locator('#ask-open').click();
      const bottomGap=()=>page.locator('#ask-history').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop);
      await expect.poll(bottomGap).toBeLessThan(2);
      await page.locator('#ask-history').evaluate(el=>el.scrollTop=250);await page.waitForTimeout(100);
      const top=await page.locator('#ask-history').evaluate(el=>el.scrollTop);
      await page.locator('#tab-outline').click();await page.locator('#ask-open').click();
      await expect.poll(()=>page.locator('#ask-history').evaluate(el=>el.scrollTop)).toBe(top);
      result.phoneHiddenFollow=result.phoneScrollbackReturn=true;
      assert.equal(prompts.length,10);assert.deepEqual(await page.evaluate(()=>[...new Set(window.__footerColors)]),[4]);assert.deepEqual(await page.evaluate(()=>[...new Set(window.__commandColors)]),[1]);assert.deepEqual(result.errors,[]);result.passed=true;
    } catch(e){result.failure=e.stack;await page.screenshot({path:`${out}/${engine.name()}-failure.png`}).catch(()=>{});}
    finally{await browser.close();console.log(JSON.stringify(result));}
  }
}finally{await vite.close();await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
