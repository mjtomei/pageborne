import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTurns, displayQuestion, installConversationSync } from '../integrations/even-terminal/pageborne-conversation.js';
import { AskChat } from '../src/ask-chat.js';
import { EvenTerminal } from '../src/ask-terminal.js';
import { fileQuestion } from '../src/ask-documents.js';
import { librarianQuestion } from '../src/librarian.js';
import { instructions, instructionsForPlatform, inferenceInput } from '../ai/providers.js';

const marker = 'Pageborne question 12345678-1234-4123-8123-123456789012';
const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const assistant = (id, text) => ({ id, type: 'agentMessage', text });
const remote = (id, question, answer, more = {}) => ({ id, question, answer, state: 'complete', ...more });
const store = () => { let saved = {}; return new AskChat(() => saved, value => { saved = structuredClone(value); }); };

test('shared history preserves every user message and strips only recognized Pageborne wrappers', () => {
  const input = { context: { title: 'Paper', passage: 'Private source with Question:\ninside' }, question: 'First line\n\nQuestion:\nkeep this too' };
  const prompts = [fileQuestion(marker, input, { position: { line: 1 } }, false), librarianQuestion(marker, input.question),
    `${marker}\n${instructions}\nThe reading context below is a fresh snapshot.\n\n${inferenceInput(input).map(m => m.content).join('\n\n')}`,
    fileQuestion(marker, { ...input, context: { ...input.context, platform: 'web' } }, { position: { line: 1 } }, false),
    `${marker}\n${instructionsForPlatform(instructions, 'web')}\nThe reading context below is a fresh snapshot.\n\n${inferenceInput(input).map(m => m.content).join('\n\n')}`];
  for (const prompt of prompts) {
    assert.deepEqual(displayQuestion(prompt), { marker, question: input.question });
    assert.deepEqual(displayQuestion(`Paper\n\n${prompt}`), { marker, question: input.question });
  }
  assert.deepEqual(displayQuestion('A plain question\n\nQuestion:\nkeep it'), { question: 'A plain question\n\nQuestion:\nkeep it' });
  const turns = conversationTurns([{ id: 'one', status: 'completed', items: [user('u1', 'Again?'), user('u2', 'Again?'), assistant('a1', 'Progress'), assistant('a2', 'Final')] },
    { id: 'two', status: 'inProgress', items: [user('u3', prompts[0]), assistant('a3', 'Partial')] }]);
  assert.deepEqual(turns.map(t => [t.id, t.question, t.answer, t.state]), [
    ['one:u1', 'Again?', '', 'complete'], ['one:u2', 'Again?', 'Progress\n\nFinal', 'complete'], ['two:u3', input.question, 'Partial', 'pending']]);
});

test('shared chat backfills questions, retains local identities and read positions, and merges all missed turns once', () => {
  const chat = store(), id = chat.begin('paper', 'Our question', { position: 25 });
  chat.reconcile('paper', { sessionId: 'session', pending: { turnId: id, marker, question: 'Our question' } });
  chat.update('paper', id, 'Our answer', 'complete'); chat.turns('paper')[0].readThrough = 4;
  chat.reconcile('paper', { sessionId: 'session', seenEventId: 10, reply: { answer: 'External answer', unread: true } });
  const snapshot = [remote('older', 'An older mobile question', 'Older answer'), remote('ours', 'Our question', 'Our answer', { marker }),
    remote('external', 'Missing mobile question', 'External answer'), remote('repeat1', 'Again?', 'Yes'), remote('repeat2', 'Again?', 'Yes')];
  chat.mergeConversation('paper', 'session', snapshot);
  assert.deepEqual(chat.turns('paper').map(t => t.question), snapshot.map(t => t.question));
  assert.equal(chat.turns('paper')[1].id, id); assert.equal(chat.turns('paper')[1].position, 25); assert.equal(chat.turns('paper')[1].readThrough, 4);
  assert.equal(chat.mergeConversation('paper', 'session', snapshot).changed, false);
  assert.equal(chat.mergeConversation('paper', 'session', snapshot).reply, undefined);
  assert.equal(chat.turns('paper').length, 5);
  assert.equal(chat.turns('other').length, 0);
  const unsent = chat.begin('paper', 'Not sent yet', {});
  chat.mergeConversation('paper', 'session', [...snapshot, remote('new', 'New mobile message', 'New answer')]);
  assert.equal(chat.turns('paper').at(-1).id, unsent);
  const restored = new AskChat(chat.read, chat.save);
  assert.equal(restored.mergeConversation('paper', 'session', snapshot).reply, undefined);
  assert.equal(restored.turns('paper').length, 7);
});

