import test from 'node:test';
import assert from 'node:assert/strict';
import { AskConversation, MESSAGE_WIDTH } from '../src/ask-conversation.js';
import { AskSession } from '../src/ask.js';
import { AskChat } from '../src/ask-chat.js';
import { getTextWidth } from '@evenrealities/pretext';
import { textWindow, pageTurnY, byteLength, TEXT_BYTES, LINE_HEIGHT } from '../src/native-text.js';

test('every retained question and answer is reachable in bounded native frames beyond the API context', () => {
  let saved = {};
  const chat = new AskChat(() => saved, value => { saved = value; });
  for (let i = 0; i < 12; i++) {
    const id = chat.begin('paper', `QUESTION${i}`, {});
    chat.update('paper', id, `ANSWER${i}\n\n${'More detail with Ελληνικά and emoji 🐈. '.repeat(12)}`, 'complete');
  }
  assert.equal(chat.history('paper').length, 8);
  const conversation = new AskConversation();
  const { layout, y } = conversation.update(chat.turns('paper'), 0, 'latest');
  assert.equal(y, layout.maxY);
  assert(conversation.following);
  const frames = []; let at = 0;
  for (let steps = 0; steps < 1000; steps++) {
    const frame = textWindow(layout, at).content; frames.push(frame);
    assert(byteLength(frame) <= TEXT_BYTES);
    if (at === layout.maxY) break;
    const next = pageTurnY(layout, at, 1); assert(next > at); at = next;
  }
  assert.equal(at, layout.maxY);
  for (let i = 0; i < 12; i++) {
    assert(frames.some(f => f.includes(`QUESTION${i}`)));
    assert(frames.some(f => f.includes(`ANSWER${i}`)));
  }
  assert.doesNotMatch(frames.join('\n'), /^You$|^Assistant$/m);
  while (at > 0) { const previous = pageTurnY(layout, at, -1); assert(previous < at); at = previous; }
  assert.match(textWindow(layout, at).content, /QUESTION0/);
});

test('stream growth and removal of older retained turns preserve the current message anchor', () => {
  const turns = Array.from({ length: 3 }, (_, i) => ({ id: String(i), question: `Question ${i}`, answer: `Answer ${i}. `.repeat(100) }));
  const conversation = new AskConversation(); let view = conversation.update(turns, 0, '1:assistant');
  view.y += 3 * LINE_HEIGHT;
  const before = textWindow(view.layout, view.y).content;
  const anchor = conversation.anchor(view.y);
  turns[2].answer += 'A new streamed paragraph. '.repeat(100);
  view = conversation.update(turns, view.y);
  assert.equal(textWindow(view.layout, view.y).content, before);
  view = conversation.update(turns.slice(1), view.y);
  assert.equal(textWindow(view.layout, view.y).content, before);
  assert.deepEqual(conversation.anchor(view.y), anchor);
  const reopened = new AskConversation(); reopened.update(turns.slice(1), 0);
  assert.equal(textWindow(reopened.layout, reopened.restore(anchor)).content, before);
  conversation.update([], view.y); assert.equal(conversation.layout, null);
});

test('streamed replies do not pull a reader out of older messages, and review/cancel retains that place', async () => {
  const turns = [{ id: 'old', question: 'Old question', answer: 'OLD ANSWER. '.repeat(100), state: 'complete' }];
  let current;
  const session = new AskSession(() => {
    if (!session.active) return;
    if (current) current.answer = session.answer;
    session.syncConversation(turns);
  });
  session.open({}, [], turns);
  current = { id: 'new', question: 'Follow up', answer: '' }; turns.push(current);
  let update, finish;
  const sending = session.send(current.question, (_body, _signal, progress) => {
    update = progress; return new Promise(resolve => { finish = resolve; });
  });
  session.move(-1); const before = session.frame().body;
  update('Writing…', 'NEW ANSWER. '.repeat(100)); assert.equal(session.frame().body, before);
  const view = session.captureView();
  session.restoreView(view); assert.equal(session.frame().body, before);
  finish({ answer: 'NEW ANSWER. '.repeat(150) }); await sending;
  assert.equal(session.frame().body, before);
  session.reviewQuestion('Another spoken question'); session.move(1); session.cancelReview();
  assert.equal(session.frame().body, before);
  while (session.y < session.layout.maxY) session.move(1);
  assert.match(session.frame().body, /NEW ANSWER/);
  // A new submission follows the tail, retaining preceding messages above it.
  current = { id: 'last', question: 'Last question', answer: '' }; turns.push(current);
  await session.send(current.question, async () => ({ answer: 'SHORT FINAL ANSWER' }));
  assert.match(session.frame().body, /SHORT FINAL ANSWER$/);
  assert.match(session.frame().body, /Last question/);
});

