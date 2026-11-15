import test from 'node:test';
import assert from 'node:assert/strict';
import { EvenTerminal } from '../src/ask-terminal.js';
import { checkConnection, checkTranscription, paperConnectionKey, providerAnswer, terminalHeaders, connectionRequest } from '../src/ask-connections.js';
import { askContext } from '../src/ask.js';
import { librarianContext, librarianConnectionKey } from '../src/librarian.js';

const config = { mode: 'terminal', endpoint: 'https://terminal.example', token: 'private-pairing-token', agent: 'codex', cwd: '/reading' };
const input = { context: { title: 'Paper', passage: 'The relevant paragraph.', page: 2 }, question: 'Explain?', history: [], paperId: 'paper-one' };
test('installed Terminal allows exact-whitelisted Tailscale HTTP, not arbitrary HTTP or lookalike domains', () => {
  for (const endpoint of ['http://100.64.0.1:3456', 'http://100.127.255.254:3456', 'http://reader.tail123.ts.net:3456', 'http://[fd7a:115c:a1e0::1]:3456']) {
    assert.equal(checkConnection({ ...config, endpoint }, { evenHost: true, origins: [endpoint] }).endpoint, endpoint);
    assert.throws(() => checkConnection({ ...config, endpoint }, { evenHost: true, origins: [] }), /not enabled/);
    assert.deepEqual(terminalHeaders(endpoint), { Accept: 'application/json' });
  }
  for (const endpoint of ['http://100.63.255.254:3456', 'http://100.128.0.1:3456', 'http://10.0.0.29:3456', 'http://reader.tail123.ts.net.evil.example', 'http://example.com']) {
    assert.throws(() => checkConnection({ ...config, endpoint }, { evenHost: true, origins: [endpoint] }), /Use HTTPS/);
  }
});
test('event-stream diagnostics distinguish connection and read failures without exporting error text', async () => {
  for (const stage of ['connecting', 'reading-stream']) {
    const logs = [], error = new TypeError('private response details');
    const client = new EvenTerminal(config, { diagnostics: { error: (_type, _error, context) => logs.push(context) },
      fetcher: async () => { if (stage === 'connecting') throw error;
        return { ok: true, body: { getReader: () => ({ read: async () => { throw error; }, cancel: async () => {} }) } }; } });
    await assert.rejects(client.watch('private-session', new AbortController().signal));
    assert.equal(logs[0].stage, stage); assert.equal(logs[0].errorType, 'TypeError');
    assert(!JSON.stringify(logs).includes('private'));
  }
});
test('event streams invoke fetch without using the Terminal client as its receiver', async () => {
  let called = false;
  const client = new EvenTerminal(config, { fetcher: async function (url) {
    assert.equal(this, undefined, 'Window.fetch requires an unbound or Window receiver');
    assert.equal(new URL(url).searchParams.get('provider'), 'codex');
    called = true; return new Response(': connected\n\n');
  } });
  await client.watch('existing-session', new AbortController().signal);
  assert(called);
});
test('ngrok Terminal API and SSE requests opt out of the HTML interstitial without relaxing authentication or redirects', async () => {
  const privateConfig = { ...config, endpoint: 'https://reader-test.ngrok-free.dev' };
  const requests = [];
  const client = new EvenTerminal(privateConfig, { fetcher: async (url, options) => {
    requests.push(options);
    // A tunnel returns its warning page to an unidentified browser request.
    if (options.headers['ngrok-skip-browser-warning'] !== '1') return new Response('<html>Visit site</html>');
    return url.includes('/events?') ? new Response(': connected\n\n', { headers: { 'Content-Type': 'text/event-stream' } }) : Response.json({ provider: 'codex' });
  } });
  assert.equal((await client.serverInfo()).provider, 'codex');
  await client.watch('session-id', new AbortController().signal);
  assert.deepEqual(requests.map(r => r.headers.Accept), ['application/json', 'text/event-stream']);
  for (const request of requests) {
    assert.equal(request.headers.Authorization, `Bearer ${config.token}`);
    assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  }
  for (const endpoint of ['https://terminal.example', 'http://127.0.0.1:3456', 'https://ngrok-free.dev.evil.example', 'https://notngrok.app']) {
    assert.deepEqual(terminalHeaders(endpoint), { Accept: 'application/json' });
  }
});

