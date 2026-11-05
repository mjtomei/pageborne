import { MAX_QUESTION_CHARS } from './ask-limits.js';
import { nativeLayout, textWindow, pageTurnY, titleText, VISIBLE_LINES } from './native-text.js';
import { parseDocument, rowAt } from './document.js';
import { contextTokens, CONTEXT_CHARS_PER_TOKEN } from '../ai/context.js';
import { transcriptionReview, transcriptionLines, reviewDialog, liveTranscriptionDialog, transcriptionGeometry } from './transcription-review.js';
import { AskConversation } from './ask-conversation.js';

// Gather a bounded window centered on the current source position, expanding
// the other side at document boundaries. Never join an entire large document.
export function askContext(layout, y, title, wordFrame, tokenBudget) {
  if (!layout) throw new Error('Open a document before asking about it.');
  const pdf = layout.format === 'pdf';
  let index = pdf ? layout.blocks.findLastIndex(b => b.y <= y) : layout.rows[rowAt(layout, y)]?.block;
  index = Math.max(0, index || 0);
  const blocks = layout.blocks;
  const text = b => String(b.reflow?.text || b.text || '').trim();
  const current = blocks[index];
  const focus = text(current);
  const rows = current?.reflow?.rows || layout.rows?.filter(r => r.block === index) || [];
  const row = rows.findLast(r => (pdf ? current.y + r.y : r.y) <= y);
  const needle = wordFrame?.text || row?.text || '';
  const sourceOffset = pdf ? row?.start : row?.offset;
  const offset = Number.isFinite(sourceOffset) ? sourceOffset : needle ? Math.max(0, focus.indexOf(needle)) : 0;
  tokenBudget = contextTokens(tokenBudget); const budget = tokenBudget * CONTEXT_CHARS_PER_TOKEN;
  const before = [focus.slice(Math.max(0, offset - budget), offset)]; let beforeLength = before[0].length;
  const after = [focus.slice(offset, offset + budget)]; let afterLength = after[0].length;
  for (let i = index - 1; i >= 0 && beforeLength < budget; i--) {
    const value = text(blocks[i]); if (!value) continue;
    const chunk = (value.slice(-budget) + '\n\n').slice(-(budget - beforeLength)); before.push(chunk); beforeLength += chunk.length;
  }
  for (let i = index + 1; i < blocks.length && afterLength < budget; i++) {
    const value = text(blocks[i]); if (!value) continue;
    const chunk = ('\n\n' + value.slice(0, budget)).slice(0, budget - afterLength); after.push(chunk); afterLength += chunk.length;
  }
  const surrounding = before.reverse().join('') + after.join('');
  const start = Math.max(0, Math.min(beforeLength - Math.floor(budget / 2), surrounding.length - budget));
  const passage = surrounding.slice(start, start + budget);
  return { title: String(title || 'Document').slice(0, 300), page: pdf ? current?.page : undefined,
    position: Math.round(100 * y / (layout.maxY || 1)),
    focus: String(needle || focus.slice(offset, offset + 600)).slice(0, 1000),
    passage, focusOffset: Math.max(0, Math.min(passage.length, beforeLength - start)),
    tokenBudget, estimatedTokens: Math.ceil(passage.length / CONTEXT_CHARS_PER_TOKEN),
    image: pdf && !current?.reflow,
    partial: layout.preparation?.complete === false };
}