test('short messages pack together with right-aligned questions, left-aligned answers and their tail at the bottom', () => {
  const conversation = new AskConversation();
  const view = conversation.update([{ id: 'one', question: 'Why?', answer: 'Because.' }, { id: 'two', question: 'How so?', answer: 'Here is how.' }], 0, 'latest');
  assert.equal(view.layout.rows.length, 4, 'no speaker-label or separator rows');
  const lines = conversation.window(view.y).content.split('\n'); assert.equal(lines.length, 9);
  assert(lines.slice(0, 5).every(line => !line));
  assert.match(lines[5], /^ +Why\?$/); assert.equal(lines[6], 'Because.');
  assert.match(lines[7], /^ +How so\?$/); assert.equal(lines[8], 'Here is how.');
  assert(Math.abs(getTextWidth(lines[5]) - getTextWidth(lines[7])) <= getTextWidth(' '));
  conversation.update([{ id: 'wrapped', question: 'A longer question about the paper. '.repeat(30), answer: 'A longer answer about the paper. '.repeat(30) }], 0, 'latest');
  for (const message of conversation.messages) {
    assert(message.rows.length > 1);
    for (const row of message.rows.filter(row => row.text.trim())) {
      assert(getTextWidth(row.text.trimStart()) <= MESSAGE_WIDTH, 'both speakers wrap before the opposite margin');
      if (message.role === 'user') assert(getTextWidth(row.text) - getTextWidth(row.text.trimStart()) >= 64);
      else assert(!row.text.startsWith(' '));
    }
  }
});

test('an open Ask view stops at the new reply beginning as partial and completed answers grow', async () => {
  for (const streaming of [true, false]) {
    const turns = [{ id: 'old', question: 'Old question', answer: 'Earlier explanation. '.repeat(100) }];
    let current;
    const session = new AskSession(() => {
      if (!session.active) return;
      if (current) current.answer = session.answer;
      session.syncConversation(turns);
    });
    session.open({}, [], turns);
    current = { id: 'new', question: 'New question', answer: '' }; turns.push(current);
    let update, finish;
    const sending = session.send(current.question, (_body, _signal, progress) => {
      update = progress; return new Promise(resolve => { finish = resolve; });
    });
    const reply = Array.from({ length: 36 }, (_, i) => `Step ${i}. Explanation of this point.`).join('\n\n');
    if (streaming) {
      update('Writing…', 'Step 0.');
      assert.match(session.frame().body, /New question/);
      assert.match(session.frame().body, /Step 0\.$/);
      update('Writing…', reply.split('\n\n').slice(0, 12).join('\n\n'));
      assert.deepEqual(session.conversation.anchor(session.y), { key: 'new:assistant', row: 0 });
      const first = session.frame().body;
      update('Writing…', reply);
      assert.equal(session.frame().body, first, 'additional chunks must not skip the beginning');
    }
    finish({ answer: reply }); await sending;
    assert.deepEqual(session.conversation.anchor(session.y), { key: 'new:assistant', row: 0 });
    assert.match(session.frame().body, /^Step 0\./);
    assert.doesNotMatch(session.frame().body, /Step 35\./);
    assert(!session.conversation.following);
  }
});

test('history backfill cannot steal focus from a newly sent question', () => {
  const turns = [{ id: 'recent', question: 'Previous question', answer: 'Already seen explanation. '.repeat(120) }];
  const c = new AskConversation(); let view = c.update(turns, 0, 'latest');
  turns.push({ id: 'new', question: 'My new question', answer: '' });
  view = c.update(turns, view.y);
  assert.match(c.window(view.y).content, /My new question/);
  // A server history snapshot includes an older reply absent from the cache.
  turns.unshift({ id: 'older', question: 'Historical question', answer: 'Historical explanation. '.repeat(150) });
  view = c.update(turns, view.y);
  assert.match(c.window(view.y).content, /My new question/, 'keep following the submitted question');
  assert(c.following, 'backfill must not consume the first-reply focus');
  turns.at(-1).answer = 'New reply begins. '.repeat(80);
  view = c.update(turns, view.y);
  assert.deepEqual(c.anchor(view.y), { key: 'new:assistant', row: 0 });
});