test('connection failures distinguish invalid API responses and export only safe request metadata', async () => {
  await assert.rejects(connectionRequest('https://terminal.example', { fetcher: async () => new Response('<html>private body</html>') }), error => error.connectionFailure === 'invalid-response' && !error.message.includes('private body'));
  const logs = [];
  const client = new EvenTerminal(config, {
    diagnostics: { error: (type, error, context) => logs.push({ type, message: error.message, context }) },
    fetcher: async () => { throw new TypeError('private-pairing-token private response text'); },
  });
  await assert.rejects(client.api('sessions/private-session/history', { query: { secret: 'private-query' } }), /Could not connect/);
  assert.equal(logs[0].context.request, 'sessions/history'); assert.equal(logs[0].context.failure, 'network');
  assert(!JSON.stringify(logs).includes('private-')); assert(!JSON.stringify(logs).includes('response text'));
});
function mockTerminal({ agent = 'codex', pageborne, result = { success: true, text: 'The completed answer.' } } = {}) {
  const requests = []; const sessions = new Map(); let serial = 0;
  const fetcher = async (url, options) => {
    const u = new URL(url); const body = options.body && JSON.parse(options.body);
    requests.push({ u, options, body });
    assert.equal(options.headers.Authorization, `Bearer ${config.token}`);
    assert.equal(u.searchParams.get('provider'), agent); assert(!u.searchParams.has('token'));
    if (u.pathname.endsWith('/info')) return Response.json({ provider: agent, pageborne });
    if (u.pathname.endsWith('/history')) return Response.json({ history: [] });
    if (u.pathname.endsWith('/prompt')) {
      const id = body.sessionId || `session-${++serial}`;
      assert.equal(body.provider, agent); assert(!('model' in body));
      const old = sessions.get(id)?.messages || []; const n = old.at(-1)?.id || 0;
      sessions.set(id, { state: 'idle', messages: [...old,
        { id: n + 1, type: 'user_prompt', text: body.text }, { id: n + 2, type: 'text_delta', text: 'Draft' }, { id: n + 3, type: 'result', ...result }] });
      return Response.json({ ok: true, sessionId: id, provider: agent });
    }
    if (u.pathname.endsWith('/messages')) {
      const s = sessions.get(u.searchParams.get('sessionId')) || { state: 'idle', messages: [] };
      return Response.json({ ...s, messages: s.messages.filter(m => m.id > Number(u.searchParams.get('after') || 0)) });
    }
    if (u.pathname.endsWith('/sessions')) return Response.json({ sessions: [...sessions.keys()].map(id => ({ id, title: id, status: 'idle' })) });
    throw new Error(`Unexpected route ${u.pathname}`);
  };
  return { requests, sessions, fetcher };
}

test('Librarian uses the shared library root and resumes its own titled session without paper uploads', async () => {
  const mock = mockTerminal({ pageborne: { sessionTitles: 1, documents: 1, workspaces: 1 } });
  let library = { version: 1, id: 'shared-library', directory: '/shared/library', files: [] };
  const client = new EvenTerminal({ ...config, paperDirectories: true }, { pollMs: 1, fetcher: (url, options) => new URL(url).pathname === '/api/pageborne/library'
    ? Response.json(library) : mock.fetcher(url, options) });
  const input = { question: 'Find documents about trees.', context: librarianContext(), paper: () => assert.fail('must not upload the open paper') };
  let binding;
  const save = next => { binding = next; };
  await client.ask(input, undefined, save);
  const first = mock.requests.find(r => r.u.pathname === '/api/prompt').body;
  assert.equal(first.cwd, library.directory); assert.equal(first.sessionTitle, 'Librarian');
  assert.match(first.text, /working in the root/); assert.match(first.text, /Find documents about trees/);
  assert.doesNotMatch(first.text, /Reading context|Do not edit files or run commands/);
  assert.equal(binding.libraryId, library.id);
  const sessionId = binding.sessionId;
  await client.ask({ ...input, question: 'Compare those documents.' }, binding, save);
  const prompts = mock.requests.filter(r => r.u.pathname === '/api/prompt');
  assert.equal(prompts.length, 2); assert.equal(prompts[1].body.sessionId, sessionId);
  assert.equal(prompts[1].body.cwd, undefined);
  library = { ...library, directory: '/different/library' };
  await assert.rejects(client.ask(input, binding, save), /library has changed/);
  assert.equal(mock.requests.filter(r => r.u.pathname === '/api/prompt').length, 2);
  await client.ask(input, {}, save);
  assert.notEqual(binding.sessionId, sessionId); assert.equal(binding.cwd, library.directory);
  assert.notEqual(librarianConnectionKey(config), paperConnectionKey(config, 'library'));
  assert.notEqual(librarianConnectionKey(config), librarianConnectionKey({ ...config, agent: 'claude' }));
});

