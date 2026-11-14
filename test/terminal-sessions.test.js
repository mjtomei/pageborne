import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalSessionKey, terminalSessionContext, terminalSessionPicker, listTerminalSessions, sessionIdentity } from '../src/terminal-sessions.js';
import { documentPickerText, moveDocumentPicker } from '../src/document-picker.js';
import { byteLength, VISIBLE_LINES } from '../src/native-text.js';
import { EvenTerminal } from '../src/ask-terminal.js';
import { displayQuestion } from '../integrations/even-terminal/pageborne-conversation.js';
import { askChatKey } from '../src/ask-models.js';
import { AskChat } from '../src/ask-chat.js';
const config = { mode: 'terminal', endpoint: 'https://terminal.example', agent: 'codex', token: 'fixture', paperDirectories: true };
const marker = 'Pageborne question 12345678-1234-1234-1234-123456789abc';

test('custom receiver requests over ten sessions for both providers, sorts and reaches every entry', async () => {
  const requests = [];
  const result = await listTerminalSessions(provider => new EvenTerminal({ ...config, agent: provider }, { fetcher: async url => {
    const u = new URL(url); requests.push(u.searchParams.get('limit'));
    assert.equal(u.searchParams.get('provider'), provider);
    return Response.json({ sessions: Array.from({ length: provider === 'claude' ? 27 : 44 }, (_, i) => ({ id: `s${i}`, title: '中文👓'.repeat(100), timestamp: new Date(1700000000000+i*2000+(provider === 'codex' ? 1000 : 0)).toISOString() })) });
  } }));
  assert.deepEqual(requests, ['100', '100']); assert.equal(result.sessions.length, 71);
  assert.equal(result.sessions[0].id, 's43'); assert.equal(result.sessions[0].provider, 'codex');
  let picker = terminalSessionPicker(result.sessions); const seen = new Set();
  for (let i = 0; i < 73; i++) {
    const text = documentPickerText(picker); assert(byteLength(text) < 900); assert(text.split('\n').length <= VISIBLE_LINES);
    assert(text.includes('> ')); const selected = picker.items[picker.index];
    if (selected.session) seen.add(sessionIdentity(selected.session));
    picker = moveDocumentPicker(picker, 1);
  }
  assert.equal(seen.size, 71); assert.equal(picker.index, 0);
});

