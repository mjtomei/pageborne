import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSCRIPTION_HINT } from '../src/controls.js';
import { askContext, AskSession, AskMicrophone, pcmWave } from '../src/ask.js';
import { nativeLayout, byteLength } from '../src/native-text.js';
import { parseDocument } from '../src/document.js';
import { checkAskConnection } from '../src/ask-client.js';
import { askOrigins, askManifest } from '../ai/build.js';
import { contextTokens, MAX_CONTEXT_CHARS } from '../ai/context.js';
import { inferenceInput } from '../ai/providers.js';
const tick = () => new Promise(r => setImmediate(r));

test('asking captures a bounded current passage, not all documents, including PDF source and partial status', () => {
  const doc = nativeLayout(parseDocument('# Title\n\n' + Array.from({ length: 100 }, (_, i) => `PARAGRAPH${i} ${'Example words. '.repeat(90)}`).join('\n\n')));
  const y = doc.blockY[51]; const context = askContext(doc, y, 'Example', undefined, 3500);
  assert(context.passage.includes('PARAGRAPH50')); assert(!context.passage.includes('PARAGRAPH0 ')); assert(context.passage.length <= 14000);
  const long = nativeLayout(parseDocument('Repeated phrase. '.repeat(1000) + 'CURRENT_MARKER ' + 'Afterward. '.repeat(500)));
  const current = long.rows.find(r => r.text.includes('CURRENT_MARKER'));
  assert(askContext(long, current.y, 'Long paragraph').passage.includes('CURRENT_MARKER'));
  const pdf = { format: 'pdf', blocks: [{ y: 0, page: 5, text: 'surrounding text', reflow: { text: 'surrounding text', rows: [] } }, { y: 400, page: 5, text: 'Figure 1' }], maxY: 500, preparation: { complete: false } };
  const p = askContext(pdf, 450, 'Paper'); assert.equal(p.page, 5); assert(p.image); assert(p.partial); assert(p.passage.includes('surrounding text'));
});

test('default context includes about 100k estimated tokens centered on the reading place and fills space at document edges', () => {
  const text = 'START ' + 'before '.repeat(70000) + 'CURRENT_MARKER ' + 'after '.repeat(80000) + ' END';
  const offset = text.indexOf('CURRENT_MARKER');
  const layout = { format: 'pdf', maxY: 100, blocks: [{ y: 0, page: 7, reflow: { text, rows: [{ y: 0, start: offset, text: 'CURRENT_MARKER' }] } }] };
  const middle = askContext(layout, 0, 'Long paper');
  assert.equal(middle.passage.length, 400000); assert.equal(middle.estimatedTokens, 100000);
  assert.equal(middle.passage.indexOf('CURRENT_MARKER'), 200000); assert(!middle.passage.includes('START')); assert(!middle.passage.includes('END'));
  assert.equal(middle.focusOffset, middle.passage.indexOf('CURRENT_MARKER'));
  assert(inferenceInput({ context: middle, question: 'Explain?' })[0].content.includes('CURRENT_MARKER'));
  layout.blocks[0].reflow.rows[0].start = 0;
  assert(askContext(layout, 0, 'Long paper').passage.startsWith('START')); assert.equal(askContext(layout, 0, 'Long paper').passage.length, 400000);
  assert.equal(askContext(layout, 0, 'Long paper').focusOffset, 0);
  layout.blocks[0].reflow.rows[0].start = text.length - 4;
  assert(askContext(layout, 0, 'Long paper').passage.endsWith(' END'));
  assert.equal(askContext(layout, 0, 'Long paper').focusOffset, 399996);
  const small = nativeLayout(parseDocument('# Small\n\nFirst paragraph.\n\nLast paragraph.'));
  assert.match(askContext(small, 0, 'Small').passage, /Small[\s\S]*First paragraph[\s\S]*Last paragraph/);
  assert.equal(contextTokens(undefined), 100000); assert.equal(contextTokens(100), 1000); assert.equal(contextTokens(999999), 200000);
  assert.throws(() => inferenceInput({ context: { passage: 'x'.repeat(MAX_CONTEXT_CHARS + 1) }, question: 'Explain?' }), /Invalid/);
});