test('a prior pending answer cannot pull the viewer away from a follow-up', () => {
  const turns = [
    { id: 'old', question: 'Old question', answer: 'Old answer. '.repeat(100) },
    { id: 'prior', question: 'Still working on this', answer: '' },
    { id: 'followup', question: 'Follow-up question', answer: '' },
  ];
  const c = new AskConversation(); let view = c.update(turns, 0, 'latest');
  turns[1].answer = 'Delayed earlier answer. '.repeat(100);
  view = c.update(turns, view.y);
  assert.match(c.window(view.y).content, /Follow-up question/);
  turns[2].answer = 'Follow-up reply. '.repeat(100);
  view = c.update(turns, view.y);
  assert.deepEqual(c.anchor(view.y), { key: 'followup:assistant', row: 0 });
});

test('manual paging during a streamed reply holds the chosen page, including its temporary end', async () => {
  const turn = { id: 'stream', question: 'Question', answer: '' };
  const session = new AskSession(() => {
    if (!session.active) return;
    turn.answer = session.answer; session.syncConversation([turn]);
  });
  session.open({}, [], [turn]);
  let update, finish;
  const sending = session.send(turn.question, (_body, _signal, progress) => {
    update = progress; return new Promise(resolve => { finish = resolve; });
  });
  const reply = Array.from({ length: 36 }, (_, i) => `Step ${i}. Explanation of this point.`).join('\n\n');
  update('Writing…', reply.split('\n\n').slice(0, 12).join('\n\n'));
  while (session.y < session.layout.maxY) session.move(1);
  const anchor = session.conversation.anchor(session.y);
  update('Writing…', reply);
  assert.deepEqual(session.conversation.anchor(session.y), anchor, 'growing beyond the visible end must preserve the page');
  const before = session.frame().body;
  finish({ answer: reply }); await sending;
  assert.equal(session.frame().body, before);
  session.move(-1); const previous = session.frame().body;
  session.move(1); assert.equal(session.frame().body, before); assert.notEqual(previous, before);
});

test('following tracks streaming growth, while scrolling up preserves the anchor until returning to the end', () => {
  const conversation = new AskConversation(), turns = [{ id: 'one', question: 'Question', answer: 'First answer. '.repeat(90) }];
  let view = conversation.update(turns, 0, 'latest');
  turns[0].answer += ' LAST STREAMED LINE'; view = conversation.update(turns, view.y);
  assert.equal(view.y, view.layout.maxY); assert.match(conversation.window(view.y).content, /LAST STREAMED LINE$/);
  view.y = conversation.move(view.y, -1); const before = conversation.window(view.y).content;
  turns[0].answer += ' Additional explanation. '.repeat(50); view = conversation.update(turns, view.y);
  assert.equal(conversation.window(view.y).content, before); assert(!conversation.following);
  while (view.y < view.layout.maxY) view.y = conversation.move(view.y, 1);
  assert(conversation.following);
  turns[0].answer += ' END'; view = conversation.update(turns, view.y);
  assert.match(conversation.window(view.y).content, /END$/);
});

test('page counts follow bounded screens instead of conversation turns', () => {
  const conversation = new AskConversation();
  let view = conversation.update([{ id: 'one', question: 'Why?', answer: 'Because.' }], 0, 'latest');
  assert.equal(conversation.window(view.y).page, 1); assert.equal(conversation.window(view.y).pages, 1);
  view = conversation.update([{ id: 'one', question: 'Why?', answer: 'An extended explanation. '.repeat(150) }], 0, 'latest');
  let frame = conversation.window(view.y); assert(frame.pages > 2); assert.equal(frame.page, frame.pages);
  view.y = 0; let page = 1;
  while (true) {
    frame = conversation.window(view.y); assert.equal(frame.page, page);
    if (view.y === view.layout.maxY) break;
    view.y = conversation.move(view.y, 1); page++;
  }
  assert.equal(page, frame.pages);
  view = conversation.resize(view.y, 4); frame = conversation.window(view.y);
  assert.equal(frame.page, frame.pages); assert(frame.pages > page);
});