test('Librarian never falls back to a default directory when the library is unavailable', async () => {
  const client = new EvenTerminal(config, { fetcher: async url => {
    assert.equal(new URL(url).pathname, '/api/pageborne/library');
    return new Response('', { status: 404 });
  } });
  await assert.rejects(client.ask({ context: librarianContext(), question: 'List documents.' }, {}, () => {}), /updated Pageborne extension/);
});

test('stock servers keep text context and never request or prepare paper files without the capability', async () => {
  const mock = mockTerminal(); const client = new EvenTerminal(config, { fetcher: mock.fetcher, pollMs: 1 });
  const response = await client.ask({ ...input, paper: () => { throw new Error('Stock must not prepare files'); } }, {}, () => {});
  assert.equal(response.answer, 'The completed answer.');
  assert(!mock.requests.some(r => r.u.pathname.includes('/pageborne/')));
  assert(mock.requests.find(r => r.u.pathname.endsWith('/prompt')).body.text.includes(input.context.passage));
});

test('new paper names work on stock and extended Terminal without renaming linked or resumed sessions', async () => {
  for (const pageborne of [undefined, { sessionTitles: 1 }]) {
    const mock = mockTerminal({ pageborne }); const client = new EvenTerminal(config, { fetcher: mock.fetcher, pollMs: 1 });
    const paper = { ...input, context: { ...input.context, title: '  Giving\nReasons  ' } };
    let binding;
    await client.ask(paper, {}, b => { binding = b; });
    const first = mock.requests.find(r => r.u.pathname.endsWith('/prompt')).body;
    assert(first.text.startsWith('Giving Reasons\n\nPageborne question '));
    assert.equal(first.sessionTitle, pageborne ? 'Giving Reasons' : undefined);
    assert.equal(binding.sessionTitle, 'Giving Reasons');
    const id = binding.sessionId;
    await client.ask({ ...paper, context: { ...paper.context, title: 'Changed title' } }, binding, b => { binding = b; });
    const second = mock.requests.filter(r => r.u.pathname.endsWith('/prompt')).at(-1).body;
    assert.equal(second.sessionId, id); assert(!('sessionTitle' in second));
    assert(second.text.startsWith('Pageborne question '));
    assert.equal(binding.sessionTitle, 'Giving Reasons');
    // Same-titled papers are separate sessions, not a lookup keyed by title.
    await client.ask({ ...paper, paperId: 'another-paper' }, {}, b => { binding = b; });
    assert.notEqual(binding.sessionId, id);
    await client.ask(paper, { sessionId: 'manually-linked' }, b => { binding = b; });
    assert(!binding.sessionTitle);
    assert(!('sessionTitle' in mock.requests.filter(r => r.u.pathname.endsWith('/prompt')).at(-1).body));
  }
});

test('optional name capability lookup failure keeps the stock-compatible prompt usable', async () => {
  const mock = mockTerminal();
  const client = new EvenTerminal(config, { pollMs: 1, fetcher: (url, options) => new URL(url).pathname.endsWith('/info')
    ? Promise.resolve(new Response('Unavailable', { status: 503 })) : mock.fetcher(url, options) });
  assert.equal((await client.ask(input, {}, () => {})).answer, 'The completed answer.');
  const prompts = mock.requests.filter(r => r.u.pathname.endsWith('/prompt'));
  assert.equal(prompts.length, 1); assert(!('sessionTitle' in prompts[0].body));
  assert(prompts[0].body.text.startsWith('Paper\n\n'));
});