test('vocabulary receives the correct source offset for repeated Markdown and PDF lines', () => {
  const text = 'Same sentence. '.repeat(500);
  const md = nativeLayout(parseDocument(text));
  const row = md.rows.at(-3), context = askContext(md, row.y, 'Repeated', undefined, 1000);
  const start = text.lastIndexOf(context.passage);
  assert.equal(context.focusOffset, row.offset - start);
  const pdf = { format: 'pdf', maxY: 50, blocks: [{ y: 0, page: 1, reflow: { text, rows: [{ y: 0, start: 6000, text: 'Same sentence.' }] } }] };
  const p = askContext(pdf, 0, 'Repeated', undefined, 1000);
  assert(p.focusOffset > p.passage.indexOf(p.focus), 'Use the source offset, not the first identical sentence');
  assert(p.passage.slice(p.focusOffset).startsWith('Same sentence.'));
});

test('partial answers are readable while thinking, preserve the answer page on completion, and reject late chunks after closing', async () => {
  const s = new AskSession(); s.open({ passage: 'Source' }); let update, finish;
  const pending = s.send('Explain?', (_body, _signal, progress) => { update = progress; return new Promise(r => { finish = r; }); });
  assert.equal(s.status, 'thinking'); const first = s.frame();
  assert(s.tick(1000)); assert.equal(s.frame().body, first.body); assert.notEqual(s.frame().status, first.status); s.tick(1900, true); assert.equal(s.phase, 0);
  update('Writing answer…', 'An incremental answer. '.repeat(150));
  assert.equal(s.status, 'thinking'); assert.match(s.frame().body, /incremental/); assert.equal(s.history.length, 0);
  s.move(1); const y = s.y; assert(y > 0);
  update('Writing answer…', 'An incremental answer. '.repeat(250)); assert.equal(s.y, y);
  finish({ answer: 'An incremental answer. '.repeat(300) }); await pending; assert.equal(s.status, 'answer'); assert.equal(s.y, y);
  let late, finishLate; const next = s.send('Follow-up?', (_body, _signal, progress) => { late = progress; return new Promise(r => { finishLate = r; }); });
  assert.equal(s.answer, ''); s.close(); s.open({ passage: 'Different paper' });
  late('Writing answer…', 'Wrong paper'); finishLate({ answer: 'Wrong paper' }); await next;
  assert.equal(s.answer, ''); assert.equal(s.status, 'ready');
});

test('recording scrolls only its transcript and thinking keeps the preceding answer scrollable', async () => {
  const s = new AskSession(); s.open({ passage: 'Source' });
  s.showAnswer('PREVIOUS ANSWER. '.repeat(300)); s.move(1);
  for (const status of ['starting', 'listening', 'transcribing']) {
    const body = s.frame().body; s.setStatus(status); assert.equal(s.frame().body, body);
    const before = s.y; s.move(1); assert.equal(s.y, before); assert.match(s.frame().status, /Ask/);
  }
  s.voiceProgress = 'Loading speech model · 25%'; assert.match(s.frame().status, /25%/);
  const y = s.y, body = s.frame().body; let update, finish;
  const pending = s.send('A follow-up', (_body, _signal, progress) => { update = progress; return new Promise(r => finish = r); });
  assert.equal(s.answer, ''); assert.equal(s.y, y); assert.equal(s.frame().body, body);
  update('Sharing original.pdf · 50%…'); assert.equal(s.answer, ''); assert.equal(s.frame().body, body); assert.match(s.frame().status, /50%/);
  s.move(-1); assert(s.y < y);
  update('Writing answer…', 'NEW ANSWER. '.repeat(150)); assert.equal(s.y, 0); assert.match(s.frame().body, /NEW ANSWER/);
  s.move(1); const readY = s.y; finish({ answer: 'NEW ANSWER. '.repeat(200) }); await pending; assert.equal(s.y, readY);
});