test('provider failure leaves the other provider available; cancellation discards stale lists', async () => {
  const result = await listTerminalSessions(provider => ({ sessions: async () => {
    if (provider === 'claude') throw new Error('offline');
    return [{ id: 'ok', title: 'Working' }, { id: 'ok' }, { id: null }];
  } }));
  assert.equal(result.sessions.length, 1); assert.deepEqual(result.warnings, ['Claude unavailable']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(listTerminalSessions(() => ({ sessions: async () => [] }), controller.signal), { name: 'AbortError' });
});

test('desktop session identities and caches stay separate from documents, librarian, providers and each other', () => {
  const keys = [terminalSessionKey(config, 'a'), terminalSessionKey(config, 'b'), terminalSessionKey({ ...config, agent: 'claude' }, 'a'),
    askChatKey(config, null), askChatKey(config, 'a'), terminalSessionKey({ ...config, chatScope: 'another-instance' }, 'a')];
  assert.equal(new Set(keys).size, keys.length);
  let saved = {}; const chat = new AskChat(() => saved, next => { saved = next; });
  keys.forEach(key => { const id = chat.begin(key, key, {}); chat.update(key, id, key, 'complete'); });
  for (const key of keys) assert.equal(chat.turns(key).length, 1);
  for (let i = 0; i < 25; i++) { const key = terminalSessionKey(config, `extra${i}`); chat.begin(key, 'bounded cache', {}); }
  assert.equal(Object.keys(saved).length, 20, 'each external session counts toward bounded retention');
});

test('terminal prompts continue an existing owner without uploading, creating a session or changing permissions', async () => {
  const posted = [], calls = []; let saved;
  const client = new EvenTerminal(config, { fetcher: async (url, options) => {
    const path = new URL(url).pathname; calls.push(path);
    if (path.endsWith('/history')) return Response.json({ history: [] });
    if (path === '/api/info') return Response.json({});
    if (path === '/api/messages') return Response.json({ state: 'idle', messages: [] });
    if (path === '/api/prompt') { posted.push(JSON.parse(options.body)); return Response.json({ sessionId: 'existing' }); }
    throw new Error('Unexpected endpoint '+path);
  } });
  const input = { context: terminalSessionContext({ title: 'Work' }), question: 'Update todo.txt and run the tests.', paper: () => { throw new Error('Unrelated document must not be read'); } };
  await client.submit(input, { sessionId: 'existing' }, b => { saved = b; });
  assert.deepEqual(Object.keys(posted[0]).sort(), ['provider', 'sessionId', 'text']);
  assert.equal(posted[0].sessionId, 'existing'); assert.equal(saved.sessionId, 'existing');
  assert.equal(posted[0].text, input.question);
  assert(!/Reading context|reading companion|Do not edit files/.test(posted[0].text));
  assert.equal(displayQuestion(posted[0].text).question, input.question);
  await assert.rejects(client.submit(input, {}, () => {}), /existing desktop session/);
  assert.equal(posted.length, 1);
});

test('new and older desktop conversation extensions round-trip terminal markers without duplicate turns', async () => {
  const question = 'Continue the tests.\n\nKeep the files.';
  for (const platform of ['glasses', 'web']) {
    const raw = `${marker}\nPageborne desktop session. Continue this existing conversation.\n\n${question}`;
    assert.deepEqual(displayQuestion(raw), { marker, question });
    for (const modern of [false, true]) {
      const client = new EvenTerminal(config, { fetcher: async url => Response.json(new URL(url).pathname === '/api/info'
        ? { pageborne: { conversationSync: 1 } } : { version: 1, sessionId: 'existing', state: 'idle', turns: [{ id: 'remote', ...(modern ? displayQuestion(raw) : { question: raw }), answer: 'Done', state: 'complete' }] }) });
      const result = await client.conversation({ sessionId: 'existing' });
      assert.equal(result.turns[0].question, question); assert.equal(result.turns[0].marker, marker);
      let saved = {}; const chat = new AskChat(() => saved, next => { saved = next; });
      const key = terminalSessionKey(config, 'existing'), id = chat.begin(key, question, {});
      chat.reconcile(key, { sessionId: 'existing', pending: { turnId: id, marker, question } });
      chat.mergeConversation(key, 'existing', result.turns);
      assert.equal(chat.turns(key).length, 1); assert.equal(chat.turns(key)[0].answer, 'Done');
    }
  }
});

function plainFixture({ shared = true, lostAck = false } = {}) {
  const turns = [], posts = [], messages = []; let busy = false, binding = { sessionId: 'existing' }, saved = {};
  let chat = new AskChat(() => structuredClone(saved), value => { saved = structuredClone(value); });
  const save = next => { binding = structuredClone(next); chat.reconcile('chat', binding); };
  const client = new EvenTerminal(config, { pollMs: 1,
    onConversation: value => chat.mergeConversation('chat', 'existing', value.turns),
    fetcher: async (url, options) => {
      const route = new URL(url).pathname;
      if (route === '/api/info') return Response.json({ pageborne: shared ? { conversationSync: 1 } : {} });
      if (route.endsWith('/history')) return Response.json({ history: [] });
      if (route === '/api/messages') return Response.json({ state: busy ? 'busy' : 'idle', messages });
      if (route === '/api/pageborne/conversation') return Response.json({ version: 1, sessionId: 'existing', state: busy ? 'busy' : 'idle', turns });
      if (route === '/api/prompt') {
        const body = JSON.parse(options.body); posts.push(body);
        turns.push({ id: 'new-' + posts.length, question: body.text, answer: '', state: 'pending' });
        messages.push({ id: messages.length + 1, type: 'user_prompt', text: body.text }); busy = true;
        if (lostAck) throw new TypeError('Connection lost after accepting the prompt');
        return Response.json({ sessionId: 'existing' });
      }
      assert.fail(route);
    } });
  return { client, turns, posts, messages, save, binding: () => binding, chat: () => chat,
    restore: () => { binding = structuredClone(binding); chat = new AskChat(() => structuredClone(saved), value => { saved = structuredClone(value); }); },
    submit: question => client.submit({ context: terminalSessionContext({ title: 'Work' }), question,
      turnId: chat.begin('chat', question, {}) }, binding, save) };
}

test('plain messages match a new repeated question, recover after reload, and merge only once', async () => {
  const f = plainFixture();
  f.turns.push({ id: 'old', question: 'Again?', answer: 'Old reply', state: 'complete' });
  f.chat().mergeConversation('chat', 'existing', f.turns, { baseline: true });
  await f.submit('Again?');
  assert.equal(f.posts[0].text, 'Again?');
  assert.deepEqual(f.binding().pending.priorTurnIds, ['old']);
  // A provider may rename a hydrated item while retaining the old alias.
  f.turns[0].id = 'hydrated'; f.turns[0].aliases = ['old'];
  assert.equal((await f.client.peek(f.binding())).kind, 'pending');
  f.restore(); f.turns[1].answer = 'New reply'; f.turns[1].state = 'complete';
  assert.equal((await f.client.reply(f.binding(), f.save)).answer, 'New reply');
  f.chat().mergeConversation('chat', 'existing', (await f.client.conversation(f.binding())).turns);
  assert.equal(f.chat().turns('chat').length, 2);
  assert.deepEqual(f.chat().turns('chat').map(t => t.answer), ['Old reply', 'New reply']);
  assert.equal(f.posts.length, 1);
});

test('plain busy follow-ups keep late earlier turns and repeated messages distinct', async () => {
  const f = plainFixture();
  await f.submit('First'); await f.submit('Second');
  f.turns[0].answer = 'Earlier answer'; f.turns[0].state = 'complete';
  assert.equal((await f.client.peek(f.binding())).kind, 'pending');
  f.turns[1].answer = 'Later answer'; f.turns[1].state = 'complete';
  await f.client.reply(f.binding(), f.save);
  assert.deepEqual(f.chat().turns('chat').map(t => t.answer), ['Earlier answer', 'Later answer']);
  await f.submit('Second');
  f.turns[2].answer = 'Repeated answer'; f.turns[2].state = 'complete';
  await f.client.reply(f.binding(), f.save);
  assert.deepEqual(f.posts.map(p => p.text), ['First', 'Second', 'Second']);
  assert.equal(f.chat().turns('chat').length, 3);
});

test('an accepted plain prompt with a lost acknowledgement is recovered without resending', async () => {
  const f = plainFixture({ lostAck: true });
  await assert.rejects(f.submit('Keep working'), /./);
  assert.equal(f.binding().pending.submitted, undefined);
  f.restore(); f.turns[0].answer = 'Done'; f.turns[0].state = 'complete';
  assert.equal((await f.client.reply(f.binding(), f.save)).answer, 'Done');
  assert.equal(f.posts.length, 1); assert.equal(f.chat().turns('chat').length, 1);
});

test('a plain earlier message missing from the first refresh merges when its history arrives late', async () => {
  const f = plainFixture(); await f.submit('First');
  const first = f.turns.pop();
  await f.submit('Different follow-up');
  first.answer = 'First answer'; first.state = 'complete'; f.turns.unshift(first);
  f.restore(); f.turns[1].answer = 'Follow-up answer'; f.turns[1].state = 'complete';
  await f.client.reply(f.binding(), f.save);
  assert.equal(f.chat().turns('chat').length, 2);
  assert.deepEqual(f.chat().turns('chat').map(t => t.answer), ['First answer', 'Follow-up answer']);
});

test('ambiguous new identical prompts do not claim another device’s reply', async () => {
  const f = plainFixture(); await f.submit('Continue');
  f.turns.push({ id: 'other-device', question: 'Continue', answer: 'Other reply', state: 'complete' });
  await assert.rejects(f.client.peek(f.binding()), /More than one matching message/);
  await assert.rejects(f.submit('Continue'), /More than one matching message/);
  assert.equal(f.posts.length, 1);
});

test('stock event tracking handles plain text after the saved cursor without absorbing a later identical prompt', async () => {
  const f = plainFixture({ shared: false });
  f.messages.push({ id: 1, type: 'user_prompt', text: 'Continue' }, { id: 2, type: 'result', success: true, text: 'Old' });
  await f.submit('Continue');
  f.messages.push({ id: 4, type: 'result', success: true, text: 'Ours' },
    { id: 5, type: 'user_prompt', text: 'Continue' }, { id: 6, type: 'result', success: true, text: 'Later' });
  assert.equal((await f.client.reply(f.binding(), f.save)).answer, 'Ours');
  assert.equal(f.posts[0].text, 'Continue');
});