export class AskSession {
  constructor(onChange = () => {}) { this.onChange = onChange; this.active = false; this.generation = 0; }
  open(context, history = [], turns) {
    if (this.active) return;
    this.active = true; this.context = context; this.history = history.slice(-8); this.answer = ''; this.y = 0;
    this.status = 'ready'; this.responseStatus = null; this.responseError = null; this.error = ''; this.savedReply = false; this.progressText = ''; this.voiceProgress = ''; this.voiceDraft = ''; this.phase = 0; this.review = null;
    this.voiceLine = null; this.voiceWords = [];
    this.displayAnswer = this.history.findLast(turn => turn.role === 'assistant')?.content || '';
    this.layout = this.displayAnswer ? nativeLayout(parseDocument(this.displayAnswer)) : null;
    this.conversation = turns ? new AskConversation() : null;
    this.viewRevision = 0; this.responseViewRevision = 0; this.focusReply = false;
    if (this.conversation) this.syncConversation(turns, 'latest');
    this.showingPrevious = !!this.layout; this.onChange();
  }
  close() { this.generation++; this.abort?.abort(); this.abort = null; this.active = false; this.history = []; this.context = null; this.answer = this.displayAnswer = ''; this.layout = null; this.conversation = null; this.review = null; this.onChange(); }
  syncConversation(turns, focus) {
    if (!this.conversation) return;
    if (this.focusReply) { focus ||= 'latest'; this.focusReply = false; }
    Object.assign(this, this.conversation.update(turns, this.y, focus, this.conversationLines()));
  }
  conversationLines() { const dialog = this.dialog(); return dialog ? transcriptionGeometry(dialog).bodyLines : VISIBLE_LINES; }
  resizeConversation() { if (this.conversation) Object.assign(this, this.conversation.resize(this.y, this.conversationLines())); }
  updateTranscription(text, words = []) {
    if (!this.active || !['starting', 'listening'].includes(this.status)) return;
    this.voiceDraft = String(text || ''); this.voiceWords = words;
    if (this.voiceLine !== null) this.voiceLine = Math.min(this.voiceLine, Math.max(0, transcriptionLines(this.voiceDraft).length - 3));
    this.resizeConversation(); this.onChange();
  }
  captureView() {
    return { answer: this.answer, displayAnswer: this.displayAnswer, y: this.y,
      anchor: this.conversation?.anchor(this.y), following: this.conversation?.following, viewRevision: this.viewRevision, responseViewRevision: this.responseViewRevision };
  }
  reviewQuestion(text, words = []) {
    if (!this.active) return;
    const page = this.review?.page ?? (this.voiceLine === null ? 0 : Math.floor(this.voiceLine / 3));
    this.review = transcriptionReview(text, words);
    this.review.page = Math.min(page, Math.max(0, this.review.pages.length - 1));
    this.setStatus('review');
  }
  cancelReview() {
    if (!this.review) return;
    this.review = null; this.restoreResponse();
  }
  restoreResponse() {
    this.setStatus(this.responseStatus || (this.layout ? 'answer' : 'ready'));
    if (this.responseStatus === 'error' && this.responseError) this.fail(this.responseError);
  }
  setStatus(status) {
    if (!this.active) return;
    if (status === 'starting') { this.voiceLine = null; this.voiceWords = []; }
    if (['thinking', 'answer'].includes(status)) this.responseStatus = status;
    this.status = status; this.error = ''; this.resizeConversation(); this.onChange();
  }
  fail(error) { if (this.active) { this.status = 'error'; this.error = error.message || String(error); this.errorKind = error.connectionFailure; this.onChange(); } }
  showAnswer(answer) {
    if (!this.active) return;
    this.answer = this.displayAnswer = String(answer).slice(0, 16000);
    if (this.conversation) this.focusReply = true;
    else { this.layout = nativeLayout(parseDocument(this.answer)); this.y = 0; }
    this.showingPrevious = false;
    this.status = this.responseStatus = 'answer'; this.error = ''; this.onChange();
  }
  restoreView({ answer = '', displayAnswer = answer, y = 0, anchor, following = false, viewRevision = 0, responseViewRevision = 0 }) {
    this.answer = answer; this.displayAnswer = displayAnswer;
    if (!this.conversation) this.layout = displayAnswer ? nativeLayout(parseDocument(displayAnswer)) : null;
    if (this.conversation) this.conversation.following = following;
    this.y = this.conversation ? following ? this.layout?.maxY || 0 : this.conversation.restore(anchor, y) : Math.min(y, this.layout?.maxY || 0);
    this.viewRevision = viewRevision; this.responseViewRevision = responseViewRevision;
    this.showingPrevious = displayAnswer !== answer;
    this.onChange();
  }
  progress(text, answer) {
    if (!this.active || (this.responseStatus || this.status) !== 'thinking') return;
    const changed = this.progressText !== text; this.progressText = text;
    const next = String(answer || '').slice(0, 16000);
    if (next && next !== this.answer) {
      this.displayResponse(next); this.onChange();
    } else if (changed) this.onChange();
  }
  displayResponse(answer) {
    if (!this.conversation) {
      if (answer !== this.displayAnswer) this.layout = nativeLayout(parseDocument(answer));
      this.y = this.showingPrevious ? 0 : Math.min(this.y, this.layout.maxY);
    }
    this.answer = this.displayAnswer = answer; this.showingPrevious = false;
  }
  tick(now, reducedMotion = false) {
    if (!this.active || !this.review?.refining && !['starting', 'listening', 'transcribing', 'thinking'].includes(this.status)) return false;
    const phase = reducedMotion ? 0 : Math.floor(now / 900) % 3;
    if (phase === this.phase) return false;
    this.phase = phase; return true;
  }
  async send(question, request, { resume = false, replace = false } = {}) {
    question = String(question || '').trim();
    if (question.length > MAX_QUESTION_CHARS) { this.fail(new Error('This message is too long. Shorten it on the phone before sending.')); return; }
    if (!this.active || !question || this.abort && !replace) return;
    const generation = ++this.generation; this.abort?.abort(); this.abort = new AbortController();
    const abort = this.abort;
    this.review = null;
    if (!resume) { if (this.conversation) this.conversation.following = true; this.answer = ''; this.showingPrevious = !!this.layout; this.responseViewRevision = this.viewRevision; }
    this.progressText = ''; this.phase = 0;
    this.responseStatus = 'thinking'; this.responseError = null;
    this.savedReply = false; this.setStatus('thinking');
    try {
      const response = await request({ context: this.context, question, history: this.history.slice(-8) }, abort.signal,
        (text, answer) => { if (this.active && this.generation === generation) this.progress(text, answer); });
      if (!this.active || this.generation !== generation) return;
      const answer = String(response.answer || '').trim().slice(0, 16000);
      if (!answer && !response.superseded) throw new Error('The endpoint returned an empty answer.');
      if (!resume) this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
      this.history = this.history.slice(-8);
      if (answer) this.displayResponse(answer);
      this.responseStatus = 'answer';
      if (!this.dialog()) this.status = 'answer';
      this.onChange();
    } catch (error) {
      if (this.active && this.generation === generation) {
        this.responseStatus = 'error'; this.responseError = error;
        if (this.dialog()) this.onChange(); else this.fail(error);
      }
    }
    finally { if (this.abort === abort) { this.abort = null; this.onChange(); } }
  }
  move(direction) {
    if (!this.active) return;
    if (this.review) {
      this.review.page = Math.max(0, Math.min(this.review.page + direction, this.review.pages.length - 1));
      this.resizeConversation(); this.onChange();
    }
    else if (this.dialog()) {
      const last = Math.max(0, transcriptionLines(this.voiceDraft).length - 3);
      const line = Math.max(0, Math.min((this.voiceLine ?? last) + direction * 3, last));
      this.voiceLine = line === last ? null : line;
      this.resizeConversation(); this.onChange();
    }
    else if (this.layout) {
      this.y = this.conversation ? this.conversation.move(this.y, direction) : pageTurnY(this.layout, this.y, direction);
      // Reaching the current end while a reply is still arriving is a reading
      // position, not permission to skip ahead with every subsequent chunk.
      if (this.conversation && this.status === 'thinking' && this.answer) this.conversation.following = false;
      this.viewRevision++; this.onChange();
    }
  }
  dialog() {
    if (!this.active) return null;
    if (this.review) return reviewDialog(this.review, this.phase);
    if (['starting', 'listening', 'transcribing'].includes(this.status)) return liveTranscriptionDialog(this.status, this.voiceDraft, this.voiceProgress, this.phase, this.voiceLine, this.voiceWords);
    return null;
  }
  frame() {
    const label = this.context?.scope === 'terminal-session' ? 'Even Terminal' : this.context?.scope === 'library' ? 'Librarian' : 'Ask';
    const status = this.status;
    const partial = status === 'thinking' && this.answer;
    const dots = '.'.repeat((this.phase || 0) + 1);
    const conversationFrame = this.conversation?.window(this.y);
    const body = this.layout ? (conversationFrame || textWindow(this.layout, this.y)).content
      : status === 'error' ? `Could not ask.\n\n${this.error}\n\nHold to retry, or type on your phone.`
      : `${label === 'Even Terminal' ? this.context.title : label === 'Librarian' ? 'Librarian' : 'Ask about this'}\n\nHold to speak, or type your question on the phone.\n\nTap to return to ${label === 'Even Terminal' ? 'sessions' : label === 'Librarian' ? 'the library' : 'reading'}.`;
    let footer = status === 'starting' ? `Starting microphone${dots}`
      : status === 'listening' ? `Listening${dots}`
      : status === 'transcribing' ? this.voiceProgress || `Transcribing${dots}`
      : status === 'review' ? reviewDialog(this.review, this.phase).status
      : status === 'thinking' ? this.progressText && !/^(Thinking|Writing)/.test(this.progressText) ? this.progressText : `${partial ? 'Writing' : 'Thinking'}${dots} · Tap: back`
      : status === 'error' ? `Error: ${this.error}`
      : 'Hold: speak · Tap: back';
    const dialog = this.dialog();
    return { kind: 'ask', body: this.layout ? body : textWindow(nativeLayout(parseDocument(body)), 0).content,
      status: titleText(`${label} · ${footer}`),
      statusLeft: status === 'thinking' ? titleText(this.progressText || `${partial ? 'Writing' : 'Thinking'}${dots}`, 260) : status === 'error' ? this.errorKind === 'timeout' ? 'Request timed out' : `${label} error` : label,
      statusRight: 'Hold: speak · Tap: back',
      statusCenter: conversationFrame?.page ? `${conversationFrame.page} / ${conversationFrame.pages}` : '',
      ...(conversationFrame ? { alignments: conversationFrame.alignments, readReceipts: conversationFrame.readReceipts } : {}), ...(dialog ? { dialog } : {}) };
  }
}

export { pcmWave, PcmMicrophone as AskMicrophone } from '@pageborne/browser-stt/pcm-microphone';