test('a stale shorter snapshot and synthetic-to-live identity changes preserve received text and message anchors', () => {
  const chat = store();
  chat.mergeConversation('paper', 's', [remote('t:item-1', 'Mobile?', 'Complete reply')]);
  const original = chat.turns('paper')[0].id;
  chat.mergeConversation('paper', 's', [remote('t:uuid', 'Mobile?', 'Complete', { state: 'pending', aliases: ['t:item-1'] })]);
  assert.equal(chat.turns('paper')[0].id, original); assert.equal(chat.turns('paper')[0].answer, 'Complete reply');
  assert.equal(chat.turns('paper')[0].state, 'complete');
  chat.mergeConversation('paper', 's', [remote('t:item-1', 'Mobile?', 'Complete reply')]);
  assert.equal(chat.turns('paper').length, 1);
});

test('a mobile steering question takes its answer with it when a pending local turn finishes', () => {
  const chat = store(), id = chat.begin('paper', 'Original question', {});
  chat.reconcile('paper', { pending: { turnId: id, marker } });
  chat.update('paper', id, 'Answer after steering', 'complete');
  chat.mergeConversation('paper', 's', [remote('original', 'Original question', '', { marker }),
    remote('steered', 'Mobile clarification', 'Answer after steering')]);
  assert.deepEqual(chat.turns('paper').map(t => [t.question, t.answer]), [['Original question', ''], ['Mobile clarification', 'Answer after steering']]);
  assert.equal(chat.turns('paper')[0].id, id);
});

test('history transport is capability-gated, read-only, and rejects another session response', async () => {
  const calls = []; let supported = false, sessionId = 's';
  const client = new EvenTerminal({ mode: 'terminal', endpoint: 'https://example.test', token: 'fixture', agent: 'codex' }, { fetcher: async (url, options) => {
    calls.push({ url, method: options.method });
    return Response.json(url.includes('/info?') ? { pageborne: { conversationSync: supported ? 1 : 0 } } : { version: 1, sessionId, turns: [] });
  } });
  assert.equal(await client.conversation({ sessionId: 's' }), null); assert.equal(calls.length, 1);
  supported = true; client.info = null;
  assert.deepEqual((await client.conversation({ sessionId: 's' })).turns, []);
  sessionId = 'other'; await assert.rejects(client.conversation({ sessionId: 's' }), /invalid conversation/);
  assert(calls.every(c => c.method === 'GET'));
});

test('initial history and older backfills are silent; newer replies and pending completions notify', () => {
  const chat = store(), initial = [remote('old', 'Old question', 'Old answer')];
  assert.equal(chat.mergeConversation('p', 's', initial, { baseline: true }).reply, undefined);
  assert.equal(chat.turns('p')[0].readThrough, undefined);
  const restored = new AskChat(chat.read, chat.save);
  assert.equal(restored.mergeConversation('p', 's', initial).reply, undefined);
  const backfill = [remote('older', 'Older question', 'Older answer'), ...initial];
  assert.equal(restored.mergeConversation('p', 's', backfill).reply, undefined);
  assert.equal(restored.turns('p')[0].readThrough, undefined);
  const live = [...backfill, remote('new', 'New mobile question', 'Writing', { state: 'pending' })];
  assert.equal(restored.mergeConversation('p', 's', live).reply, undefined);
  live.at(-1).state = 'complete'; live.at(-1).answer = 'New mobile answer';
  assert.equal(restored.mergeConversation('p', 's', live).reply.question, 'New mobile question');
  assert.equal(restored.mergeConversation('p', 's', live).reply, undefined);
  live[0].answer = 'Backfilled commentary\n\nOlder answer';
  assert.equal(restored.mergeConversation('p', 's', live).reply, undefined);
});