test('stock follow-ups resend fresh context after moving and as more PDF text finishes preparing', async () => {
  const mock = mockTerminal(); const client = new EvenTerminal(config, { fetcher: mock.fetcher, pollMs: 1 });
  const layout = { format: 'pdf', maxY: 1000, preparation: { complete: false }, blocks: [
    { y: 0, page: 1, reflow: { text: 'EARLY TEXT '.repeat(800), rows: [{ y: 0, start: 0, text: 'EARLY TEXT' }] } },
    { y: 900, page: 2, reflow: { text: 'LATER TEXT '.repeat(800), rows: [{ y: 0, start: 7900, text: 'LATER TEXT' }] } },
  ] };
  let binding; const save = b => { binding = b; }; const paper = () => { throw new Error('Stock must not prepare files'); };
  const contexts = [askContext(layout, 0, 'Paper', null, 1000), askContext(layout, 900, 'Paper', null, 1000)];
  for (const context of contexts) await client.ask({ ...input, context, paper }, binding, save);
  const session = binding.sessionId;
  const completed = { ...layout, preparation: { complete: true }, blocks: [...layout.blocks, { y: 990, page: 3, reflow: { text: 'NEWLY PREPARED CONCLUSION '.repeat(40) } }] };
  contexts.push(askContext(completed, 900, 'Paper', null, 1000));
  await client.ask({ ...input, context: contexts.at(-1), paper }, binding, save);
  const prompts = mock.requests.filter(r => r.u.pathname.endsWith('/prompt'));
  assert.equal(prompts.length, 3); assert(prompts.slice(1).every(r => r.body.sessionId === session));
  const sent = prompts.map(r => JSON.parse(r.body.text.match(/Reading context \(source material\):\n([^\n]+)/)[1]));
  assert.equal(sent[0].focus, 'EARLY TEXT'); assert.equal(sent[1].focus, 'LATER TEXT');
  assert.equal(sent[1].page, 2); assert.equal(sent[1].position, 90); assert(sent[1].partial);
  assert.notEqual(sent[0].passage, sent[1].passage);
  assert(sent[2].passage.includes('NEWLY PREPARED CONCLUSION')); assert.equal(sent[2].partial, false);
  for (let i = 0; i < contexts.length; i++) assert.equal(sent[i].passage, contexts[i].passage);
  assert(!mock.requests.some(r => r.u.pathname.includes('/pageborne/')));
});

test('custom providers go directly to the chosen endpoint with its key and model, including Anthropic browser headers', async () => {
  for (const provider of ['openai-compatible', 'anthropic']) {
    let calls = 0;
    const c = { mode: 'provider', provider, baseUrl: 'https://inference.example/v1', model: 'selected-model', apiKey: 'secret-key' };
    const response = await providerAnswer(c, input, undefined, { evenHost: true, origins: ['https://inference.example'], fetcher: async (url, options) => {
      calls++; assert.equal(url, c.baseUrl + (provider === 'anthropic' ? '/messages' : '/chat/completions'));
      assert.equal(JSON.parse(options.body).model, c.model);
      if (provider === 'anthropic') {
        assert.equal(options.headers['x-api-key'], c.apiKey); assert.equal(options.headers['anthropic-dangerous-direct-browser-access'], 'true'); assert(!options.headers.Authorization);
        return Response.json({ content: [{ type: 'text', text: 'Answer.' }] });
      }
      assert.equal(options.headers.Authorization, `Bearer ${c.apiKey}`);
      return Response.json({ choices: [{ message: { content: 'Answer.' } }] });
    } });
    assert.equal(response.answer, 'Answer.'); assert.equal(calls, 1);
  }
});

test('paper sessions are scoped to document, server and agent; model choices isolate direct-provider history', () => {
  const keys = [paperConnectionKey(config, 'paper-a'), paperConnectionKey(config, 'paper-b'), paperConnectionKey({ ...config, agent: 'claude' }, 'paper-a'), paperConnectionKey({ ...config, endpoint: 'https://other.example' }, 'paper-a')];
  assert.equal(new Set(keys).size, 4); assert(!keys.join('').includes(config.token));
  assert.throws(() => checkConnection(config, { evenHost: true, origins: [] }), /not enabled/);
  assert.throws(() => checkTranscription(config), /speech-to-text/);
  assert.throws(() => checkConnection({ ...config, endpoint: 'https://token:secret@example.com' }));
  assert.equal(checkConnection({ ...config, endpoint: 'https://terminal.example/api/' }).endpoint, config.endpoint);
});