test('Ask page turns cover every row exactly once, including short final pages and the byte limit', () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({ id: String(i), question: `Question ${i}. ${'語 🐈'.repeat(20)}`,
    answer: Array.from({ length: 7 }, (_, j) => `Answer ${i}, point ${j}. A distinct explanation.`).join('\n\n') }));
  const c = new AskConversation();
  for (const lines of [9, 7, 4, 1]) {
    let view = c.update(turns, 0, '0:user', lines), at = view.y;
    const frames = [];
    for (let i = 0; i < 1000; i++) {
      const frame = c.window(at); frames.push(frame);
      assert(byteLength(frame.content) <= TEXT_BYTES);
      assert.equal(frame.page, frames.length);
      if (frame.nextY === at) break;
      const next = c.move(at, 1);
      assert.equal(c.window(next).start, frame.end, 'next page starts after the last displayed row');
      at = next;
    }
    assert.equal(frames[0].start, 0); assert.equal(frames.at(-1).end, c.layout.rows.length);
    assert.equal(frames.length, frames.at(-1).pages);
    assert.equal(frames.reduce((n, f) => n + f.end - f.start, 0), c.layout.rows.length);
    for (let i = frames.length - 2; i >= 0; i--) {
      const after = c.window(at); at = c.move(at, -1); const before = c.window(at);
      assert.equal(before.end, after.start, 'previous page stops before the current page');
      assert.equal(before.content, frames[i].content, 'backward turns restore the same pages');
      assert.equal(before.page, i + 1);
    }
    assert.equal(c.move(at, -1), 0);
  }
  const short = new AskConversation();
  short.update([{ id: 'short', question: 'Why?', answer: Array.from({ length: 6 }, (_, i) => `Unique point ${i}.`).join('\n\n') }], 0, 'short:user');
  let at = 0, previous;
  while (true) {
    const frame = short.window(at);
    if (frame.nextY === at) {
      assert(frame.end - frame.start < short.lines, 'the final page remains short');
      assert.equal(frame.start, previous.end, 'do not backfill with already displayed rows'); break;
    }
    previous = frame; at = short.move(at, 1);
  }
});

test('paging from a saved unread position neither repeats nor skips text and still marks it read', () => {
  const turns = [{ id: 'one', question: 'Question', answer: Array.from({ length: 30 }, (_, i) => `Point ${i}: a unique sentence.`).join('\n\n'), readThrough: 0 }];
  const c = new AskConversation(); c.update(turns, 0, 'unread');
  turns[0].readThrough = c.messages.find(m => m.role === 'assistant').rows[4].readEnd;
  let { y } = c.update(turns, 0, 'unread');
  const first = c.window(y); assert(first.start > 0);
  const visited = [];
  while (true) {
    const frame = c.window(y); visited.push(frame); c.markRead(turns, frame.readReceipts);
    if (frame.nextY === y) break;
    y = c.move(y, 1); assert.equal(c.window(y).start, frame.end);
  }
  assert.equal(c.firstUnread(turns), null);
  for (let i = visited.length - 2; i >= 0; i--) {
    y = c.move(y, -1); assert.equal(c.window(y).content, visited[i].content);
  }
  const earlier = c.window(c.move(y, -1)); assert.equal(earlier.end, first.start);
});