test('a pending follow-up can restore its old visible answer, and errors leave that answer readable', () => {
  const s = new AskSession(); s.open({ passage: 'Source' }, [{ role: 'assistant', content: 'Completed reply. '.repeat(100) }]);
  s.setStatus('thinking'); assert.match(s.frame().body, /Completed reply/); assert.equal(s.answer, '');
  s.move(1); const view = { answer: '', displayAnswer: s.displayAnswer, y: s.y };
  s.close(); s.open({ passage: 'Source' }); s.setStatus('thinking'); s.restoreView(view);
  assert.equal(s.y, view.y); assert.equal(s.answer, ''); assert(s.showingPrevious);
  const body = s.frame().body; s.fail(new Error('Connection lost')); assert.equal(s.frame().body, body); assert.match(s.frame().status, /Connection lost/);
  s.move(-1); assert(s.y < view.y);
});

test('transcription review is unsent, can cancel at the same answer position, and sending consumes the draft once', async () => {
  const s = new AskSession(); s.open({ passage: 'Source' }); s.showAnswer('Previous answer. '.repeat(200)); s.move(1);
  const y = s.y, body = s.frame().body; s.reviewQuestion('What does **this** mean?');
  assert.equal(s.status, 'review'); assert.equal(s.frame().body, body); assert.equal(s.history.length, 0);
  assert.equal(s.frame().dialog.text, 'What does **this** mean?'); assert.equal(s.review.page, 0);
  s.move(1); assert.equal(s.review.page, 0); assert.equal(s.y, y);
  s.cancelReview(); assert.equal(s.status, 'answer'); assert.equal(s.frame().body, body); assert.equal(s.y, y);
  s.reviewQuestion('Edited question'); let posts = 0, finish;
  const request = body => { posts++; assert.equal(body.question, 'Edited question'); return new Promise(resolve => finish = resolve); };
  const sending = s.send(s.review.text, request); assert.equal(s.review, null);
  await s.send('Edited question', request); assert.equal(posts, 1);
  finish({ answer: 'New answer' }); await sending; assert.equal(s.history.length, 2);
  s.reviewQuestion('Do not send'); s.close(); s.open({ passage: 'Other paper' }); assert.equal(s.review, null);
});

test('a native follow-up replaces only reply observation and ignores old progress and completion', async () => {
  const s = new AskSession(); s.open({ passage: 'Source' });
  let firstProgress, firstFinish, secondFinish, firstSignal;
  const first = s.send('First', (_input, signal, progress) => {
    firstSignal = signal; firstProgress = progress; return new Promise(resolve => { firstFinish = resolve; });
  });
  firstProgress('Writing', 'First partial');
  const second = s.send('Follow-up', (_input, _signal, progress) => {
    progress('Writing', 'Second partial'); return new Promise(resolve => { secondFinish = resolve; });
  }, { replace: true });
  assert(firstSignal.aborted); assert.equal(s.answer, 'Second partial');
  firstProgress('Writing', 'Late first chunk'); firstFinish({ answer: 'Late first result' }); await first;
  assert.equal(s.answer, 'Second partial'); assert.equal(s.status, 'thinking');
  secondFinish({ answer: 'Second result' }); await second;
  assert.equal(s.answer, 'Second result'); assert.equal(s.status, 'answer');
});

test('reply progress, success and failure preserve an independent voice draft and review', async () => {
  for (const fail of [false, true]) {
    const s = new AskSession(); s.open({ passage: 'Source' });
    let progress, finish, reject;
    const pending = s.send('First', (_input, _signal, update) => {
      progress = update; return new Promise((resolve, failure) => { finish = resolve; reject = failure; });
    });
    s.setStatus('listening'); s.updateTranscription('Spoken follow-up');
    progress('Writing', 'Live answer'); assert.equal(s.answer, 'Live answer');
    assert.equal(s.status, 'listening'); assert.equal(s.voiceDraft, 'Spoken follow-up');
    s.reviewQuestion(s.voiceDraft);
    if (fail) reject(new Error('Reply disconnected')); else finish({ answer: 'Finished answer' });
    await pending;
    assert.equal(s.status, 'review'); assert.equal(s.review.text, 'Spoken follow-up');
    s.cancelReview(); assert.equal(s.status, fail ? 'error' : 'answer');
    assert.equal(s.answer, fail ? 'Live answer' : 'Finished answer');
  }
});