test('official Terminal request contract creates, saves and resumes separate Claude and Codex paper sessions', async () => {
  for (const agent of ['claude', 'codex']) {
    const mock = mockTerminal({ agent }); const client = new EvenTerminal({ ...config, agent }, { fetcher: mock.fetcher, pollMs: 1 });
    let binding; const save = b => { binding = structuredClone(b); };
    assert.equal((await client.ask(input, {}, save)).answer, 'The completed answer.');
    const id = binding.sessionId; assert(id); assert(!binding.pending);
    await client.ask({ ...input, question: 'Follow up' }, binding, save);
    const prompts = mock.requests.filter(r => r.u.pathname.endsWith('/prompt')); assert.equal(prompts.length, 2);
    assert.equal(prompts[0].body.cwd, '/reading'); assert(!prompts[0].body.sessionId);
    assert.equal(prompts[1].body.sessionId, id); assert(!('cwd' in prompts[1].body));
    let second; await client.ask({ ...input, paperId: 'paper-two', context: { ...input.context, title: 'Another paper' } }, {}, b => { second = b; });
    assert.notEqual(second.sessionId, id); assert.equal((await client.sessions()).length, 2);
  }
});

test('native Claude prepares one shared owner before sending, preserving the creation key after an interrupted response', async () => {
  const mock = mockTerminal({ agent: 'claude' }); let binding; let first = true; const preparations = [];
  const client = new EvenTerminal({ ...config, agent: 'claude' }, { pollMs: 1, fetcher: async (url, options) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/info')) return Response.json({ version: 'Native session', pageborne: { nativeSessionCreation: 1 } });
    if (u.pathname.endsWith('/pageborne/session')) {
      const request = JSON.parse(options.body); preparations.push(request);
      assert.equal(binding.nativeSessionRequestId, request.requestId); assert(!binding.pending);
      if (first) { first = false; throw new TypeError('Lost response after starting owner'); }
      return Response.json({ sessionId: request.requestId, cwd: request.cwd, provider: 'claude' });
    }
    return mock.fetcher(url, options);
  } });
  const save = value => { binding = structuredClone(value); };
  await assert.rejects(client.ask(input, {}, save));
  assert(!binding.pending); assert.equal(mock.requests.filter(r => r.u.pathname.endsWith('/prompt')).length, 0);
  const key = binding.nativeSessionRequestId;
  assert.equal((await client.ask(input, binding, save)).answer, 'The completed answer.');
  assert.equal(binding.sessionId, key); assert.equal(preparations[0].requestId, preparations[1].requestId);
  const prompts = mock.requests.filter(r => r.u.pathname.endsWith('/prompt'));
  assert.equal(prompts.length, 1); assert.equal(prompts[0].body.sessionId, key);
  await client.ask(input, binding, save); assert.equal(preparations.length, 2);
});

test('Terminal ignores old replies, refuses busy sessions, and never presents failed or unrelated turns as an answer', async () => {
  const mock = mockTerminal(); mock.sessions.set('existing', { state: 'busy', messages: [{ id: 1, type: 'result', success: true, text: 'Old reply' }] });
  const client = new EvenTerminal(config, { fetcher: mock.fetcher, pollMs: 1 });
  await assert.rejects(client.ask(input, { sessionId: 'existing' }, () => {}), /busy/); assert(!mock.requests.some(r => r.u.pathname.endsWith('/prompt')));
  mock.sessions.get('existing').state = 'idle';
  assert.equal((await client.ask(input, { sessionId: 'existing' }, () => {})).answer, 'The completed answer.');
  const failed = mockTerminal({ result: { success: false, text: 'Incomplete private stack trace' } });
  await assert.rejects(new EvenTerminal(config, { fetcher: failed.fetcher }).ask(input, {}, () => {}), /did not complete/);
  const pending = { sessionId: 'existing', pending: { marker: 'our-request', cursor: 0 } };
  mock.sessions.set('existing', { state: 'idle', messages: [{ id: 1, type: 'user_prompt', text: 'our-request' }, { id: 2, type: 'user_prompt', text: 'Someone else' }, { id: 3, type: 'result', success: true, text: 'Another reply' }] });
  await assert.rejects(client.reply(pending, () => {}), /Another prompt/);
});