test('recording moves a followed tail above the panel, preserves a scrolled-back view and restores full height', () => {
  const turns = [{ id: 'one', question: 'Why?', answer: 'Earlier discussion. '.repeat(80) + ' MOST RECENT WORDS' }];
  const session = new AskSession(); session.open({}, [], turns);
  const full = session.frame().body, originalY = session.y;
  session.setStatus('listening'); assert.match(session.frame().body, /MOST\s+RECENT\s+WORDS$/);
  assert.equal(session.frame().body.split('\n').length, 6); assert(session.y > originalY);
  session.updateTranscription('A growing question about this passage. '.repeat(8));
  assert.equal(session.frame().body.split('\n').length, 4); assert.match(session.frame().body, /MOST\s+RECENT\s+WORDS$/);
  session.updateTranscription('A shorter corrected draft');
  assert.equal(session.frame().body.split('\n').length, 6); assert.match(session.frame().body, /MOST\s+RECENT\s+WORDS$/);
  session.setStatus('transcribing'); assert.match(session.frame().body, /MOST\s+RECENT\s+WORDS$/);
  session.reviewQuestion('A follow-up'); assert.match(session.frame().body, /MOST\s+RECENT\s+WORDS$/);
  session.cancelReview(); assert.equal(session.y, originalY); assert.equal(session.frame().body, full);
  session.move(-1); const y = session.y, older = session.frame().body;
  session.setStatus('listening'); assert.equal(session.y, y); assert.equal(session.frame().body, older.split('\n').slice(0, 6).join('\n'));
  session.updateTranscription('A growing question about this passage. '.repeat(8));
  assert.equal(session.y, y); assert.equal(session.frame().body, older.split('\n').slice(0, 4).join('\n'));
  session.reviewQuestion('Another follow-up'); session.cancelReview(); assert.equal(session.frame().body, older);
  const view = session.captureView(); session.restoreView(view); assert(!session.conversation.following); assert.equal(session.frame().body, older);
});

test('alignment and bottom padding remain inside the native byte limit even for dense short messages', () => {
  const conversation = new AskConversation();
  const turns = Array.from({ length: 40 }, (_, i) => ({ id: String(i), question: i % 2 ? 'i' : '語 🐈'.repeat(45), answer: 'x' }));
  let view = conversation.update(turns, 0, 'latest');
  for (const count of [9, 4, 9]) {
    Object.assign(view, conversation.resize(view.y, count));
    assert(byteLength(conversation.window(view.y).content) <= TEXT_BYTES); assert.match(conversation.window(view.y).content, /x$/);
    let visited = 0; view.y = 0;
    while (true) {
      const frame = conversation.window(view.y); assert(byteLength(frame.content) <= TEXT_BYTES); visited++;
      if (view.y === view.layout.maxY) break;
      const next = conversation.move(view.y, 1); assert(next > view.y); view.y = next;
      assert(visited < 1000);
    }
  }
});

test('review pages fit their text and late partials cannot overwrite the accepted transcript', () => {
  const session = new AskSession(); session.open({}, [], [{ id: 'one', question: 'Why?', answer: 'Earlier discussion. '.repeat(100) + ' END' }]);
  session.setStatus('listening'); session.updateTranscription('Live words');
  assert.equal(session.dialog().text, 'Live words');
  session.reviewQuestion('word '.repeat(70));
  assert(session.review.pages.length > 1);
  for (let i = 0; i < session.review.pages.length; i++) {
    const lines = session.dialog().text.split('\n').length;
    assert.equal(session.frame().body.split('\n').length, 8 - lines);
    assert.match(session.frame().body, /END$/);
    session.move(1);
  }
  session.updateTranscription('Late partial'); assert.notEqual(session.dialog().text, 'Late partial');
  session.close(); session.updateTranscription('After closing'); assert.equal(session.dialog(), null);
});

test('opening unread starts at the earliest unseen reply and advances only through accepted screens', () => {
  const turns = [
    { id: 'old', question: 'Already read', answer: 'Older reply.' },
    { id: 'new', question: 'Explain', answer: Array.from({length:35},(_,i)=>`Line ${i}: explanation.`).join('\n\n'), readThrough: 0 },
    { id: 'later', question: 'And then?', answer: 'The newest reply.', readThrough: 0 },
  ];
  const c = new AskConversation(); let view=c.update(turns,0,'unread');
  assert.match(c.window(view.y).content,/Line 0:/); assert(!c.following);
  // A generated/queued frame has not been read until it was displayed.
  const first=c.window(view.y); view=c.update(turns,view.y,'unread'); assert.equal(c.window(view.y).content,first.content);
  const tail=c.window(c.layout.maxY); c.markRead(turns,tail.readReceipts);
  assert.equal(turns[1].readThrough,0,'seeing the tail does not consume earlier unseen text');
  c.markRead(turns,first.readReceipts);
  view=c.update(turns,view.y,'unread'); assert(!c.window(view.y).content.includes('Line 0:'));
  for(let i=0;i<100 && c.firstUnread(turns)!==null;i++) {
    view=c.update(turns,view.y,'unread'); c.markRead(turns,c.window(view.y).readReceipts);
  }
  assert.equal(c.firstUnread(turns),null);
  view.y=c.move(view.y,-1); const place=c.window(view.y).content;
  view=c.update(turns,view.y,'unread'); assert.equal(c.window(view.y).content,place,'keep the current place when nothing is unread');
});