test('long transcriptions can be read completely in bounded native pages before confirmation', () => {
  const s = new AskSession(); s.open({ passage: 'Source' });
  const words = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
  s.reviewQuestion(words); assert(s.review.pages.length > 1); assert.equal(s.review.page, 0);
  const pages = [];
  for (let i = 0; i < s.review.pages.length; i++) {
    const dialog = s.frame().dialog; pages.push(dialog.text);
    assert(dialog.text.split('\n').length <= 3); assert(byteLength(dialog.text) < 900); s.move(1);
  }
  assert.equal(pages.join(' ').replace(/\s+/g, ' '), words); assert.equal(s.review.page, s.review.pages.length - 1);
  s.move(1); assert.equal(s.review.page, s.review.pages.length - 1);
  while (s.review.page) s.move(-1);
  s.move(-1); assert.equal(s.review.page, 0);
  s.cancelReview(); assert.equal(s.status, 'ready');
});

test('answer pages fit native display; followups retain context; closing ignores late responses', async () => {
  const s = new AskSession(); const context = { passage: 'Current paragraph', title: 'Test' }; s.open(context);
  await s.send('Explain?', async () => ({ answer: 'This is an answer. '.repeat(300) }));
  assert.equal(s.status, 'answer'); assert(s.layout.maxY > 0);
  assert(byteLength(s.frame().body) < 900); s.move(1); assert(s.y > 0);
  await s.send('Why?', async input => { assert.equal(input.history.length, 2); assert.equal(input.context, context); return { answer: 'Because.' }; });
  assert.equal(s.history.length, 4); assert.equal(s.y, 0);
  let resolve; const pending = s.send('Another?', (_input, signal) => new Promise(r => { resolve = r; signal.addEventListener('abort', () => assert.equal(s.active, true)); }));
  s.close(); resolve({ answer: 'Late answer' }); await pending; assert(!s.active); assert.equal(s.answer, '');
});

test('failed inference leaves the passage available and does not add a false turn to history', async () => {
  const s = new AskSession(); s.open({ passage: 'Source' });
  await s.send('What?', async () => { throw new Error('Unavailable'); });
  assert.equal(s.status, 'error'); assert.equal(s.history.length, 0); assert.match(s.frame().body, /Unavailable/);
});

test('release while microphone start is pending stops it after opening and never records outside a hold', async () => {
  let start; const calls = [];
  const mic = new AskMicrophone(async enabled => { calls.push(enabled); if (enabled) return new Promise(r => { start = r; }); return true; });
  const opening = mic.start(); await tick(); mic.receive(new Uint8Array([1, 2, 3, 4]));
  const stopping = mic.stop(); mic.receive(new Uint8Array([5, 6])); start(true);
  await opening; const blob = await stopping; assert.deepEqual(calls, [true, false]);
  const data = new Uint8Array(await blob.arrayBuffer()); assert.equal(data.length, 48); assert.deepEqual([...data.slice(44)], [1, 2, 3, 4]); assert.equal(mic.capturing, false);
  const v = new DataView(data.buffer); assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint16(34, true), 16);
});

test('recordings have a hard size cap and trigger only one limit callback', async () => {
  let limits = 0; const mic = new AskMicrophone(async () => true, () => limits++); await mic.start();
  mic.receive(new Uint8Array(3_000_000)); mic.receive(new Uint8Array(10)); assert.equal(limits, 1);
  assert.equal((await mic.stop()).size, 60 * 32000 + 44); assert.equal(pcmWave([]).size, 44);
});

test('native endpoint whitelist matches the built manifest and rejects leaked credentials in URLs', () => {
  const origins = askOrigins('https://reader.example,https://reader.example'); assert.equal(origins.length, 1);
  assert.throws(() => askOrigins('https://reader.example/path'));
  const manifest = askManifest({ permissions: [] }, origins); assert.deepEqual(manifest.permissions.find(p => p.name === 'network').whitelist, origins);
  assert.throws(() => checkAskConnection({ endpoint: 'https://user:pass@reader.example', token: 'x' }));
  assert.throws(() => checkAskConnection({ endpoint: 'https://other.example', token: 'x' }, { evenHost: true, origins }));
  assert.equal(checkAskConnection({ endpoint: 'https://reader.example/bridge', token: 'x' }, { evenHost: true, origins }).endpoint, 'https://reader.example/bridge');
});