test('leaving Ask while submission is pending still saves its returned ID; Check reply does not resend', async () => {
  const mock = mockTerminal(); let accepted; let release;
  const acceptedPromise = new Promise(r => { accepted = r; });
  const fetcher = async (url, options) => {
    const response = await mock.fetcher(url, options);
    if (new URL(url).pathname.endsWith('/prompt')) { accepted(); await new Promise(r => { release = r; }); }
    return response;
  };
  const client = new EvenTerminal(config, { fetcher, pollMs: 1 }); const abort = new AbortController(); let binding;
  const promise = client.ask(input, {}, b => { binding = b; }, abort.signal);
  await acceptedPromise; abort.abort(); release(); await assert.rejects(promise, /cancelled/);
  assert(binding.sessionId); assert(binding.pending);
  assert.equal((await client.reply(binding, b => { binding = b; })).answer, 'The completed answer.');
  assert(!binding.pending); assert.equal(mock.requests.filter(r => r.u.pathname.endsWith('/prompt')).length, 1);
});

test('ambiguous submissions persist and cannot be duplicated automatically; definite rejections clear the pending state', async () => {
  let posts = 0; let binding;
  const client = new EvenTerminal(config, { fetcher: async url => { if (new URL(url).pathname.endsWith('/info')) return Response.json({ provider: 'codex' }); posts++; throw new TypeError('Disconnected after accepting'); } });
  await assert.rejects(client.ask(input, {}, b => { binding = b; })); assert(binding.pending); assert(!binding.sessionId);
  await assert.rejects(client.ask(input, binding, () => {}), /previous question/); assert.equal(posts, 1);
  await assert.rejects(client.reply(binding, () => {}), /No confirmed session/);
  const rejected = new EvenTerminal(config, { fetcher: async url => new URL(url).pathname.endsWith('/info') ? Response.json({ provider: 'codex' }) : new Response('private error', { status: 400 }) });
  await assert.rejects(rejected.ask(input, {}, b => { binding = b; }), /existing desktop session/); assert(!binding.pending);
});

test('pending permissions are left for the desktop, and an interrupted result stays an error', async () => {
  const progress = []; let calls = 0;
  const client = new EvenTerminal(config, { pollMs: 1, fetcher: async () => {
    calls++;
    return Response.json({ state: calls === 1 ? 'awaiting_permission' : 'idle', messages: [
      { id: 1, type: 'user_prompt', text: 'marker' }, { id: 2, type: 'permission_request', toolName: 'Shell' },
      ...(calls === 1 ? [] : [{ id: 3, type: 'result', success: false, text: 'Interrupted' }])] });
  } });
  await assert.rejects(client.reply({ sessionId: 'id', pending: { marker: 'marker' } }, () => {}, undefined, p => progress.push(p)), /did not complete/);
  assert.match(progress[0], /desktop/); assert.equal(calls, 2);
});

test('a disconnected native Claude rejection releases the unsent prompt without losing its session or resending', async () => {
  const original = { sessionId: 'existing', cwd: '/reading', documentRevision: 'revision', reply: { answer: 'Earlier reply' } };
  let binding = original, posts = 0;
  const client = new EvenTerminal({ ...config, agent: 'claude' }, { fetcher: async url => {
    const path = new URL(url).pathname;
    if (path.endsWith('/history')) return Response.json({ history: [] });
    if (path.endsWith('/messages')) return Response.json({ state: 'idle', messages: [] });
    assert(path.endsWith('/prompt')); posts++;
    return Response.json({ error: 'Claude Remote Control is disconnected. Reconnect the normal Claude session before sending.' }, { status: 409 });
  } });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(client.submit(input, binding, next => { binding = next; }), error => error.submissionRejected && /not sent/.test(error.message));
    assert.deepEqual(binding, original); assert.equal(posts, attempt, 'only the explicit submit attempts POST');
  }
});