test('unread markers survive a reload and a partial line growing', () => {
  const store={}; const chat=new AskChat(()=>store, value=>Object.assign(store,structuredClone(value)));
  const id=chat.begin('paper','Why?',{}); chat.update('paper',id,'A partial reply');
  const c=new AskConversation(); let view=c.update(chat.turns('paper'),0,'unread');
  c.markRead(chat.turns('paper'),c.window(view.y).readReceipts); assert.equal(c.firstUnread(chat.turns('paper')),null);
  chat.update('paper',id,'A partial reply with more words.\n\n'+'Much more explanation. '.repeat(100),'complete');
  view=c.update(chat.turns('paper'),view.y,'unread'); assert.match(c.window(view.y).content,/A partial reply with/);
  c.markRead(chat.turns('paper'),c.window(view.y).readReceipts);
  const at=c.firstUnread(chat.turns('paper')); assert(at>0); chat.persist('paper');
  const restored=new AskChat(()=>store,()=>{}), next=new AskConversation();
  const reopened=next.update(restored.turns('paper'),0,'unread'); assert.equal(reopened.y,at);
  assert.deepEqual(restored.turns('other'),[]);
});

test('short unread replies stay bottom-aligned without following new text past the first screen', () => {
  const turns=[{id:'one',question:'Why?',answer:'A short reply.',readThrough:0}];
  const c=new AskConversation();let view=c.update(turns,0,'unread');
  assert(!c.following);assert.equal(c.window(view.y).content.split('\n').length,9);
  assert.match(c.window(view.y).content,/A short reply\.$/);
  turns[0].answer+=' An extended explanation.'.repeat(100);view=c.update(turns,view.y);
  assert.equal(view.y,0);assert.match(c.window(view.y).content,/A short reply/);
});

test('rewritten stream prefixes become unread again and stale display receipts are ignored', () => {
  const turns=[{id:'one',answer:'Original text. '.repeat(50),readThrough:0}];
  const c=new AskConversation();let view=c.update(turns,0,'unread');const frame=c.window(view.y);
  c.markRead(turns,frame.readReceipts);assert(turns[0].readThrough>0);
  turns[0].answer='Rewritten text. '.repeat(50);view=c.update(turns,view.y);
  assert.equal(turns[0].readThrough,0);assert.equal(c.markRead(turns,frame.readReceipts),false);
  view=c.update(turns,view.y,'unread');assert.equal(view.y,0);
});


test('follow-up resume ignores earlier unread answers without changing their receipts', () => {
  const turns = [1, 2].map(n => ({ id: `turn${n}`, question: `Question ${n}`, answer: Array.from({ length: 32 }, (_, i) => `Answer ${n} line ${i}. More explanation.`).join('\n\n'), readThrough: 0 }));
  const c = new AskConversation(); let view = c.update(turns, 0, 'unread');
  c.markRead(turns, c.window(view.y).readReceipts);
  const earlierRead = turns[0].readThrough;
  turns[1].resumeFromHere = true;
  view = c.update(turns, view.y, 'unread');
  assert.match(c.window(view.y).content, /^Answer 2 line 0/);
  assert.equal(turns[0].readThrough, earlierRead);
  c.markRead(turns, c.window(view.y).readReceipts);
  view = c.update(turns, view.y, 'unread');
  assert.match(c.window(view.y).content, /Answer 2/);
  assert.doesNotMatch(c.window(view.y).content, /line 0/);
  turns[1].readThrough = Infinity;
  const chosen = c.move(view.y, -1);
  assert.equal(c.update(turns, chosen, 'unread').y, chosen, 'no unread reply retains the chosen position');
  const restored = new AskConversation();
  const saved = structuredClone(turns);
  saved[1].readThrough = 0;
  const reopened = restored.update(saved, 0, 'unread');
  assert.match(restored.window(reopened.y).content, /^Answer 2 line 0/, 'resume boundary survives a reopened conversation');
  delete saved[1].resumeFromHere;
  assert(restored.firstUnread(saved) < reopened.y, 'unmarked older replies stay eligible');
});