test('upgrade clears imported history unread flags but preserves a locally requested unread reply', () => {
  const chat = store(), own = chat.begin('p', 'Our question', {});
  chat.reconcile('p', { pending: { marker, turnId: own } }); chat.update('p', own, 'Our answer', 'complete');
  const snapshot = [remote('old', 'Old mobile question', 'Old reply'), remote('ours', 'Our question', 'Our answer', { marker })];
  chat.mergeConversation('p', 's', snapshot);
  chat.turns('p')[0].readThrough = 0; // 0.8.105 treated this old import as unread.
  assert.equal(chat.turns('p')[0].readThrough, 0);
  const result = chat.mergeConversation('p', 's', snapshot, { baseline: true });
  assert.equal(result.reply, undefined); assert.equal(chat.turns('p')[0].readThrough, undefined);
  assert.equal(chat.turns('p')[1].readThrough, 0);
});

test('associating a local final result with historical commentary never creates another notification', () => {
  const chat = store(), own = chat.begin('p', 'Our question', {});
  chat.reconcile('p', { pending: { marker, turnId: own } }); chat.update('p', own, 'Final result', 'complete');
  chat.turns('p')[0].readThrough = 4;
  const snapshot = [remote('ours', 'Our question', 'Old commentary\n\nFinal result', { marker })];
  for (let n = 0; n < 3; n++) {
    assert.equal(chat.mergeConversation('p', 's', snapshot).reply, undefined);
    assert.equal(chat.turns('p')[0].answer, 'Final result'); assert.equal(chat.turns('p')[0].readThrough, 4);
  }
});

test('conversation endpoint exposes only text for the requested provider/session and retains all recent pairs beyond ten messages', async () => {
  let handler, requested;
  installConversationSync({ get(path, fn) { assert.equal(path, '/pageborne/conversation'); handler = fn; } }, (provider, id) => {
    requested = [provider, id]; return { getStatus: () => ({ state: 'idle' }), getConversation: async () => Array.from({ length: 30 }, (_, n) => ({
      id: `turn-${n}`, status: 'completed', items: [user(`u-${n}`, `Question ${n}`), assistant(`a-${n}`, `Answer ${n}`), { id: 'tool', type: 'commandExecution', command: 'must not appear' }],
    })) };
  });
  let result; await handler({ query: { provider: 'codex', sessionId: 's' } }, { json(value) { result = value; } });
  assert.deepEqual(requested, ['codex', 's']); assert.equal(result.turns.length, 30); assert(!JSON.stringify(result).includes('must not appear'));
});

test('history accepts optional command detail and keeps compatibility with summary-only desktops', async () => {
  let action = { id: 'cmd', kind: 'tool', text: 'Shell short…', state: 'complete' };
  const client = new EvenTerminal({ mode: 'terminal', endpoint: 'https://example.test', token: 'fixture', agent: 'codex' }, { fetcher: async url => Response.json(
    url.includes('/info?') ? { pageborne: { conversationSync: 1 } } : { version: 1, sessionId: 's', turns: [{ id: 't', question: 'Question', answer: 'Answer', state: 'complete', activities: [action] }] }) });
  assert.equal((await client.conversation({ sessionId: 's' })).turns[0].activities[0].detail, undefined);
  action = { ...action, detail: 'Shell node scripts/check.mjs --include-annotations' };
  assert.equal((await client.conversation({ sessionId: 's' })).turns[0].activities[0].detail, action.detail);
  action.detail = {}; await assert.rejects(client.conversation({ sessionId: 's' }), /invalid activity/);
  action.detail = 'x'.repeat(1001); await assert.rejects(client.conversation({ sessionId: 's' }), /invalid activity/);
});

test('session model metadata is scoped, optional and cannot break shared history', async () => {
  let handler, model = 'claude-fable-5-1', fail = false;
  const provider = { getConversation: async () => [], getStatus: () => ({ state: 'idle' }),
    getInfo: () => { throw new Error('Never use new-session default'); },
    getSessionModel: async id => { assert.equal(id, 'owner'); if (fail) throw Error('metadata unavailable'); return model; } };
  installConversationSync({ get(_, fn) { handler = fn; } }, () => provider);
  const call = async () => { let result; await handler({ query: { sessionId: 'owner' } }, { json(value) { result = value; } }); return result; };
  assert.equal((await call()).sessionModel, 'claude-fable-5-1');
  model = 'claude-fable-5-2'; assert.equal((await call()).sessionModel, model);
  model = 'gpt-6-astra'; assert.equal((await call()).sessionModel, model);
  model = {}; assert.equal((await call()).sessionModel, null);
  fail = true; assert.deepEqual((await call()).turns, []); assert.equal((await call()).sessionModel, null);
  delete provider.getSessionModel; assert.equal((await call()).sessionModel, null);
});