test('unknown, oversized, or lost rejection responses remain unconfirmed and cannot be resent automatically', async () => {
  for (const response of [
    () => Response.json({ error: 'private unknown conflict' }, { status: 409 }),
    () => Response.json({ error: 'Claude Remote Control: private upstream conflict' }, { status: 409 }),
    () => Response.json({ error: 'x'.repeat(3000) }, { status: 409 }),
    () => new Response('private broken JSON', { status: 409, headers: { 'content-type': 'application/json' } }),
    () => { throw new TypeError('lost acknowledgement'); },
  ]) {
    let binding = { sessionId: 'existing' }, posts = 0;
    const client = new EvenTerminal(config, { fetcher: async url => {
      const path = new URL(url).pathname;
      if (path.endsWith('/info')) return Response.json({ pageborne: { conversationSync: 1 } });
      if (path.endsWith('/history')) return Response.json({ history: [] });
      if (path.endsWith('/messages')) return Response.json({ state: 'idle', messages: [] });
      if (path.endsWith('/conversation')) return Response.json({ version: 1, sessionId: 'existing', state: 'idle', turns: [] });
      assert(path.endsWith('/prompt')); posts++; return response();
    } });
    await assert.rejects(client.submit(input, binding, next => { binding = next; }), e => !e.submissionRejected && !e.message.includes('private'));
    assert(binding.pending); assert(!binding.pending.submitted);
    await assert.rejects(client.submit(input, binding, () => assert.fail('No mutation on a blocked retry')), /unconfirmed/);
    assert.equal(posts, 1);
  }
});

test('native pre-send rejection classification is limited to prompt POSTs and exact conflict messages', async () => {
  const payload = { error: 'Claude Remote Control is disconnected. Reconnect the normal Claude session before sending.' };
  for (const options of [{}, { body: {} }, { terminalPrompt: true }]) {
    await assert.rejects(connectionRequest('https://terminal.example/api/prompt', { ...options, fetcher: async () => Response.json(payload, { status: 409 }) }), e => !e.submissionRejected);
  }
  await assert.rejects(connectionRequest('https://terminal.example/api/prompt', { body: {}, terminalPrompt: true, fetcher: async () => Response.json(payload, { status: 503 }) }), e => !e.submissionRejected);
});


test('default stock behavior omits cwd; an existing directory override is passed only for new sessions', async () => {
  const mock = mockTerminal(); let binding;
  const client = new EvenTerminal({ ...config, cwd: '' }, { fetcher: mock.fetcher });
  await client.ask(input, {}, b => { binding = b; });
  await client.ask(input, { cwd: '/existing/paper-folder' }, () => {});
  const prompts = mock.requests.filter(r => r.body);
  assert.deepEqual(Object.keys(prompts[0].body).sort(), ['provider', 'text']);
  assert.equal(prompts[1].body.cwd, '/existing/paper-folder');
  assert(!mock.requests.some(r => r.u.pathname.includes('pageborne')));
  assert.throws(() => checkConnection({ ...config, cwd: '~/not-expanded-by-the-api' }), /absolute/);
  assert.equal(checkConnection({ ...config, cwd: '', baseDir: '~/old-companion' }).cwd, '');
});

test('optional automatic directories require an advertised capability and never silently downgrade', async () => {
  const mock = mockTerminal(); const client = new EvenTerminal({ ...config, cwd: '', paperDirectories: true }, { fetcher: mock.fetcher });
  await assert.rejects(client.ask(input, {}, () => {}), /does not offer automatic/);
  assert(!mock.requests.some(r => r.u.pathname.includes('pageborne') || r.body));
  // An existing linked session still works with a stock server, without mkdir.
  await client.ask(input, { sessionId: 'existing' }, () => {});
  assert(!mock.requests.some(r => r.u.pathname.includes('pageborne')));
});