test('a refined review preserves the reading page, clamping when the draft shortens', () => {
  const session = new AskSession(); session.open({});
  session.reviewQuestion('A long question about the section. '.repeat(12)); session.move(1);
  assert.equal(session.review.page, 1);
  session.reviewQuestion(session.review.text + ' More words.'); assert.equal(session.review.page, 1);
  session.reviewQuestion('short corrected question'); assert.equal(session.review.page, 0);
});

test('live swipes scroll the transcript, pin earlier words on updates and resume following at the tail', () => {
  const session = new AskSession(); session.open({}); session.setStatus('listening');
  const words = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
  session.updateTranscription(words); assert.match(session.dialog().text, /word179$/);
  session.move(-1); const earlier = session.dialog().text; const y = session.y;
  session.updateTranscription(words + ' More new words.'); assert.equal(session.dialog().text, earlier); assert.equal(session.y, y);
  session.move(-1); session.reviewQuestion(session.voiceDraft);
  assert.equal(session.review.page, Math.floor(session.voiceLine / 3));
  session.cancelReview(); session.setStatus('starting'); assert.equal(session.voiceLine, null);
  session.setStatus('listening'); session.updateTranscription(words); session.move(-1); session.move(1);
  session.updateTranscription(words + ' END'); assert.match(session.dialog().text, /END$/);
  session.move(-1); session.updateTranscription('Shorter correction'); assert.equal(session.dialog().text, 'Shorter correction');
});

test('release follows the live tail through the final recognition result without jumping to page one', () => {
  const session = new AskSession(); session.open({}); session.setStatus('listening');
  const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ');
  session.updateTranscription(text); const live = session.dialog().text;
  session.reviewQuestion(text, [], { completing: true });
  assert.equal(session.dialog().text, live, 'release preserves all three visible lines');
  assert.match(session.dialog().status, /^Refining/);
  for (const suffix of [' next', ' more words '.repeat(12) + 'NEWEST']) {
    session.reviewQuestion(text + suffix, [], { completing: true });
    assert(session.dialog().text.endsWith(suffix.trim().split(' ').at(-1)));
  }
  session.reviewQuestion(text + ' FINAL', [], { completing: false });
  assert.match(session.dialog().text, /FINAL$/); assert.equal(session.dialog().status, '');
  session.move(-1); assert.doesNotMatch(session.dialog().text, /FINAL$/);
  session.cancelReview(); session.setStatus('starting'); session.setStatus('listening');
  session.reviewQuestion('New recording', [], { completing: true });
  assert.equal(session.review.following, true);
  session.reviewQuestion('Short final', [], { completing: false });
  assert.equal(session.dialog().text, 'Short final');
});

test('manual scrollback survives post-release results and returning to the end resumes following', () => {
  const text = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ');
  for (const scrollBeforeRelease of [false, true]) {
    const session = new AskSession(); session.open({}); session.setStatus('listening'); session.updateTranscription(text);
    if (scrollBeforeRelease) session.move(-1);
    session.reviewQuestion(text, [], { completing: true });
    if (!scrollBeforeRelease) session.move(-1);
    const earlier = session.dialog().text;
    session.reviewQuestion(text + ' New words arrive after release.', [], { completing: true });
    assert.equal(session.dialog().text, earlier);
    session.reviewQuestion(text + ' Final words arrive after release.', [], { completing: false });
    assert.equal(session.dialog().text, earlier); assert.equal(session.dialog().status, '');
  }
  const session = new AskSession(); session.open({}); session.setStatus('listening'); session.updateTranscription(text);
  session.reviewQuestion(text, [], { completing: true }); session.move(-1); session.move(1);
  session.reviewQuestion(text + ' RESUMED', [], { completing: true });
  assert.match(session.dialog().text, /RESUMED$/);
  session.reviewQuestion('Shortened result', [], { completing: false });
  assert.equal(session.dialog().text, 'Shortened result'); assert.equal(session.review.page, 0);
});

