import { connectionRequest, checkConnection, checkWorkingDirectory, terminalHeaders } from './ask-connections.js';
import { instructions, instructionsForPlatform, inferenceInput } from '../ai/providers.js';
import { syncPaperFiles, fileQuestion } from './ask-documents.js';
import { paperSessionTitle } from '../integrations/even-terminal/pageborne-session-titles.js';
import { desktopLibrary } from './library-sync.js';
import { librarianQuestion } from './librarian.js';
import { SESSION_LIST_LIMIT, terminalSessionQuestion } from './terminal-sessions.js';
import { displayQuestion } from '../integrations/even-terminal/pageborne-conversation.js';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(new Error('Question cancelled.')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
  signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
});

const peekResult = result => result?.kind === 'ready' && !result.answer
  ? { kind: 'error', message: 'The desktop agent returned no text.' } : result;

// The official 0.10.5 HTTP protocol only accepts provider, cwd and sessionId.
// Model, reasoning and permission choices belong to the desktop session.
export class EvenTerminal {
  constructor(config, { fetcher = fetch, pollMs = 700, timeoutMs = 300000, diagnostics, onLibraryFile = () => {}, onConversation = () => {}, ...options } = {}) {
    this.config = checkConnection(config, options); Object.assign(this, { fetcher, pollMs, timeoutMs, diagnostics, onLibraryFile, onConversation });
  }
  api(route, { query = {}, ...options } = {}) {
    const search = new URLSearchParams({ provider: this.config.agent, ...query });
    return connectionRequest(`${this.config.endpoint}/api/${route}?${search}`, { token: this.config.token, fetcher: this.fetcher, ...options, headers: { ...terminalHeaders(this.config.endpoint), ...options.headers } })
      .catch(error => { this.connectionError(route, options.body === undefined ? 'GET' : 'POST', error); throw error; });
  }
  connectionError(route, method, error, details = {}) {
    if (error.connectionFailure === 'cancelled' || error.name === 'AbortError') return;
    // Only known route names and coarse transport data. Never record tokens,
    // session IDs, queries, uploaded files, prompts or raw response/error text.
    const request = route.startsWith('sessions/') ? 'sessions/history'
      : /^(info|sessions|messages|prompt|events|pageborne\/[a-z-]+)$/.test(route) ? route : 'other';
    const endpoint = new URL(this.config.endpoint);
    this.diagnostics?.error('ask-connection-error', new Error('Desktop connection failed.'), {
      request, method, origin: endpoint.origin, provider: this.config.agent,
      failure: error.connectionFailure || (error.status ? 'http' : 'request'), status: error.status,
      ...details,
    });
  }
  async sessions(signal) {
    const result = await this.api('sessions', { signal, timeoutMs: 15000, query: { limit: SESSION_LIST_LIMIT } });
    if (result.error || !Array.isArray(result.sessions)) throw new Error('Could not list desktop sessions. Check that the selected agent is connected.');
    return result.sessions;
  }
  async serverInfo(signal) {
    this.info ||= this.api('info', { signal }).catch(error => { this.info = null; throw error; });
    const info = await this.info;
    if (info.error) throw new Error('Even Terminal could not load that agent. Check the desktop.');
    return info;
  }
  async conversation(binding, signal) {
    if ((await this.serverInfo(signal)).pageborne?.conversationSync !== 1) return null;
    const result = await this.api('pageborne/conversation', { signal, timeoutMs: 15000, query: { sessionId: binding.sessionId } });
    if (result.version !== 1 || result.sessionId !== binding.sessionId || !Array.isArray(result.turns) || result.turns.length > 40 || result.turns.some(t =>
      !t || typeof t.id !== 'string' || !t.id || typeof t.question !== 'string' || typeof t.answer !== 'string' ||
      (t.aliases != null && (!Array.isArray(t.aliases) || t.aliases.some(id => typeof id !== 'string'))) ||
      (t.marker != null && typeof t.marker !== 'string') || !['pending', 'complete', 'error'].includes(t.state)) ||
      new Set(result.turns.map(t => t.id)).size !== result.turns.length) {
      throw Object.assign(new Error('The desktop returned an invalid conversation.'), { connectionFailure: 'invalid-response' });
    }
    for (const turn of result.turns) {
      const parsed = displayQuestion(turn.question);
      if (parsed.marker) Object.assign(turn, parsed);
    }
    // Optional extension; old bridges still return ordinary text history.
    for (const turn of result.turns) if (turn.activities != null && (!Array.isArray(turn.activities) || turn.activities.length > 24
      || turn.activities.some(a => !a || typeof a.id !== 'string' || typeof a.text !== 'string'
        || (a.detail != null && (typeof a.detail !== 'string' || a.detail.length > 1000))
        || !['tool', 'thinking', 'status'].includes(a.kind) || !['pending', 'complete', 'error'].includes(a.state))))
      throw Object.assign(new Error('The desktop returned invalid activity.'), { connectionFailure: 'invalid-response' });
    return result;
  }
  async nativeClaude(signal) {
    return this.config.agent === 'claude' && (await this.serverInfo(signal)).version === 'Native session';
  }
  async workspace(paperId, title, workspaceId, signal) {
    if ((await this.serverInfo(signal)).pageborne?.workspaces !== 1) throw new Error('This server does not offer automatic session folders. Turn that option off to use stock Even Terminal.');
    const workspace = await this.api('pageborne/workspace', { signal, body: { paperId, title, workspaceId, baseDir: this.config.baseDir || undefined } });
    if (!workspace.cwd) throw new Error('Even Terminal did not return a session directory.');
    checkWorkingDirectory(workspace.cwd);
    return workspace;
  }
  async watch(sessionId, signal) {
    // SSE keeps the desktop subscription alive. In the shared-session fork it
    // also attaches the existing owner. Polling /messages alone does neither.
    const query = new URLSearchParams({ provider: this.config.agent, sessionId, needReplay: 'false' });
    let stage = 'connecting';
    try {
      // Native Window.fetch rejects an EvenTerminal receiver. Invoke the
      // injected function unbound, as connectionRequest does for other routes.
      const fetcher = this.fetcher;
      const response = await fetcher(`${this.config.endpoint}/api/events?${query}`, { signal, headers: { ...terminalHeaders(this.config.endpoint, 'text/event-stream'), Authorization: `Bearer ${this.config.token}` }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Desktop event connection unavailable.'), { status: response.status }); }
      stage = 'opening-stream';
      const reader = response.body.getReader(); stage = 'reading-stream';
      try { while (!(await reader.read()).done) { if (signal?.aborted) break; } }
      finally { await reader.cancel().catch(() => {}); }
    } catch (error) {
      if (!signal?.aborted) this.connectionError('events', 'GET', error, { stage,
        errorType: ['TypeError', 'NetworkError', 'SecurityError'].includes(error.name) ? error.name : 'Error' });
      throw error;
    }
  }
  async peek(binding, signal) {
    if (!binding.sessionId) return { kind: 'pending' };
    if (binding.sharedReplies && binding.pending) {
      // A native session can accept follow-ups before its current turn ends.
      // Event deltas alone cannot attribute these replies: match the question's
      // stable marker in the shared transcript, including steering-only turns.
      const conversation = await this.conversation(binding, signal);
      if (!conversation) throw new Error('Shared conversation tracking is unavailable. Check the desktop session.');
      const turn = conversation.turns.find(t => t.marker === binding.pending.marker);
      if (turn?.state === 'error') return { kind: 'error', message: 'The desktop agent did not complete the answer.', conversation };
      if (turn?.state === 'complete') return { kind: 'ready', answer: turn.answer, superseded: !turn.answer, conversation };
      return { kind: /awaiting|permission|question/.test(conversation.state) ? 'waiting' : 'pending', answer: turn?.answer || '', conversation };
    }
    const response = await this.api('messages', { signal, timeoutMs: 15000, query: { sessionId: binding.sessionId } });
    let matched = !binding.pending; let answer = ''; let latest; let lastTextId = 0;
    const messages = response.messages || [];
    for (const m of messages) {
      if (binding.pending && m.id <= (binding.pending.cursor || 0)) continue;
      if (!binding.pending && m.id <= (binding.seenEventId || 0)) continue;
      if (m.type === 'user_prompt') {
        if (binding.pending && matched && !String(m.text).includes(binding.pending.marker)) {
          // A later question cannot invalidate this question's completed reply.
          // Keep its event cursor so the later turn can be checked separately.
          if (latest?.seenEventId != null) return peekResult(latest);
          return { kind: 'error', message: 'Another prompt arrived. Check the desktop session.' };
        }
        matched = !binding.pending || String(m.text).includes(binding.pending.marker); answer = ''; lastTextId = 0; latest = undefined;
      }
      if (!matched) continue;
      if (m.type === 'text_delta') { answer = (answer + (m.text || '')).slice(0, 16000); lastTextId = m.id; }
      // A recoverable error can precede a successful result, or belong to an
      // earlier desktop turn. Let later events establish the current outcome.
      if (m.type === 'error') latest = { kind: 'error', message: 'The desktop agent reported an error. Check its session.' };
      if (m.type === 'result') latest = m.success ? { kind: 'ready', answer: String(m.text || answer).trim().slice(0, 16000), seenEventId: m.id }
        : { kind: 'error', message: 'The desktop agent did not complete the answer.', seenEventId: m.id };
    }
    if (latest) return peekResult(latest);
    if (/awaiting|permission|question/.test(response.state || '')) return { kind: 'waiting', answer };
    // The local native-Claude adapter can receive only assistant snapshots
    // plus an authoritative idle state, without a result event. Confirm that
    // the same completed text remains idle across two observations.
    if (matched && answer.trim() && response.state === 'idle' && await this.nativeClaude(signal)) {
      const prior = binding.idleCandidate;
      if (prior?.id === lastTextId && prior.answer === answer && Date.now() - prior.at >= 1500) return { kind: 'ready', answer: answer.trim(), seenEventId: lastTextId };
      return { kind: 'pending', answer, idleCandidate: { id: lastTextId, answer, at: prior?.id === lastTextId && prior.answer === answer ? prior.at : Date.now() } };
    }
    return { kind: binding.pending || response.state === 'busy' ? 'pending' : 'idle', answer };
  }
  async ask(input, binding = {}, save, signal, progress = () => {}, submissionSignal = signal) {
    const next = await this.submit(input, binding, save, submissionSignal, progress);
    return this.reply(next, save, signal, progress);
  }
  async submit(input, binding = {}, save, submissionSignal, progress = () => {}) {
    if (binding.pending) {
      if (!binding.sessionId || (await this.serverInfo(submissionSignal)).pageborne?.conversationSync !== 1) throw new Error('A previous question may still be running. Check its reply before sending another message.');
      if (!binding.pending.submitted) {
        const conversation = await this.conversation(binding, submissionSignal);
        if (!conversation.turns.some(t => t.marker === binding.pending.marker)) throw new Error('The previous submission is unconfirmed. Check the desktop session before sending another message.');
      }
      binding = { ...binding, sharedReplies: true };
    }
    const terminalSession = input.context?.scope === 'terminal-session';
    if (terminalSession && !binding.sessionId) throw new Error('Select an existing desktop session first.');
    let cursor = 0;
    let cwd = terminalSession ? undefined : checkWorkingDirectory(binding.cwd ?? (this.config.paperDirectories ? '' : this.config.cwd)) || undefined;
    const librarian = input.context?.scope === 'library';
    if (librarian) {
      progress('Opening library…');
      const library = await desktopLibrary(this, submissionSignal);
      cwd = checkWorkingDirectory(library.directory);
      if (!cwd) throw new Error('The desktop did not return a library directory.');
      if (binding.sessionId && (binding.libraryId !== library.id || binding.cwd !== cwd)) throw new Error('The desktop library has changed. Start a new Librarian session before asking.');
      binding = { ...binding, cwd, libraryId: library.id }; save(binding);
    }
    if (binding.sessionId) {
      // Hydrates an existing session on the shared-daemon adapter, without
      // posting a prompt or changing its model/permissions.
      const history = await this.api(`sessions/${encodeURIComponent(binding.sessionId)}/history`, { signal: submissionSignal, query: { limit: 1 } });
      if (history.error) throw new Error('The saved session is unavailable. Select an existing session in Ask.');
      const snapshot = await this.api('messages', { signal: submissionSignal, query: { sessionId: binding.sessionId } });
      if (snapshot.state !== 'idle') {
        if (snapshot.state !== 'busy' || (await this.serverInfo(submissionSignal)).pageborne?.conversationSync !== 1) throw new Error('This desktop session is busy. Wait for it to finish before asking.');
        binding = { ...binding, sharedReplies: true };
      }
      cursor = Math.max(0, ...(snapshot.messages || []).map(m => m.id));
    } else {
      if (await this.nativeClaude(submissionSignal) && (await this.serverInfo(submissionSignal)).pageborne?.nativeSessionCreation !== 1) throw new Error('This Claude connector requires an existing Remote Control session. Start Claude on the desktop, enable Remote Control, then use Refresh sessions and select it here.');
      if (!librarian && this.config.paperDirectories && !cwd) {
        const workspaceId = binding.workspaceId || crypto.randomUUID();
        binding = { ...binding, workspaceId }; save(binding);
        const workspace = await this.workspace(input.paperId, input.context.title, workspaceId, submissionSignal);
        cwd = workspace.cwd;
        binding = { ...binding, cwd, managedWorkspace: true }; save(binding);
      }
    }
    if (submissionSignal?.aborted) throw new Error('Question cancelled.');
    const marker = `Pageborne question ${crypto.randomUUID()}`;
    inferenceInput({ ...input, context: { ...input.context, passage: '' }, history: [] }); // Validate the question before sharing files.
    let attachment;
    if (!librarian && !terminalSession && input.paper && (await this.serverInfo(submissionSignal)).pageborne?.documents === 1) {
      progress('Preparing paper files…');
      const workspace = (await this.serverInfo(submissionSignal)).pageborne.documentWorkspaces === 1
        ? binding.fileWorkspace || (binding.managedWorkspace && binding.workspaceId && cwd ? { cwd, workspaceId: binding.workspaceId } : undefined) : undefined;
      attachment = await syncPaperFiles(this, input.paperId, await input.paper(), submissionSignal, progress, workspace);
      if (attachment.library && attachment.library.synced !== false) await this.onLibraryFile(this.config.endpoint, attachment.library);
      if (submissionSignal?.aborted) throw new Error('Question cancelled.');
      input.context.files = attachment; progress('Paper files ready. Asking…');
    }
    if (!binding.sessionId && await this.nativeClaude(submissionSignal)) {
      progress('Starting shared Claude session…');
      // Save the creation key before any network operation. This endpoint only
      // starts an empty native owner; a retry cannot submit the question twice.
      const title = librarian ? 'Librarian' : paperSessionTitle(input.context.title);
      binding = { ...binding, nativeSessionRequestId: binding.nativeSessionRequestId || crypto.randomUUID() }; save(binding);
      const prepared = await this.api('pageborne/session', { signal: submissionSignal,
        body: { requestId: binding.nativeSessionRequestId, ...(cwd ? { cwd } : {}), title } });
      if (prepared.sessionId !== binding.nativeSessionRequestId || prepared.provider !== 'claude' || !prepared.cwd) throw new Error('The desktop returned an invalid Claude session. Refresh sessions before trying again.');
      cwd = checkWorkingDirectory(prepared.cwd);
      binding = { ...binding, sessionId: prepared.sessionId, cwd, sessionTitle: title }; save(binding);
    }
    const sessionTitle = !binding.sessionId ? librarian ? 'Librarian' : paperSessionTitle(input.context.title) : undefined;
    const titleOptions = sessionTitle && (await this.serverInfo(submissionSignal).catch(() => null))?.pageborne?.sessionTitles === 1 ? { sessionTitle } : {};
    if (submissionSignal?.aborted) throw new Error('Question cancelled.');
    const questionText = terminalSession ? terminalSessionQuestion(marker, input.question, input.context.platform) : librarian ? librarianQuestion(marker, input.question, input.context.platform) : attachment ? fileQuestion(marker, input, attachment, !binding.sessionId || binding.documentRevision !== attachment.revision || binding.documentFiles?.index !== attachment.index)
      : `${marker}\n${instructionsForPlatform(instructions, input.context.platform)}\nThe reading context below is a fresh snapshot for this question. Its focus and position describe the reader's current place, which may differ from earlier questions. Answer as a reading companion. Do not edit files or run commands for this question.\n\n${inferenceInput({ ...input, history: [] }).map(m => m.content).join('\n\n')}`;
    // Stock Terminal derives names from the first prompt. Keep correlation
    // markers intact, but put the readable paper title ahead of them.
    const text = sessionTitle ? `${sessionTitle}\n\n${questionText}` : questionText;
    let next = { ...binding, cwd, ...(attachment ? { documentRevision: attachment.revision } : {}), documentFiles: attachment, reply: undefined, notification: undefined,
      pending: { marker, cursor, started: Date.now(), turnId: input.turnId, question: input.question } }; save(next);
    // Once submitted, wait for the returned ID even if the reader leaves Ask.
    // Never automatically resend an ambiguous POST and create a second session.
    let response;
    try { response = await this.api('prompt', { body: { text, provider: this.config.agent, ...titleOptions, ...(binding.sessionId ? { sessionId: binding.sessionId } : cwd ? { cwd } : {}) } }); }
    catch (error) {
      if ([400, 401, 403, 404, 429].includes(error.status)) save(binding);
      else save({ ...next, notification: 'error' });
      throw error;
    }
    if (typeof response.sessionId !== 'string' || !response.sessionId) { save({ ...next, notification: 'error' }); throw new Error('Even Terminal did not return a session ID. Check the desktop before retrying.'); }
    next = { ...next, sessionId: response.sessionId, pending: { ...next.pending, submitted: true }, ...(sessionTitle ? { sessionTitle } : {}) }; save(next);
    return next;
  }
  async reply(binding, save, signal, progress = () => {}) {
    if (!binding.sessionId || !binding.pending) throw new Error('No confirmed session ID is available. Refresh the desktop sessions and choose the session created for this paper.');
    let candidate = binding.idleCandidate; const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('Question cancelled.');
      let state;
      try { state = await this.peek({ ...binding, idleCandidate: candidate }, signal); }
      catch (error) {
        // A timed-out read says nothing about the submitted question's outcome.
        // Keep its marker and retry only this read, never POST /prompt.
        if (error.connectionFailure !== 'timeout' || signal?.aborted) throw error;
        progress('Reconnecting…'); await wait(this.pollMs, signal); continue;
      }
      if (signal?.aborted) throw new Error('Question cancelled.');
      candidate = state.idleCandidate;
      if (state.kind === 'error') {
        if (state.conversation) this.onConversation(state.conversation);
        if (state.seenEventId) save({ ...binding, pending: undefined, notification: 'error', seenEventId: state.seenEventId });
        else save({ ...binding, notification: 'error' });
        throw new Error(state.message);
      }
      if (state.kind === 'ready') {
        save({ ...binding, pending: undefined, notification: undefined, seenEventId: state.seenEventId, reply: { answer: state.answer, unread: !!state.answer, turnId: binding.pending.turnId || binding.pending.marker, question: binding.pending.question } });
        if (state.conversation) this.onConversation(state.conversation);
        return { answer: state.answer, ...(state.superseded ? { superseded: true } : {}) };
      }
      // Display bounded snapshots of the accumulated text_delta events. This
      // also recovers every chunk after reconnects without appending duplicates.
      progress(state.kind === 'waiting' ? 'Waiting for a response in Even Terminal or on the desktop.' : state.answer ? 'Writing answer…' : binding.libraryId ? 'Thinking about your library…' : 'Thinking about this passage…', state.answer);
      if (state.conversation) this.onConversation(state.conversation);
      await wait(this.pollMs, signal);
    }
    throw new Error('The desktop reply is still pending. Use Check reply to continue waiting; the question will not be sent again.');
  }
}