test('Terminal streams matched partial text once per snapshot and keeps completion separate from partial results', async () => {
  let calls = 0; const updates = []; let saved;
  const client = new EvenTerminal(config, { pollMs: 1, fetcher: async () => {
    calls++;
    return Response.json({ state: calls < 4 ? 'busy' : 'idle', messages: [
      { id: 1, type: 'result', success: true, text: 'Unrelated old answer' },
      { id: 2, type: 'user_prompt', text: 'our-marker' },
      { id: 3, type: 'text_delta', text: 'The first part. ' },
      ...(calls > 1 ? [{ id: 4, type: 'text_delta', text: 'The second part.' }] : []),
      ...(calls === 4 ? [{ id: 5, type: 'result', success: true, text: 'The first part. The second part.' }] : []),
    ] });
  } });
  const answer = await client.reply({ sessionId: 's', pending: { marker: 'our-marker', cursor: 1 } }, b => { saved = b; }, undefined, (status, text) => updates.push({ status, text }));
  assert.equal(updates[0].text, 'The first part. '); assert.equal(updates[1].text, 'The first part. The second part.');
  assert.equal(updates[2].text, updates[1].text); assert(updates.every(u => !u.text.includes('Unrelated')));
  assert.equal(answer.answer, 'The first part. The second part.'); assert(!saved.pending); assert(saved.reply.unread);
  assert.equal(saved.reply.answer, answer.answer);
});

test('busy shared sessions accept follow-ups and correlate complete, partial and steered replies by marker', async () => {
  const turns = [{ id: 'first', marker: 'first-marker', question: 'First', answer: 'Earlier partial', state: 'pending' }], posts = [], snapshots = [];
  let binding = { sessionId: 'same-session', pending: { marker: 'first-marker', turnId: 'local-first', submitted: true } };
  const client = new EvenTerminal(config, { onConversation: value => snapshots.push(value), fetcher: async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return Response.json({ pageborne: { conversationSync: 1 } });
    if (route.endsWith('/history')) return Response.json({ history: [] });
    if (route === '/api/messages') return Response.json({ state: 'busy', messages: [] });
    if (route === '/api/prompt') {
      const body = JSON.parse(options.body); posts.push(body);
      turns.push({ id: 'second', marker: body.text.match(/Pageborne question [\w-]+/)[0], question: input.question, answer: '', state: 'pending' });
      return Response.json({ sessionId: 'same-session' });
    }
    if (route === '/api/pageborne/conversation') return Response.json({ version: 1, sessionId: 'same-session', state: 'busy', turns });
    assert.fail(route);
  } });
  const save = next => { binding = next; };
  await client.submit({ ...input, turnId: 'local-second' }, binding, save);
  assert.equal(posts.length, 1); assert.equal(posts[0].sessionId, 'same-session');
  assert(binding.pending.submitted); assert(binding.sharedReplies);
  turns[0].state = 'complete'; turns[0].answer = 'Earlier complete answer';
  assert.equal((await client.peek(binding)).kind, 'pending', 'first result cannot complete the second question');
  turns[1].answer = 'Second partial'; assert.equal((await client.peek(binding)).answer, 'Second partial');
  turns[1].state = 'complete'; turns[1].answer = 'Second complete answer';
  const completed = await client.reply(binding, save);
  assert.equal(completed.answer, 'Second complete answer'); assert.equal(binding.reply.turnId, 'local-second');
  assert.equal(snapshots[0].turns[0].answer, 'Earlier complete answer'); assert(!binding.pending);
  const steered = { ...binding, pending: { marker: turns[1].marker, turnId: 'local-second' } };
  turns[1].answer = '';
  assert.deepEqual(await client.reply(steered, () => {}), { answer: '', superseded: true });
});

test('ambiguous follow-ups require transcript confirmation and aborted reads cannot save over a newer submission', async () => {
  const controller = new AbortController(); let confirmed = false, posts = 0, saves = 0;
  const binding = { sessionId: 's', sharedReplies: true, notification: 'error', pending: { marker: 'unconfirmed' } };
  const client = new EvenTerminal(config, { fetcher: async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/api/info') return Response.json({ pageborne: { conversationSync: 1 } });
    if (route === '/api/pageborne/conversation') {
      if (confirmed) controller.abort();
      return Response.json({ version: 1, sessionId: 's', state: 'idle', turns: confirmed ? [{ id: 'one', marker: 'unconfirmed', question: 'First', answer: 'Answer', state: 'complete' }] : [] });
    }
    if (options.method === 'POST') posts++;
    assert.fail('An unconfirmed prompt must not be resent');
  } });
  await assert.rejects(client.submit(input, binding, () => saves++), /unconfirmed/);
  assert.equal(posts, 0); assert.equal(saves, 0);
  confirmed = true;
  await assert.rejects(client.reply(binding, () => saves++, controller.signal), /cancelled/);
  assert.equal(saves, 0);
});