test('closing during live dictation removes the overlay and releases input handling', () => {
  const session = new AskSession(); session.open({ passage: 'Paper' });
  session.setStatus('listening'); session.voiceDraft = 'A provisional question';
  assert.equal(session.dialog().text, 'A provisional question');
  assert.equal(session.dialog().hint, 'Tap: accept · Double tap: cancel'); assert.equal(session.dialog().actionText, undefined);
  assert.doesNotMatch(session.frame().status, /Release to|Edit on phone|Swipe|\d+\/\d+/);
  session.reviewQuestion('A very long question about this passage. '.repeat(40));
  session.move(1); assert(session.review.page > 0);
  assert.doesNotMatch(session.dialog().status, /\d+\/\d+/);
  assert.doesNotMatch(session.frame().status, /Swipe|\d+\/\d+/);
  session.close(); assert.equal(session.dialog(), null);
});


test('review shows only optional animated refinement, with consistent gesture hints across long drafts', () => {
  const session = new AskSession(); session.open({}); session.setStatus('listening');
  assert.match(session.dialog().status, /^Listening\.+$/); assert.equal(session.dialog().text, ' ');
  session.reviewQuestion('A spoken question'); session.review.note = 'Transcription checked.';
  assert.equal(session.dialog().status, ''); assert.equal(session.dialog().buttons, undefined); assert.equal(session.dialog().hint, 'Tap: accept · Double tap: cancel');
  session.review.refining = true; session.tick(900);
  assert.equal(session.dialog().status, 'Refining..'); assert.equal(session.dialog().statusInline, true);
  session.reviewQuestion('A longer transcript. '.repeat(80)); session.move(-1);
  assert.equal(session.review.page, 0); session.move(1); assert.equal(session.review.page, 1);
  const page = session.review.page; session.reviewQuestion(session.review.text + ' New words.');
  assert.equal(session.review.page, page); assert.equal(session.dialog().hint, TRANSCRIPTION_HINT);
});

test('long dictation survives preview, review and send without the former 4000-character truncation', async () => {
  const question = 'Opening words. ' + 'A detailed spoken thought. '.repeat(400) + ' Ending words.';
  const session = new AskSession(); session.open({ passage: 'Paper' }); session.setStatus('listening');
  session.updateTranscription(question); assert.equal(session.voiceDraft, question);
  session.reviewQuestion(question); assert.equal(session.review.text, question);
  assert(session.review.pages.at(-1).includes('Ending words.'));
  let submitted;
  await session.send(question, async body => { submitted = body.question; return { answer: 'Received.' }; });
  assert.equal(submitted, question); assert.equal(session.history[0].content, question);
  await session.send('x'.repeat(64001), () => assert.fail('Oversized input must not be silently shortened and sent'));
  assert.match(session.error, /too long/);
});

test('API accepts full long questions and their follow-up history, and explicitly rejects oversized messages', () => {
  const question = 'Detailed spoken thought. '.repeat(400);
  const history = [{ role: 'user', content: question }, { role: 'assistant', content: 'Answer.' }];
  const messages = inferenceInput({ question, context: { passage: 'Paper' }, history });
  assert.equal(messages.at(-1).content, question); assert.equal(messages[1].content, question);
  assert.throws(() => inferenceInput({ question: 'x'.repeat(64001), context: { passage: 'Paper' } }), /Invalid question/);
});

test('a timeout has a specific glasses label without replacing the conversation', () => {
  const s = new AskSession(); s.open({}, [{ role: 'assistant', content: 'Previous answer' }]);
  const body = s.frame().body;
  s.fail(Object.assign(new Error('The request timed out.'), { connectionFailure: 'timeout' }));
  assert.equal(s.frame().statusLeft, 'Request timed out'); assert.equal(s.frame().body, body);
  s.fail(new Error('Agent failed')); assert.equal(s.frame().statusLeft, 'Ask error');
  s.setStatus('answer'); assert.equal(s.frame().statusLeft, 'Ask');
});


test('Ask error advertises retry only with a retained failed send', () => {
  const session = new AskSession(); session.open({}); session.fail(new Error('Disconnected'));
  assert.match(session.frame({ retry: true }).statusRight, /Hold to retry/);
  assert.match(session.frame({ retry: true }).body, /Hold to retry/);
  assert.match(session.frame().statusRight, /Hold: speak/);
  assert.doesNotMatch(session.frame().body, /Hold to retry/);
});
