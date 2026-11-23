// Exercise status symbols and real AskUI polling through the SDK in both browsers.
import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { showLibrary, chooseMode } from './ui-helpers.mjs';
import { displayProbe } from './display-probe.mjs';

process.env.PAGEBORNE_ASK_ORIGINS = 'https://status.test';
const out='test-results/ask-status'; await mkdir(out,{recursive:true});
const vite=await createServer({plugins:[displayProbe(),{name:'short-fixture-reply-timeout',transform(code,id){if(id.endsWith('/src/ask-terminal.js'))return code.replaceAll('timeoutMs: 15000','timeoutMs: 120');}}],cacheDir:'.state/vite-ask-status',optimizeDeps:{entries:['index.html']},server:{host:'127.0.0.1',port:0,hmr:false,watch:null},clearScreen:false});await vite.listen();
const results=[];
try {
  for(const engine of [chromium,webkit]) {
    const browser=await engine.launch({headless:true,executablePath:engine===chromium?'/usr/bin/google-chrome':process.env.WEBKIT_PATH});
    const page=await browser.newPage({viewport:{width:440,height:806}});
    const result={engine:engine.name(),errors:[],passed:false};results.push(result);
    page.on('pageerror',e=>result.errors.push(e.message));
    const storage=new Map(),prompts=[],messages=[];let state='idle', transport='ok', failAfterPost=false, polls=0;
    try {
      await page.exposeFunction('__storage',({method,data})=>{
        if(method==='getLocalStorage' && /^pageborne:models:v1:[a-f0-9]{64}$/.test(data.key))return JSON.stringify({id:'fixture',chunks:1,headers:{}});
        return method==='getLocalStorage'?storage.get(data.key)||'':(storage.set(data.key,data.value),true);
      });
      await page.addInitScript(()=>{
        if(!localStorage.getItem('even-reader:preferences:v1')) localStorage.setItem('even-reader:preferences:v1',JSON.stringify({ask:{mode:'terminal',endpoint:'https://status.test',token:'fixture',agent:'codex'}}));
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
          for(const t of texts){if(t.containerName==='commands')window.__commandColors.push(t.textColor);if(t.containerName==='body')window.__body=t.content;if(t.containerName==='status'){window.__status=t.content;window.__footerColors.push(t.textColor);}}
          return ['createStartUpPageContainer','updateImageRawData'].includes(m.method)?0:true;
        }};
      });
      await page.route('https://status.test/**',async route=>{
        const req=route.request(),url=new URL(req.url()),headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*'};
        if(req.method()==='OPTIONS')return route.fulfill({status:204,headers});
        const json=value=>route.fulfill({headers,json:value});
        if(url.pathname==='/api/info')return json({provider:'codex'});
        if(url.pathname==='/api/events')return route.fulfill({headers,contentType:'text/event-stream',body:': connected\n\n'});
        if(url.pathname.endsWith('/history'))return json({history:[]});
        if(req.method()==='GET' && ['/api/pageborne/library','/api/pageborne/library/activity','/api/pageborne/reading-activity','/api/pageborne/reader-state'].includes(url.pathname))return route.fulfill({status:404,headers,json:{}});
        if(url.pathname==='/api/messages') {
          polls++;
          if(transport==='network')return route.abort('failed');
          if(transport==='timeout')await new Promise(resolve=>setTimeout(resolve,300));
          if(transport==='unauthorized')return route.fulfill({status:401,headers,body:'Unauthorized'});
          return json({state,messages});
        }
        if(url.pathname==='/api/prompt'){prompts.push(req.postDataJSON());state='busy';messages.push({id:messages.length+1,type:'user_prompt',text:req.postDataJSON().text});if(failAfterPost)transport=typeof failAfterPost==='string'?failAfterPost:'network';return json({sessionId:'status-fixture'});}
        throw Error(`Unexpected route ${url.pathname}`);
      });
      const status=()=>page.evaluate(()=>window.__askUI.footerStatus());
      const body=()=>page.evaluate(()=>window.__body);
      const native=()=>page.evaluate(()=>window.__status);
      const stop=()=>page.evaluate(()=>window.__askUI.pollTimer?.cancel());
      const poll=async()=>{
        await expect.poll(()=>page.evaluate(()=>!!window.__askUI.polling)).toBe(false);
        await page.evaluate(async()=>{const ui=window.__askUI;ui.pollTimer?.cancel();await ui.pollFooter();ui.pollTimer?.cancel();});
      };
      const seed=binding=>page.evaluate(binding=>{const ui=window.__askUI;ui.close();ui.footerConnection=null;ui.saveBinding(ui.currentPaperKey(),binding);},binding);
      await page.goto(vite.resolvedUrls.local[0]);await expect(page.locator('#import')).toBeEnabled();await stop();
      await page.locator('#file-picker').setInputFiles({name:'status.md',mimeType:'text/markdown',buffer:Buffer.from('# Status paper\n\nKeep reading through temporary connection interruptions.')});
      await showLibrary(page);await page.locator('[data-document-id="status.md"] .document-card').click();
      await expect(page.locator('#bookmark')).toBeEnabled();await expect.poll(body).toMatch(/^Status paper\n/);const reading=await body();
      // A saved outage from a previous run is stale until current polling confirms it.
      const base={sessionId:'status-fixture',seenEventId:1};
      await seed({...base,notification:'offline'});assert.equal(await status(),'No new replies');
      transport='network';
      for(let i=0;i<2;i++){await poll();assert.equal(await status(),'No new replies');}
      await expect.poll(native).toMatch(/Tap: Ask$/);assert(!(await native()).includes('!'));
      await poll();assert.equal(await status(),'Connection lost');await expect.poll(native).toContain('↔ Hold: speak · Tap: Ask');
      transport='ok';await poll();assert.equal(await status(),'No new replies');
      await expect.poll(native).not.toContain('↔');assert.equal(await body(),reading);
      result.transientPollsDoNotFailAsk=result.confirmedOutageRecovers=result.persistedOutageRechecked=true;
      // Authentication failures are actionable immediately, not delayed as outages.
      transport='unauthorized';await poll();assert.equal(await status(),'Connection error');await expect.poll(native).toContain('! Hold: speak · Tap: Ask');
      transport='ok';await poll();assert.equal(await status(),'No new replies');
      // An unresolved agent failure stays visible through connection loss. A later
      // successful terminal result clears it without another question submission.
      messages.push({id:2,type:'user_prompt',text:'Desktop question'},{id:3,type:'error',text:'Temporary agent failure'});
      await poll();assert.equal(await status(),'Ask failed');await expect.poll(native).toContain('! Hold: speak · Tap: Ask');
      transport='network';await poll();assert.equal(await status(),'Ask failed');transport='ok';
      messages.push({id:4,type:'result',success:true,text:'Recovered desktop answer.'});await poll();
      assert.equal(await status(),'Unread reply');await expect.poll(native).toContain('● Hold: speak · Tap: Ask');assert.equal(prompts.length,0);
      result.actualErrorsRetained=result.successSupersedesOldError=true;
      // Permissions remain distinct from failures and also retain their hint.
      messages.splice(0);state='awaiting_permission';await seed(base);await poll();assert.equal(await status(),'Needs a response');
      for(const mode of ['page','auto','speed']){
        await chooseMode(page,mode);await expect.poll(native).toMatch(mode==='page'?/\? Hold: speak · Tap: Ask$/:/\? Hold: speak · 2×(?: tap)?: Ask$/);
      }
      state='idle';await poll();await chooseMode(page,'page');
      // A submitted request can lose its response transport. Keep its correlation
      // marker, recover the reply and clear the live error without reposting.
      await seed(base);failAfterPost=true;await page.locator('#ask-open').click();
      await page.locator('#ask-question').fill('Recover this reply without resending');await page.locator('#ask-send').click();
      await expect.poll(()=>page.evaluate(()=>window.__askUI.session.status)).toBe('error');await stop();
      assert.equal(prompts.length,1);assert.equal(await status(),'Reply pending');
      await poll();assert.equal(await status(),'Reconnecting…');await expect.poll(native).toContain('↔ Hold to retry · Tap: Ask');
      transport='ok';state='idle';messages.push({id:messages.length+1,type:'result',success:true,text:'Recovered after a network interruption.'});
      // The phone can miss several turns while disconnected. Recover its own
      // completed answer first; the later desktop prompt is not a conflict.
      messages.push({id:messages.length+1,type:'user_prompt',text:'A later question on the desktop'});
      messages.push({id:messages.length+1,type:'result',success:true,text:'The later desktop answer.'});await poll();
      assert.equal(await status(),'Unread reply');assert.equal(await page.evaluate(()=>window.__askUI.session.status),'answer');
      assert.equal(prompts.length,1);assert.equal(await body(),reading);
      await expect.poll(native).toContain('● Hold: speak · Tap: Ask');
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('evenHubEvent',{detail:{sysEvent:{eventType:0}}})));
      await expect.poll(body).toContain('Recovered after a network interruption.');
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('evenHubEvent',{detail:{sysEvent:{eventType:0}}})));
      await expect.poll(body).toBe(reading);await poll();
      assert.equal(await status(),'Unread reply');assert.equal(prompts.length,1);
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('evenHubEvent',{detail:{sysEvent:{eventType:0}}})));
      await expect.poll(body).toContain('The later desktop answer.');
      result.completedReplyBeforeLaterQuestion=true;
      await seed(base);messages.splice(0);state='idle';failAfterPost='timeout';
      await page.locator('#ask-open').click();
      await page.locator('#ask-question').fill('Wait through a timed-out reply read');await page.locator('#ask-send').click();
      await expect.poll(status).toBe('Reconnecting…');
      assert.equal(await page.evaluate(()=>window.__askUI.session.status),'thinking');
      assert.equal(prompts.length,2);
      transport='ok';state='idle';messages.push({id:messages.length+1,type:'result',success:true,text:'Recovered after timeout.'});
      await expect.poll(()=>page.evaluate(()=>window.__askUI.session.status)).toBe('answer');
      assert.equal(prompts.length,2);assert.equal(await body(),reading);
      assert.equal(await page.evaluate(()=>window.__askUI.session.answer),'Recovered after timeout.');
      result.timedOutReadReconnectedWithoutFailedTurn=true;
      result.pendingRecoveryClearsLiveError=result.noDuplicateSubmission=result.modeGuidance=true;
      assert.deepEqual([...new Set(await page.evaluate(()=>window.__footerColors))],[4]);
      assert.deepEqual([...new Set(await page.evaluate(()=>window.__commandColors))],[1]);
      assert.deepEqual(result.errors,[]);result.polls=polls;result.passed=true;
      await page.locator('#preview').screenshot({path:`${out}/${engine.name()}-recovered.png`});
    } catch(error){result.failure=error.stack;await page.screenshot({path:`${out}/${engine.name()}-failure.png`,fullPage:true});throw error;}
    finally{await browser.close();console.log(JSON.stringify(result));}
  }
} finally{await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));await vite.close();}
