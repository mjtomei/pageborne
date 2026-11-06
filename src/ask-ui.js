import { AskSession, AskMicrophone, askContext } from './ask.js';
import { askFetch } from './ask-client.js';
import { connectionMode, checkConnection, checkTranscription, transcribeQuestion, providerAnswer, paperConnectionKey, checkWorkingDirectory } from './ask-connections.js';
import { EvenTerminal } from './ask-terminal.js';
import origins from 'virtual:ask-origins';
import { terminalPairing } from './terminal-pairing.js';
import { readQrImage, QrImageError } from './qr-image.js';
import { AskChat } from './ask-chat.js';
import { chatMessages } from './ask-activity.js';
import { librarianContext } from './librarian.js';
import { terminalSessionKey, terminalSessionContext } from './terminal-sessions.js';
import { paperAttachments } from './ask-documents.js';
import { renderSpeechConfidence, uncertainWords } from './speech-confidence.js';
import { SpeechUI } from './speech-ui.js';
import { formatSpokenFilenames } from '@pageborne/browser-stt';
import { BrowserMicrophone } from './browser-microphone.js';
import { AskKeyboard } from './ask-keyboard.js';
import { AskPhoneReadingView } from './ask-reading-view.js';
import { ChatScrollbar } from './chat-scrollbar.js';
import { MAX_QUESTION_CHARS } from './ask-limits.js';
import { ASK_AGENTS, askScopeKey, askChatKey, defaultAskAgent, retainAskModels, askConfigFor } from './ask-models.js';
import { safeTimeout as setTimeout, cancelTimeout as clearTimeout } from './timers.js';

const $ = id => document.getElementById(id);
export class AskUI {
  constructor({ pdfProcessing = () => false, goToPosition = () => {}, snapshot, pause, changed, presentVoiceOverlay = () => {}, returnToLibrary = () => {}, returnToSessions = () => {}, onLibraryFile = () => {}, readConfig, saveConfig, readModels = () => ({}), saveModels = () => {}, readBindings, saveBindings, readChats, saveChats, reveal, paperIdentity, audioControl, showSettings, captureQrImage, automaticConnection = false, readSpeech, saveSpeech, readVocabulary, saveVocabulary, readContextVocabulary, saveContextVocabulary, diagnostics }) {
    Object.assign(this, { pdfProcessing, goToPosition, snapshot, pause, changed, presentVoiceOverlay, returnToLibrary, returnToSessions, onLibraryFile, readConfig, saveConfig, readModels, saveModels, readBindings, saveBindings, paperIdentity, showSettings, captureQrImage, automaticConnection, diagnostics });
    this.glassesVisible = false; this.phoneVisible = false; this.replyUnread = false;
    this.chat = new AskChat(readChats, saveChats); this.reveal = reveal;
    this.deliveries = new Map();
    this.replyViews = new Map();
    this.modelDrafts = new Map();
    this.bindingVersion = 0; this.linkVersions = new Map();
    this.session = new AskSession(() => { this.render(); changed(); });
    const limit = () => this.release();
    const chunk = bytes => {
      if (bytes.length && this.voiceTiming?.generation === this.generation && this.voiceTiming.audioAt == null) {
        this.voiceTiming.audioAt = performance.now();
        this.diagnostics?.log('voice-startup', { stage: 'first-audio', ms: Math.round(this.voiceTiming.audioAt - this.voiceTiming.started) });
      }
      try { this.stream.receive(bytes); } catch { void this.release(); }
    };
    this.mic = new AskMicrophone(audioControl, limit, chunk);
    this.phoneMic = new BrowserMicrophone(limit, chunk);
    this.speech = new SpeechUI({ read: readSpeech, save: saveSpeech, readVocabulary, saveVocabulary, readContextVocabulary, saveContextVocabulary, vocabularyContext: () => this.vocabularyContext(), changed: () => this.close(), diagnostics });
    this.stream = this.speech.stream({ backlog: () => { void this.release(); },
      result: result => {
        if (!this.session.active || !this.session.review?.completing && !['starting', 'listening'].includes(this.session.status)) return;
        result = formatSpokenFilenames(result, this.dictationFilenames);
        const text = result.text;
        if (text && this.voiceTiming?.generation === this.generation && !this.voiceTiming.firstWord) {
          const now = performance.now(); this.voiceTiming.firstWord = true;
          this.diagnostics?.log('voice-startup', { stage: 'first-word', ms: Math.round(now - this.voiceTiming.started),
            audioMs: this.voiceTiming.audioAt == null ? null : Math.round(now - this.voiceTiming.audioAt),
            readyModels: Object.values(this.speech.models.entries).filter(e => e.state === 'ready').length });
        }
        if (this.session.review?.completing) { this.reviewSpeech(text, result, true); return; }
        this.draftConfidence = { text, words: result.words || [] }; $('ask-question').value = text;
        this.session.updateTranscription(text, result.words || []);
        if (text.length >= MAX_QUESTION_CHARS - 1000) void this.release();
      }, failure: error => { this.speech.failure(error, 'wasm'); void this.release(); } });
    this.keyboard = new AskKeyboard($('ask-panel'), $('ask-question'), () => this.session.active && this.phoneVisible, () => { this.resizeQuestion(); this.scrollChat(); this.changed(); });
    $('ask-question').maxLength = MAX_QUESTION_CHARS;
    $('ask-question').oninput = () => { this.draftConfidence = null; if (this.session.review) { this.cancelSpeechCompletion(); this.session.reviewQuestion($('ask-question').value); } this.resizeQuestion(); };
    $('ask-question').onscroll = () => { $('ask-question-colors').scrollTop = $('ask-question').scrollTop; };
    this.composerResize = new ResizeObserver(() => this.resizeQuestion()); this.composerResize.observe($('ask-question'));
    this.generation = 0;
    $('ask-open').onclick = () => { if (this.open({ showConversation: false })) this.reveal(); };
    $('ask-form').onsubmit = event => { event.preventDefault(); this.submit($('ask-question').value); };
    $('ask-review-cancel').onclick = () => this.cancelReview();
    $('ask-voice').onclick = () => ['starting', 'listening'].includes(this.session.status) ? this.release() : this.hold(this.options().evenHost ? 'glasses' : 'phone');
    $('ask-question').onkeydown = event => {
      this.allowLineBreak = event.shiftKey;
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault(); $('ask-form').requestSubmit();
      }
    };
    $('ask-question').onkeyup = () => { this.allowLineBreak = false; };
    // Some software keyboards emit only beforeinput for their Send action.
    $('ask-question').onbeforeinput = event => {
      if (['insertLineBreak', 'insertParagraph'].includes(event.inputType) && !event.isComposing && !this.allowLineBreak) {
        event.preventDefault(); $('ask-form').requestSubmit();
      }
    };
    const scrolled = () => { const el = $('ask-history'); this.chatFollowing = el.scrollHeight - el.clientHeight - el.scrollTop < 48; $('ask-latest').hidden = this.chatFollowing; };
    $('ask-history').onscroll = scrolled;
    this.chatScrollbar = new ChatScrollbar($('ask-history'), $('ask-scrollbar'), $('ask-messages'), scrolled);
    $('ask-latest').onclick = () => { this.chatFollowing = true; this.scrollChat(); };
    $('ask-config-save').onclick = () => this.save();
    $('ask-chat-model').onchange = () => this.switchModel($('ask-chat-model').value);
    $('ask-default-model').onchange = () => {
      this.retainModels();
      this.saveModels({ ...this.readModels(), defaultAgent: $('ask-default-model').value });
    };
    $('ask-config-clear').onclick = () => { this.cancelPairing(); this.close(); this.bindingVersion++; for (const delivery of this.deliveries.values()) delivery.abort.abort(); this.deliveries.clear(); this.chat.clear(); this.replyViews.clear(); this.modelDrafts.clear(); saveConfig({}); saveBindings({}); this.load(); $('ask-config-status').textContent = 'Connection and local session links forgotten. Desktop conversations are kept.'; };
    $('ask-settings-link').onclick = () => showSettings();
    $('ask-mode').onchange = () => { this.cancelPairing(); this.fields(); };
    $('ask-pairing-use').onclick = () => this.importPairing($('ask-pairing-url').value);
    $('ask-pairing-url').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); this.importPairing(event.target.value); } };
    $('ask-qr-scan').onclick = () => this.chooseQr('camera');
    $('ask-qr-choose').onclick = () => this.chooseQr('album');
    $('ask-qr-cancel').onclick = () => { this.cancelPairing(); $('ask-pairing-status').textContent = 'QR import cancelled.'; };
    for (const id of ['ask-qr-camera', 'ask-qr-file']) {
      $(id).onchange = () => { const file = $(id).files?.[0]; $(id).value = ''; if (file) this.scanQr(() => file); };
      $(id).oncancel = () => { $('ask-pairing-status').textContent = 'QR import cancelled.'; };
    }
    for (const id of ['ask-pairing-url', 'ask-endpoint', 'ask-token']) $(id).oninput = () => { if (this.qrJob) this.cancelPairing(false); };
    $('ask-folders').onchange = () => this.fields();
    $('ask-workspace').onclick = () => this.prepareWorkspace();
    $('ask-sessions-refresh').onclick = () => this.listSessions();
    $('ask-session-use').onclick = () => this.useSession();
    $('ask-session-new').onclick = () => this.newSession();
    $('ask-paper-cwd').onchange = () => this.setPaperDirectory();
    $('ask-paper-cwd').oninput = () => $('ask-paper-cwd').setCustomValidity('');
    $('ask-check-reply').onclick = () => this.checkReply();
    $('ask-footer').onclick = () => { if (this.open({ showConversation: false })) this.reveal(); };
    this.documentVoiceHelp = $('ask-voice-help').textContent;
    this.load(); this.render();
    this.pollTimer = setTimeout(() => this.pollFooter(), 3000);
  }
  get unavailableReason() { return this.pdfProcessing() ? 'Ask is unavailable while the PDF is processing.' : ''; }
  options() { return { evenHost: !!window.flutter_inappwebview?.callHandler, origins, diagnostics: this.diagnostics, onLibraryFile: this.onLibraryFile }; }
  cancelPairing(clearInput = true) {
    this.qrJob?.abort(); this.qrJob = null; this.pairingBusy(false);
    if (clearInput) $('ask-pairing-url').value = '';
    for (const id of ['ask-qr-camera', 'ask-qr-file']) $(id).value = '';
  }
  pairingBusy(busy) {
    for (const id of ['ask-pairing-use', 'ask-qr-scan', 'ask-qr-choose']) $(id).disabled = busy;
    $('ask-qr-cancel').hidden = !busy;
  }
  importPairing(value) {
    try {
      const pairing = terminalPairing(value); this.cancelPairing();
      $('ask-mode').value = 'terminal'; $('ask-endpoint').value = pairing.endpoint;
      // Never carry an old host's token over to a newly imported bare URL.
      $('ask-token').value = pairing.token;
      if (pairing.agent) $('ask-agent').value = pairing.agent;
      this.fields(); $('ask-config-status').textContent = '';
      $('ask-pairing-status').textContent = pairing.token ? 'Connection details imported. Save or test the connection below.' : 'Address imported. Enter its access token, then save or test below.';
      return true;
    } catch (error) { $('ask-pairing-status').textContent = error.message; return false; }
  }
  chooseQr(kind) {
    if (this.options().evenHost) return this.scanQr(() => this.captureQrImage(kind));
    const picker = $(kind === 'camera' ? 'ask-qr-camera' : 'ask-qr-file'); picker.value = ''; picker.click();
  }
  async scanQr(capture) {
    this.cancelPairing(); this.pause(); const job = new AbortController(); this.qrJob = job; this.pairingBusy(true);
    $('ask-pairing-status').textContent = 'Reading QR code…';
    try {
      const source = await capture(); if (this.qrJob !== job) return;
      if (!source) { $('ask-pairing-status').textContent = 'QR import cancelled.'; return; }
      const value = await readQrImage(source, job.signal); if (this.qrJob === job) this.importPairing(value);
    } catch (error) {
      // Native camera failures can contain paths or image data. Keep those
      // out of diagnostics and only show our own bounded decoding messages.
      if (this.qrJob === job) $('ask-pairing-status').textContent = error instanceof QrImageError
        ? error.message : 'Could not read the camera or image. Check camera access, choose a QR screenshot, or paste the URL.';
    } finally { if (this.qrJob === job) { this.qrJob = null; this.pairingBusy(false); } }
  }
  load() {
    this.speech.load();
    this.loadModels();
    $('ask-connection-settings').hidden = $('ask-settings-link').hidden = $('ask-paper-directory-settings').hidden = this.automaticConnection;
    // The private build supplies the connection in memory. Do not copy its
    // token into hidden form fields or persist it as a phone preference.
    if (this.automaticConnection) return;
    const c = this.readConfig(); $('ask-mode').value = connectionMode(c); $('ask-legacy-option').hidden = connectionMode(c) !== 'bridge';
    for (const [id, value] of Object.entries({ 'ask-endpoint': c.endpoint, 'ask-token': c.token, 'ask-provider-url': c.baseUrl, 'ask-model': c.model, 'ask-api-key': c.apiKey,
      'ask-protocol': c.provider || 'openai-compatible', 'ask-agent': c.agent || 'claude', 'ask-cwd': c.cwd, 'ask-base-dir': c.baseDir, 'ask-speech-url': c.transcription?.baseUrl, 'ask-speech-model': c.transcription?.model, 'ask-speech-key': c.transcription?.apiKey })) $(id).value = value || '';
    $('ask-folders').checked = c.paperDirectories === true;
    this.fields();
  }
  fields() {
    const mode = $('ask-mode').value; $('ask-provider-fields').hidden = mode !== 'provider'; $('ask-desktop-fields').hidden = mode === 'provider';
    $('ask-folder-options').hidden = !$('ask-folders').checked;
    $('ask-cwd').closest('label').hidden = $('ask-folders').checked;
    $('ask-terminal-options').hidden = mode !== 'terminal'; $('ask-speech-fields').hidden = mode === 'bridge';
    $('ask-pairing-import').hidden = mode !== 'terminal';
  }
  save() {
    try {
      const config = checkConnection({ mode: $('ask-mode').value, endpoint: $('ask-endpoint').value, token: $('ask-token').value,
        baseUrl: $('ask-provider-url').value, model: $('ask-model').value, apiKey: $('ask-api-key').value, provider: $('ask-protocol').value,
        agent: $('ask-agent').value, cwd: $('ask-cwd').value, paperDirectories: $('ask-folders').checked, baseDir: $('ask-base-dir').value,
        transcription: { baseUrl: $('ask-speech-url').value.trim(), model: $('ask-speech-model').value.trim(), apiKey: $('ask-speech-key').value.trim() } }, this.options());
      if (config.transcription.baseUrl || config.transcription.model) checkTranscription(config, this.options());
      this.close(); this.saveConfig(config); this.loadModels(); $('ask-config-status').textContent = 'Saved for all documents on this device.'; return true;
    } catch (error) { $('ask-config-status').textContent = error.message; return false; }
  }
  retainModels() {
    const previous = this.readModels(), next = retainAskModels(this.readConfig(), previous, this.readBindings(), this.chat.read());
    if (next !== previous) this.saveModels(next);
  }
  loadModels() {
    this.retainModels();
    const config = this.readConfig();
    $('ask-model-settings').hidden = connectionMode(config) !== 'terminal';
    $('ask-default-model').value = defaultAskAgent(config, this.readModels());
    for (const id of ['ask-default-model', 'ask-chat-model']) $(id).querySelector('[value="claude"]').textContent = this.automaticConnection ? 'Claude Fable 5.1' : 'Claude';
  }
  configFor(paperId) { return askConfigFor(this.readConfig(), this.readModels(), paperId); }
  currentConfig() { return this.session.active ? this.config : this.configFor(this.snapshot().paperId); }
  selectModel(agent, paperId) {
    this.saveModels({ ...this.readModels(), selections: { ...this.readModels().selections, [askScopeKey(paperId)]: agent } });
  }
  switchModel(agent) {
    if (!this.session.active || this.terminalSession || connectionMode(this.config) !== 'terminal' || !ASK_AGENTS.includes(agent) || this.config.agent === agent) return;
    // Finish reviewing a recording before switching. In-flight desktop
    // deliveries, however, keep running under their original model's key.
    if (this.session.dialog()) { this.render(); return; }
    const scope = this.librarian ? 'library' : 'document', paperId = this.paperId;
    const showConversation = this.glassesVisible;
    this.close(); this.selectModel(agent, paperId);
    this.watcher?.abort.abort(); this.watcher = null;
    this.footerConnection = null;
    this.open({ scope, showConversation });
    this.reveal();
  }
  get terminalSession() { return this.session.context?.scope === 'terminal-session'; }
  openTerminalSession(session) {
    if (this.unavailableReason || this.speech.setup.blocked || connectionMode(this.readConfig()) !== 'terminal') return false;
    if (!session?.id || !ASK_AGENTS.includes(session.provider)) return false;
    this.close();
    const opened = this.open({ scope: 'terminal-session', desktopSession: session });
    if (opened) this.reveal();
    return opened;
  }
  get librarian() { return this.session.context?.scope === 'library'; }
  openLibrarian() {
    if (this.unavailableReason || this.speech.setup.blocked) return false;
    if (!this.librarian) this.close();
    const opened = this.open({ scope: 'library' });
    if (opened) this.reveal();
    return opened;
  }
  open({ showConversation = true, dictation = false, scope = 'document', desktopSession } = {}) {
    if (this.unavailableReason || this.speech.setup.blocked) return false;
    const revealUnread = showConversation && !this.glassesVisible;
    this.phoneVisible = true;
    if (showConversation) { this.glassesVisible = true; this.replyUnread = false; }
    if (this.session.active) {
      if (revealUnread) this.session.syncConversation(this.chat.turns(this.paperKey), 'unread');
      if (showConversation) { this.pause(); this.acknowledgeReply(); } this.render(); this.changed(); void this.pollFooter(); return true;
    }
    const { layout, y, title, wordFrame, paperId } = this.snapshot();
    const terminalSession = scope === 'terminal-session';
    if (terminalSession && !desktopSession?.id) { this.glassesVisible = this.phoneVisible = false; return false; }
    if (!layout && scope === 'document') { this.glassesVisible = this.phoneVisible = false; return false; }
    this.replyUnread = false;
    this.retainModels(); this.paperId = scope === 'library' || terminalSession ? null : paperId;
    this.config = structuredClone(terminalSession ? { ...this.readConfig(), agent: desktopSession.provider } : this.configFor(this.paperId));
    if (!terminalSession && connectionMode(this.config) === 'terminal' && this.readModels().selections?.[askScopeKey(this.paperId)] !== this.config.agent) this.selectModel(this.config.agent, this.paperId);
    this.paperKey = terminalSession ? terminalSessionKey(this.config, desktopSession.id) : askChatKey(this.config, this.paperId);
    if (terminalSession) {
      this.desktopSession = desktopSession;
      this.saveBinding(this.paperKey, { ...this.binding(), sessionId: desktopSession.id, sessionTitle: desktopSession.title });
    }
    this.turnId = this.chat.reconcile(this.paperKey, this.binding()) || this.chat.turns(this.paperKey).at(-1)?.id;
    this.chatFollowing = true; this.renderedChatKey = null;
    // Holding needs only the nearby passage. submit() gathers the fixed 100k-token
    // context at the current position; don't build/render 100k tokens to record.
    const context = terminalSession ? terminalSessionContext(desktopSession) : scope === 'library' ? librarianContext() : askContext(layout, y, title, wordFrame, dictation ? 1000 : undefined);
    if (this.binding().documentFiles) context.files = this.binding().documentFiles;
    if (showConversation) this.pause();
    this.session.open(context, this.chat.history(this.paperKey), this.chat.turns(this.paperKey));
    $('ask-session-choice').replaceChildren(new Option('Choose a session after refreshing', ''));
    if (this.deliveries.has(this.paperKey)) {
      const key = this.paperKey, generation = this.generation, delivery = this.deliveries.get(key);
      this.turnId = delivery.turnId;
      this.session.setStatus('thinking'); this.session.progress(delivery.status || 'Sending message…');
      // Reopening during multiple POSTs waits for the latest acknowledgement;
      // watching an older marker here could later overwrite the new binding.
      delivery.submission.finally(() => {
        if (this.session.active && this.paperKey === key && this.generation === generation && this.turnId === delivery.turnId && this.binding().pending) void this.checkReply();
      }).catch(() => {});
    } else if (this.binding().pending) {
      this.session.setStatus('thinking');
      const view = this.replyViews.get(this.paperKey);
      if (view?.marker === this.binding().pending.marker) this.session.restoreView(view);
      if (this.binding().sessionId) this.checkReply();
      else if (this.binding().notification === 'error') this.session.fail(new Error('Submission could not be confirmed. Check the desktop session before asking again.'));
    } else if (this.chat.turns(this.paperKey).at(-1)?.state === 'error') {
      this.turnId = this.chat.turns(this.paperKey).at(-1).id;
      this.session.fail(new Error('The last question did not finish. Check the connection or desktop session, then try again.'));
    } else if (!this.readCachedReply()) {
      const last = this.chat.turns(this.paperKey).at(-1);
      if (last?.state === 'complete') { this.session.savedReply = true; this.session.showAnswer(last.answer); }
    }
    const view = this.replyViews.get(this.paperKey);
    if (view?.turnId === this.turnId && this.session.status === 'answer' && view.answer === this.session.answer) this.session.restoreView(view);
    if (revealUnread) { this.session.syncConversation(this.chat.turns(this.paperKey), 'unread'); this.changed(); }
    $('ask-question').value = this.modelDrafts.get(this.paperKey) || ''; this.resizeQuestion(); void this.pollFooter(); return true;
  }
  readingContext() {
    const binding = this.binding();
    return { kind: 'ask', scope: this.config.chatScope || '',
      document: { id: this.paperId ? this.snapshot().document?.id || 'document' : this.terminalSession ? 'terminal-session' : 'librarian',
        key: this.paperKey, title: String(this.session.context?.title || 'Ask').slice(0, 300),
        revision: binding.sessionId || 'local' },
      sessions: binding.sessionId && ['claude', 'codex'].includes(this.config.agent)
        ? [{ agent: this.config.agent, id: binding.sessionId, ...(binding.cwd ? { cwd: binding.cwd } : {}) }] : [] };
  }
  phoneReadingView() {
    if (!this.phoneVisible || !this.session.active || document.hidden || this.session.dialog()
      || $('ask-panel').hidden || $('ask-question') === document.activeElement) return null;
    const view = (this.readingPhone ||= new AskPhoneReadingView()).sample($('ask-history'), this.renderedChat);
    return view && { ...this.readingContext(), ...view, surface: 'phone' };
  }
  frame() { return { ...this.session.frame(), paperKey: this.paperKey, readingContext: this.readingContext() }; }
  acceptFrame(frame) {
    const message = frame.message;
    if (!this.glassesVisible || frame.modePicker || message?.kind !== 'ask' || message.paperKey !== this.paperKey) return;
    if (this.session.conversation?.markRead(this.chat.turns(this.paperKey), message.readReceipts)) {
      // Checkpoint at a bounded rate, not for every streamed text update.
      (this.readKeys ||= new Set()).add(this.paperKey);
      if (!this.readTimer) this.readTimer = setTimeout(() => {
        this.readTimer = null;
        for (const key of this.readKeys) if (this.chat.cache.has(key)) this.chat.persist(key);
        this.readKeys.clear();
      }, 800);
    }
  }
  vocabularyContext() {
    if (this.terminalSession) return { context: this.session.context, history: this.chat.vocabularyHistory(this.paperKey) };
    if (this.librarian) return { context: librarianContext(), history: this.chat.vocabularyHistory(this.paperKey) };
    const { layout, y, title, wordFrame, paperId } = this.snapshot();
    if (!layout) return {};
    const key = this.session.active && this.paperId === paperId ? this.paperKey : paperConnectionKey(this.configFor(paperId), paperId);
    return { context: askContext(layout, y, title, wordFrame, 1000), history: this.chat.vocabularyHistory(key) };
  }
  async hold(source = this.options().evenHost ? 'glasses' : 'phone') {
    if (!this.unavailableReason && !this.speech.setup.blocked && this.speech.setup.suspended && this.speech.backend !== 'remote') {
      void this.speech.retrySetup(); return;
    }
    const started = performance.now();
    if (this.session.active && ['starting', 'listening', 'transcribing'].includes(this.session.status)) return;
    const previousVisibility = { phoneVisible: this.phoneVisible, glassesVisible: this.glassesVisible };
    if (!this.open({ showConversation: false, dictation: true }) || ['starting', 'listening', 'transcribing'].includes(this.session.status)) return;
    this.pause();
    const previous = { ...previousVisibility, question: $('ask-question').value, confidence: this.draftConfidence,
      status: this.session.status, error: this.session.error, errorKind: this.session.errorKind,
      review: this.session.review ? { ...this.session.review, completing: false, refining: false } : null };
    if (this.session.review) this.cancelReview();
    this.dictationReturn = previous;
    const generation = ++this.generation;
    this.voiceTiming = { generation, started };
    try {
      checkConnection(this.config, this.options());
      if (this.speech.backend === 'remote') checkTranscription(this.config, this.options());
      this.session.voiceDraft = ''; this.draftConfidence = null; $('ask-question').value = '';
      this.dictationVocabulary = [];
      this.dictationFilenames = [];
      if (this.speech.backend !== 'remote') this.stream.start(this.dictationVocabulary, { filenames: this.dictationFilenames });
      this.activeMic = source === 'phone' ? this.phoneMic : this.mic;
      this.captureRequested = false;
      this.session.setStatus('starting');
      // Submit the popup now, ahead of audioControl on the shared native lane.
      // No animation-timer delay, model download, or vocabulary ranking first.
      const presented = this.presentVoiceOverlay();
      this.diagnostics?.log('voice-startup', { stage: 'popup-submitted', ms: Math.round(performance.now() - started) });
      setTimeout(() => {
        if (generation !== this.generation) return;
        try {
          this.speech.open();
          const { context, history } = this.vocabularyContext();
          this.dictationFilenames.push(...this.speech.filenames(context, history));
          const terms = this.speech.vocabulary(context, history);
          // Keep the stream's shared vocabulary array: audio may already be arriving.
          this.dictationVocabulary.push(...terms);
        } catch (error) { this.speech.failure(error); }
      }, 0);
      // Phone microphone permissions must be requested in the user gesture.
      // Glasses capture waits only for queued display work, never model loading.
      if (source !== 'phone') await presented;
      if (this.activeMic.stopping) await this.activeMic.stopping;
      if (generation !== this.generation) return;
      this.captureRequested = true;
      await this.activeMic.start({ retainAudio: this.speech.backend === 'remote' });
      if (generation !== this.generation) return;
      this.diagnostics?.log('voice-startup', { stage: 'microphone-ready', ms: Math.round(performance.now() - started) });
      this.session.setStatus('listening');
      if (this.speech.backend === 'remote') this.recordingTimer = setTimeout(() => this.release(), 60000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.stream.cancel(); this.activeMic?.stop().catch(() => {}); this.session.fail(error);
    }
  }
  async release() {
    if (!this.session.active || !['starting', 'listening'].includes(this.session.status)) return;
    const generation = ++this.generation; clearTimeout(this.recordingTimer);
    const backend = this.speech.backend;
    const draft = backend !== 'remote' ? this.session.voiceDraft.trim() : '';
    this.session.voiceProgress = ''; this.transcription = new AbortController();
    this.reviewSpeech(draft, this.draftConfidence, true);
    try {
      if (!this.captureRequested) { this.emptyDictation(); return; }
      const audio = await this.activeMic.stop();
      if (generation !== this.generation) return;
      if ((audio.kind === 'pcm-stream' ? audio.bytes : audio.size - 44) < 3200) { this.emptyDictation(); return; }
      const rawResponse = backend === 'remote'
        ? await transcribeQuestion(this.config, audio, this.transcription.signal, this.options())
        : await this.stream.finish(audio, { signal: this.transcription.signal });
      if (generation !== this.generation) return;
      const response = formatSpokenFilenames(rawResponse, this.dictationFilenames);
      if (backend !== 'remote') this.speech.result(response);
      const question = String(response.text || '').trim();
      if (!question) { this.emptyDictation(); return; }
      this.reviewSpeech(question, response);
    } catch (error) {
      if (generation !== this.generation) return;
      if (!this.session.review?.text && /^No speech was (recorded|recognized)\b/i.test(error.message)) { this.emptyDictation(); return; }
      this.stream.cancel();
      if (backend !== 'remote') this.speech.failure(error, backend);
      if (this.session.review?.text) {
        this.session.review.completing = false; this.session.review.note = ''; this.render(); this.changed();
      } else { this.session.review = null; this.session.fail(error); }
    }
  }
  emptyDictation() {
    const previous = this.dictationReturn; this.dictationReturn = null;
    this.cancelDictation();
    if (previous) {
      this.phoneVisible = previous.phoneVisible; this.glassesVisible = previous.glassesVisible;
      $('ask-question').value = previous.question; this.draftConfidence = previous.confidence;
      this.session.review = previous.review; this.session.setStatus(previous.status); this.session.error = previous.error; this.session.errorKind = previous.errorKind;
      if (previous.status === 'thinking') this.session.restoreResponse();
    }
    this.resizeQuestion(); this.render(); this.changed();
  }
  reviewSpeech(text, result, completing = false) {
    this.draftConfidence = { text, words: result?.words || [] };
    $('ask-question').value = text; this.session.reviewQuestion(text, result?.words || []);
    this.session.review.completing = completing; this.render(); this.changed();
  }
  cancelSpeechCompletion() { this.generation++; this.transcription?.abort(); this.stream.cancel(); }
  cancelReview() { this.draftConfidence = null; this.cancelSpeechCompletion(); $('ask-question').value = ''; this.session.cancelReview(); this.resizeQuestion(); }
  chooseReview() {
    if (this.session.review) this.submit(this.session.review.text);
  }
  async acceptDictation() {
    if (this.session.review) { this.chooseReview(); return; }
    if (!['starting', 'listening'].includes(this.session.status)) return;
    const generation = this.generation + 1;
    await this.release();
    // Cancel/edit/new recording during the final flush revokes this acceptance.
    if (this.generation === generation && this.session.review) this.chooseReview();
  }
  async submit(question) {
    if (!this.open({ showConversation: false }) || ['starting', 'listening', 'transcribing'].includes(this.session.status)) return;
    const desktop = connectionMode(this.config) === 'terminal';
    if (this.session.abort && !desktop) return;
    question = String(question || '').trim(); if (!question) return;
    if (question.length > MAX_QUESTION_CHARS) { this.session.fail(new Error('This message is too long. Shorten it on the phone before sending.')); return; }
    if (this.librarian && connectionMode(this.config) !== 'terminal') { this.session.fail(new Error('Librarian needs an Even Terminal connection with library support. Set it up in Connection settings.')); return; }
    if (connectionMode(this.config) === 'terminal' && !this.setPaperDirectory()) return;
    const current = this.snapshot();
    const librarian = this.librarian, terminalSession = this.terminalSession;
    this.session.context = terminalSession ? terminalSessionContext(this.desktopSession) : librarian ? librarianContext() : askContext(current.layout, current.y, current.title, current.wordFrame);
    this.session.context.platform = current.platform || 'glasses';
    this.cancelSpeechCompletion();
    const turnId = this.turnId = this.chat.begin(this.paperKey, question, this.session.context);
    // Sending and reply completion do not navigate. Follow-ups from Ask
    // keep the conversation visible throughout.
    this.dictationReturn = null;
    this.replyUnread = false;
    this.chatFollowing = true; $('ask-question').value = ''; this.modelDrafts.delete(this.paperKey);
    const key = this.paperKey; const config = this.config; const save = this.bindingWriter(key);
    this.session.history = this.chat.history(key);
    await this.session.send(question, async (body, signal, progress) => {
      const mode = connectionMode(config);
      if (mode === 'bridge') return askFetch(config, 'ask', { ...this.options(), body, signal });
      if (mode === 'provider') return providerAnswer(config, body, signal, this.options());
      // Leaving Ask keeps the authorized upload/submission alive. Only reply
      // polling follows the view's abort signal. Forgetting a paper/connection
      // cancels any still-unsent delivery, and its binding writer rejects late results.
      // Serialize only uploads/session creation/POST acknowledgement. A second
      // message can then enter the same native session while its reply runs.
      // All unsent messages in this lane share cancellation when it is forgotten.
      const previous = this.deliveries.get(key);
      const delivery = { abort: previous?.abort || new AbortController(), turnId }; this.deliveries.set(key, delivery);
      const client = this.replyClient(key, config, signal);
      const update = (text, answer) => {
        delivery.status = text; progress(text, answer);
        if (this.session.active && this.paperKey === key && this.turnId === turnId && !this.session.abort) this.session.progress(text, answer);
      };
      delivery.submission = (previous?.submission || Promise.resolve()).catch(() => {}).then(() => {
        if (delivery.abort.signal.aborted) throw new Error('Question cancelled.');
        return client.submit({ ...body, turnId, ...(librarian || terminalSession ? {} : { paper: () => paperAttachments(current), paperId: this.paperIdentity(current.paperId) }) }, this.readBindings()[key], save, delivery.abort.signal, update);
      });
      try {
        const binding = await delivery.submission;
        return await client.reply(binding, save, signal, update);
      } catch (error) {
        if (!delivery.abort.signal.aborted && !signal.aborted && this.readBindings()[key]?.pending?.turnId !== turnId) {
          this.chat.update(key, turnId, '', 'error'); save({ ...this.readBindings()[key], notification: 'error' });
        }
        if (this.deliveries.get(key) === delivery && this.session.active && this.paperKey === key && !this.session.abort && !this.binding().pending) this.session.fail(error);
        throw error;
      } finally { if (this.deliveries.get(key) === delivery) this.deliveries.delete(key); this.renderFooter(); }
    }, { replace: desktop });
    if (this.session.active && this.paperKey === key && this.session.status === 'answer' && this.glassesVisible) this.acknowledgeReply();
  }
  binding() { return this.readBindings()[this.paperKey] || {}; }
  replyClient(key, config, signal) {
    const version = this.bindingVersion, linkVersion = this.linkVersions.get(key);
    return new EvenTerminal(config, { ...this.options(), onConversation: conversation => {
      if (signal.aborted || version !== this.bindingVersion || linkVersion !== this.linkVersions.get(key) || this.readBindings()[key]?.sessionId !== conversation.sessionId) return;
      this.chat.mergeConversation(key, conversation.sessionId, conversation.turns);
      if (this.session.active && this.paperKey === key) { this.session.history = this.chat.history(key); this.render(); this.changed(); }
    } });
  }
  bindingWriter(key) {
    const version = this.bindingVersion; const linkVersion = this.linkVersions.get(key);
    return binding => { if (version === this.bindingVersion && linkVersion === this.linkVersions.get(key)) this.saveBinding(key, binding); };
  }
  forgetPaper(paperId) {
    if (this.paperId === paperId && this.session.active) this.close();
    for (const key of new Set([...Object.keys(this.readBindings()), ...Object.keys(this.chat.read()), ...this.chat.cache.keys(), ...(this.paperKey ? [this.paperKey] : [])])) {
      try { if (JSON.parse(key)[0] !== paperId) continue; } catch { continue; }
      this.deliveries.get(key)?.abort.abort(); this.deliveries.delete(key);
      this.linkVersions.set(key, (this.linkVersions.get(key) || 0) + 1); this.saveBinding(key, null); this.chat.forget(key);
      this.replyViews.delete(key);
      this.modelDrafts.delete(key);
    }
    const choices = this.readModels(), selections = { ...choices.selections }; delete selections[askScopeKey(paperId)];
    this.saveModels({ ...choices, selections });
  }
  saveBinding(key, value) {
    this.chat.reconcile(key, value);
    if (this.session.active && this.paperKey === key && value?.pending?.turnId === this.turnId) this.session.context.files = value.documentFiles;
    const bindings = { ...this.readBindings() }; if (value) bindings[key] = value; else delete bindings[key];
    this.saveBindings(bindings); if (this.paperKey === key) this.render(); this.changed(); this.renderFooter();
    // The user can leave and return before POST /prompt acknowledges its ID.
    // Resume watching only after that ID arrives; never submit a second prompt.
    if (value?.pending && !this.deliveries.has(key) && this.session.active && this.paperKey === key && this.session.status === 'thinking' && !this.session.abort) {
      if (value.sessionId) queueMicrotask(() => { if (this.session.active && this.paperKey === key && this.binding()?.pending) this.checkReply(); });
      else if (value.notification === 'error') this.session.fail(new Error('Submission could not be confirmed. Check the desktop session before asking again.'));
    }
  }
  currentPaperKey() { if (this.session.active && (this.librarian || this.terminalSession || this.paperId === this.snapshot().paperId)) return this.paperKey; const id = this.snapshot().paperId; return id && connectionMode(this.readConfig()) === 'terminal' ? paperConnectionKey(this.configFor(id), id) : null; }
  footerStatus() {
    if (this.unavailableReason) return 'PDF processing';
    const key = this.currentPaperKey(); const binding = this.readBindings()[key];
    if (this.session.active && (this.librarian || this.terminalSession || this.paperId === this.snapshot().paperId)) {
      if (this.session.status === 'thinking') return this.session.progressText === 'Reconnecting…' ? 'Reconnecting…' : this.session.answer ? 'Reply in progress' : 'Thinking…';
      if (this.session.status === 'error' && (!binding?.pending || binding.notification === 'error')) return 'Ask failed';
      if (this.replyUnread && !binding?.pending) return 'Unread reply';
    }
    if (this.deliveries.has(key) && !binding?.pending) return 'Sharing paper…';
    if (!binding) return '';
    if (binding.reply?.unread) return 'Unread reply';
    if (binding.notification === 'error') return 'Ask failed';
    if (binding.notification === 'connection-error') return 'Connection error';
    if (binding.notification === 'waiting') return 'Needs a response';
    const connection = this.footerConnection;
    // Do not resurrect a persisted outage before checking this connection in
    // the current run. Brief background failures are not failed questions.
    if (connection?.key === key && connection.sessionId === binding.sessionId) {
      if (connection.failures >= 3) return 'Connection lost';
      if (connection.failures && binding.pending) return 'Reconnecting…';
    }
    if (binding.pending && this.session.active && this.paperKey === key && this.session.status === 'error') return 'Reply pending';
    if (binding.pending || binding.notification === 'pending') return 'Thinking…';
    return 'No new replies';
  }
  renderFooter() {
    const reason = this.unavailableReason;
    $('ask-open').disabled = !!reason || !this.snapshot().layout;
    for (const id of ['ask-open', 'ask-footer']) $(id).title = reason;
    $('ask-footer').disabled = !!reason;
    const status = this.footerStatus(); $('ask-footer').hidden = !status || !$('ask-panel').hidden;
    const text = `${this.terminalSession ? 'Even Terminal' : this.librarian ? 'Librarian' : 'Ask'} · ${status}`; if ($('ask-footer').textContent !== text) $('ask-footer').textContent = text;
    $('ask-footer').dataset.ready = String(status === 'Unread reply');
    $('ask-footer').dataset.busy = String(['PDF processing', 'Thinking…', 'Reply in progress', 'Sharing paper…', 'Reply pending', 'Reconnecting…'].includes(status));
    const state = $('ask-footer').dataset.busy === 'true' ? 'busy' : status === 'Unread reply' ? 'unread'
      : ['Ask failed', 'Connection error', 'Connection lost', 'Needs a response'].includes(status) ? 'attention' : 'idle';
    $('ask-state').dataset.state = state;
    $('ask-state').setAttribute('aria-label', status || 'No new replies');
    $('ask-state').textContent = state === 'idle' ? '' : status;
  }
  async pollFooter() {
    if (this.polling) return;
    this.polling = true; clearTimeout(this.pollTimer); this.pollTimer = null;
    let key, binding;
    try {
      if (this.speech.setup.blocked || document.visibilityState === 'hidden') return;
      key = this.currentPaperKey(); binding = this.readBindings()[key];
      this.watchSession(key, binding);
      if (!binding?.sessionId || this.session.active && (this.session.abort || this.session.status === 'thinking')) return;
      if (this.footerConnection?.key !== key || this.footerConnection.sessionId !== binding.sessionId) this.footerConnection = { key, sessionId: binding.sessionId, failures: 0 };
      const config = this.currentConfig(), identity = JSON.stringify(config);
      if (this.pollClient?.identity !== identity) this.pollClient = { identity, client: new EvenTerminal(config, this.options()) };
      const client = this.pollClient.client;
      // Shared history continues syncing while replies are unread. The event
      // cursor still correlates an outstanding local submission separately.
      if (!binding.pending) {
        const conversation = await client.conversation(binding);
        if (this.currentPaperKey() !== key || this.readBindings()[key] !== binding) return;
        if (conversation) {
          this.footerConnection = { key, sessionId: binding.sessionId, failures: 0 };
          const baseline = binding.conversationSyncVersion !== 2;
          const cachedId = this.chat.reconcile(key, binding);
          const merged = this.chat.mergeConversation(key, binding.sessionId, conversation.turns, { baseline });
          const last = conversation.turns.at(-1);
          const notification = /awaiting|permission|question/.test(conversation.state) ? 'waiting'
            : conversation.state === 'busy' ? 'pending' : last?.state === 'error' ? 'error'
              : binding.notification === 'error' && !merged.reply ? 'error' : 'idle';
          const quietReply = merged.historicalIds.includes(cachedId);
          const reply = merged.reply ? { answer: merged.reply.answer, question: merged.reply.question, turnId: merged.reply.id, unread: true }
            : quietReply && binding.reply ? { ...binding.reply, unread: false } : binding.reply;
          if (baseline || merged.reply || quietReply || notification !== binding.notification) this.saveBinding(key, { ...binding, conversationSyncVersion: 2, notification, reply });
          if (this.session.active && this.paperKey === key) {
            if (quietReply && !merged.reply) this.replyUnread = false;
            this.session.history = this.chat.history(key);
            if (merged.reply && ['ready', 'answer', 'error'].includes(this.session.status)) {
              this.turnId = merged.reply.id;
              this.session.savedReply = false;
              this.session.displayResponse(merged.reply.answer); this.session.setStatus('answer');
            } else if (merged.changed) this.render();
          }
          return;
        }
      }
      if (binding.reply?.unread) return;
      const state = await client.peek(binding);
      if (this.currentPaperKey() !== key || this.readBindings()[key] !== binding) return;
      if (state.conversation) this.chat.mergeConversation(key, binding.sessionId, state.conversation.turns);
      this.footerConnection = { key, sessionId: binding.sessionId, failures: 0 };
      if (state.kind === 'ready') {
        this.saveBinding(key, { ...binding, pending: undefined, notification: undefined, idleCandidate: undefined, seenEventId: state.seenEventId, reply: { answer: state.answer, unread: true, turnId: binding.pending?.turnId || binding.pending?.marker, question: binding.pending?.question } });
        // A reply recovered after a dropped request also clears the live error.
        // Preserve the chosen view and use accepted frames for read receipts.
        if (this.session.active && this.paperKey === key && this.session.status === 'error') {
          this.turnId = this.chat.reconcile(key, this.binding());
          this.session.displayResponse(state.answer); this.session.setStatus('answer');
        }
      } else if (!(state.kind === 'idle' && binding.notification === 'error') &&
        (binding.notification !== state.kind || JSON.stringify(binding.idleCandidate) !== JSON.stringify(state.idleCandidate))) {
        this.saveBinding(key, { ...binding, notification: state.kind, idleCandidate: state.idleCandidate });
      }
    } catch (error) {
      if (document.visibilityState === 'hidden' || error.name === 'AbortError' || error.connectionFailure === 'cancelled') return;
      if (binding && this.currentPaperKey() === key && this.readBindings()[key] === binding && !binding.reply?.unread) {
        const transient = ['network', 'timeout'].includes(error.connectionFailure) || error.status === 429 || error.status >= 500;
        if (transient) this.footerConnection.failures++;
        // Keep an actual failed turn or permission request visible while offline.
        if (!['error', 'waiting'].includes(binding.notification)) {
          const notification = transient ? this.footerConnection.failures >= 3 ? 'offline' : binding.notification : 'connection-error';
          if (notification !== binding.notification) this.saveBinding(key, { ...binding, notification });
        }
      }
    } finally { this.polling = false; this.renderFooter(); this.changed(); this.pollTimer = setTimeout(() => this.pollFooter(), 4000); }
  }
  watchSession(key, binding) {
    const identity = binding?.sessionId ? `${key}:${binding.sessionId}` : '';
    if (this.watcher?.identity === identity) return;
    this.watcher?.abort.abort(); this.watcher = null;
    if (!identity) return;
    const watcher = { identity, abort: new AbortController() }; this.watcher = watcher;
    new EvenTerminal(this.currentConfig(), this.options()).watch(binding.sessionId, watcher.abort.signal).catch(() => {}).finally(() => { if (this.watcher === watcher) this.watcher = null; });
  }
  readCachedReply() {
    const binding = this.binding(); if (!binding.reply || binding.pending && !binding.reply.unread) return false;
    this.turnId = this.chat.reconcile(this.paperKey, binding);
    this.session.savedReply = true; this.session.showAnswer(binding.reply.answer);
    const view = this.replyViews.get(this.paperKey); if (view?.turnId === this.turnId && view.answer === binding.reply.answer) this.session.restoreView(view);
    this.acknowledgeReply(); this.changed(); return true;
  }
  acknowledgeReply() {
    const binding = this.binding();
    if (this.glassesVisible && binding.reply?.unread && !binding.pending && binding.reply.answer === this.session.answer) this.saveBinding(this.paperKey, { ...binding, reply: { ...binding.reply, unread: false } });
  }
  goToLatest() {
    if (!this.session.active || !this.glassesVisible || this.session.dialog()) return;
    // Explicitly dismiss older unread replies without claiming their frames
    // were displayed. New replies still receive normal read receipts.
    for (const turn of this.chat.turns(this.paperKey)) if (turn.state === 'complete') turn.unreadDismissed = true;
    this.chat.persist(this.paperKey);
    this.session.syncConversation(this.chat.turns(this.paperKey), 'latest'); this.session.viewRevision++;
    this.replyUnread = false; this.chatFollowing = true;
    const binding = this.binding();
    if (binding.reply?.unread) this.saveBinding(this.paperKey, { ...binding, reply: { ...binding.reply, unread: false } });
    this.render(); this.scrollChat(); this.changed();
  }
  async listSessions() {
    if (this.terminalSession) return;
    const key = this.paperKey; const generation = this.generation; $('ask-sessions-refresh').disabled = true;
    try {
      const sessions = await new EvenTerminal(this.config, this.options()).sessions();
      if (!this.session.active || key !== this.paperKey || generation !== this.generation) return;
      $('ask-session-choice').replaceChildren(new Option(sessions.length ? 'Choose a session' : 'No sessions found', ''), ...sessions.map(s => new Option(`${String(s.title || s.summary || s.firstPrompt || s.id).slice(0, 90)}${s.status ? ` · ${s.status}` : ''}`, s.id)));
    } catch (error) { if (this.session.active && key === this.paperKey && generation === this.generation) $('ask-session-label').textContent = error.message; }
    finally { $('ask-sessions-refresh').disabled = false; }
  }
  useSession() {
    if (this.librarian || this.terminalSession) return;
    if (this.session.abort || this.deliveries.has(this.paperKey) || this.session.dialog() || this.session.status === 'thinking') return;
    const id = $('ask-session-choice').value; if (!id) { $('ask-session-label').textContent = 'Choose a desktop session first.'; return; }
    const sameConnection = key => { try { const [, mode, endpoint, agent, , scope] = JSON.parse(key); return scope !== 'terminal-session' && mode === 'terminal' && endpoint === (this.config.chatScope || this.config.endpoint) && agent === this.config.agent; } catch { return false; } };
    if (Object.entries(this.readBindings()).some(([key, b]) => key !== this.paperKey && sameConnection(key) && b.sessionId === id)) { $('ask-session-label').textContent = 'That session is linked to another paper. Choose a separate session.'; return; }
    this.linkVersions.set(this.paperKey, (this.linkVersions.get(this.paperKey) || 0) + 1);
    // Native desktop sessions may be started manually after Prepare folder.
    // Retain that folder for files without overriding the linked session's cwd.
    const binding = this.binding();
    const fileWorkspace = !binding.sessionId && binding.managedWorkspace && binding.cwd && binding.workspaceId
      ? { cwd: binding.cwd, workspaceId: binding.workspaceId } : undefined;
    this.resetChat(); this.saveBinding(this.paperKey, { sessionId: id, ...(fileWorkspace ? { fileWorkspace } : {}) }); this.session.setStatus('ready');
    void this.pollFooter();
  }
  newSession() {
    if (this.terminalSession) return;
    if (this.session.abort || this.deliveries.has(this.paperKey) || this.session.dialog() || this.session.status === 'thinking') return;
    this.linkVersions.set(this.paperKey, (this.linkVersions.get(this.paperKey) || 0) + 1);
    const cwd = this.librarian || this.binding().managedWorkspace ? undefined : this.binding().cwd;
    this.resetChat(); this.saveBinding(this.paperKey, cwd == null ? null : { cwd }); this.session.setStatus('ready');
  }
  resetChat() {
    this.chat.forget(this.paperKey); this.replyViews.delete(this.paperKey); this.turnId = null;
    this.modelDrafts.delete(this.paperKey);
    this.session.responseStatus = null; this.session.responseError = null;
    this.session.history = []; this.session.answer = this.session.displayAnswer = ''; this.session.syncConversation([]); this.session.y = 0;
  }
  setPaperDirectory() {
    if (this.librarian || this.terminalSession || this.automaticConnection) return true;
    if (this.binding().sessionId || this.binding().pending || this.session.status === 'thinking') return true;
    try {
      const cwd = checkWorkingDirectory($('ask-paper-cwd').value);
      $('ask-paper-cwd').setCustomValidity('');
      if (cwd !== (this.binding().cwd ?? (this.config.paperDirectories ? '' : this.config.cwd) ?? '')) this.saveBinding(this.paperKey, { ...this.binding(), cwd, managedWorkspace: false });
      return true;
    } catch (error) { $('ask-paper-cwd').setCustomValidity(error.message); $('ask-paper-cwd').reportValidity(); $('ask-session-label').textContent = error.message; return false; }
  }
  async prepareWorkspace() {
    if (this.librarian || this.terminalSession) return;
    if (this.binding().sessionId || this.binding().pending || this.session.status === 'thinking') return;
    const key = this.paperKey; const generation = this.generation; const save = this.bindingWriter(key);
    let binding = this.binding(); const workspaceId = binding.workspaceId || crypto.randomUUID();
    binding = { ...binding, workspaceId }; save(binding);
    $('ask-workspace').disabled = true;
    try {
      const workspace = await new EvenTerminal(this.config, this.options()).workspace(this.paperIdentity(this.paperId), this.session.context.title, workspaceId);
      if (this.session.active && this.paperKey === key && this.generation === generation && this.binding() === binding) save({ ...binding, cwd: workspace.cwd, managedWorkspace: true });
    } catch (error) { if (this.session.active && this.paperKey === key) $('ask-session-label').textContent = error.message; }
    finally { $('ask-workspace').disabled = false; }
  }
  async checkReply() {
    if (this.session.abort || this.session.dialog()) return;
    if (this.readCachedReply()) return;
    const key = this.paperKey; const save = this.bindingWriter(key);
    const config = this.config; const binding = this.binding();
    const turnId = this.chat.reconcile(key, binding);
    if (turnId !== this.turnId) this.session.answer = this.chat.turns(key).find(t => t.id === turnId)?.answer || '';
    this.turnId = turnId;
    await this.session.send('Check the previous reply', (_body, signal, progress) => this.replyClient(key, config, signal).reply(binding, save, signal, progress), { resume: true });
    if (this.session.active && this.paperKey === key && this.session.status === 'answer' && this.glassesVisible) this.acknowledgeReply();
  }
  returnToReading() {
    if (!this.session.active) return;
    if (this.terminalSession) { const session = this.desktopSession; this.close(); this.returnToSessions(session); return; }
    if (this.librarian) { this.close(); this.returnToLibrary(); return; }
    if (this.session.dialog()) { this.close(); return; }
    this.glassesVisible = this.phoneVisible = false;
    this.chat.persist(this.paperKey); this.render(); this.changed();
  }
  toggleConversation() {
    if (this.glassesVisible) this.returnToReading();
    else this.open();
  }
  cancelDictation() {
    this.stream.cancel(); this.draftConfidence = null;
    this.generation++; clearTimeout(this.recordingTimer); this.transcription?.abort();
    if (this.activeMic?.capturing || this.activeMic?.pending) this.activeMic.stop().catch(() => {});
    $('ask-question').value = ''; this.session.voiceDraft = ''; this.session.review = null;
    this.session.restoreResponse();
  }
  close() {
    this.glassesVisible = this.phoneVisible = false;
    this.dictationReturn = null;
    this.stream?.cancel();
    this.draftConfidence = null;
    this.generation++; clearTimeout(this.recordingTimer); this.transcription?.abort();
    if (this.activeMic?.capturing || this.activeMic?.pending) this.activeMic.stop().catch(() => {});
    if (this.session.active && this.paperKey) {
      this.modelDrafts.set(this.paperKey, $('ask-question').value);
      if (this.session.status === 'thinking' && !this.binding().pending && !this.deliveries.has(this.paperKey)) this.chat.update(this.paperKey, this.turnId, this.session.answer, 'interrupted');
      this.chat.persist(this.paperKey);
      this.replyViews.set(this.paperKey, { ...this.session.captureView(), turnId: this.turnId, marker: this.binding().pending?.marker });
    }
    this.session.close();
  }
  handle(action, microphoneSource) {
    if (this.session.dialog() && ['previous', 'next', 'previous-page', 'next-page'].includes(action)) {
      this.session.move(action.startsWith('next') ? 1 : -1); return true;
    }
    if (this.session.review && ['play', 'back', 'ask-cancel'].includes(action)) {
      if (action === 'play') this.chooseReview(); else this.cancelReview();
      return true;
    }
    if (this.session.dialog() && !this.session.review) {
      if (['back', 'ask-cancel'].includes(action)) { this.cancelDictation(); return true; }
      if (action === 'play') { this.acceptDictation(); return true; }
      if (action === 'ask-toggle') return true;
    }
    if (action === 'ask-cancel') { this.close(); return true; }
    if (action === 'ask-hold') { this.hold(microphoneSource); return true; }
    if (action === 'ask-release') { this.release(); return true; }
    if (action === 'ask') { this.open(); return true; }
    if (action === 'ask-toggle') { this.toggleConversation(); return true; }
    if (action === 'ask-latest') { this.goToLatest(); return true; }
    if (!this.session.active) return false;
    if ((this.glassesVisible || this.session.review) && ['previous', 'next', 'previous-page', 'next-page'].includes(action)) { this.session.move(action.startsWith('next') ? 1 : -1); return true; }
    if (this.glassesVisible && ['play', 'back'].includes(action)) { this.returnToReading(); return true; }
    // The OS menu backgrounds the app. Preserve the conversation and its
    // scroll position when it closes, but never leave live capture running.
    if (action === 'suspend' && this.session.dialog() && !this.session.review) this.emptyDictation();
    else if (['exit', 'close', 'documents'].includes(action)) this.close();
    else if (['mode', 'footnotes', 'start', 'position', 'autoplay', 'end'].includes(action)) this.returnToReading();
    return false;
  }
  render() {
    const s = this.session;
    if (s.active && s.answer && ['thinking', 'answer'].includes(s.status)) {
      // Reply progress and completion update unread state without navigating.
      const reply = `${this.paperKey}:${this.turnId}:${s.status}:${s.answer}`;
      if (reply !== this.observedReply && !s.savedReply) this.replyUnread = !this.glassesVisible;
      this.observedReply = reply;
    }
    $('ask-panel').hidden = !s.active || !this.phoneVisible;
    const input = $('ask-question'), mirror = $('ask-question-colors');
    const confidence = (s.review || ['starting', 'listening', 'transcribing'].includes(s.status)) && this.draftConfidence?.text === input.value ? this.draftConfidence : null;
    input.readOnly = ['starting', 'listening', 'transcribing'].includes(s.status);
    const dimmed = !!confidence && uncertainWords(input.value, confidence.words).length > 0;
    input.classList.toggle('has-confidence', dimmed); mirror.hidden = !dimmed;
    if (dimmed) { renderSpeechConfidence(mirror, input.value, confidence.words); mirror.scrollTop = input.scrollTop; }
    if (s.review) { s.review.dimmed = false; s.review.refining = !!s.review.completing; }
    const state = s.active ? s.status : 'closed';
    if (this.diagnostics?.enabled) this.diagnostics.ask = { state, glassesVisible: this.glassesVisible, phoneVisible: this.phoneVisible,
      answerCharacters: s.answer?.length || 0, review: !!s.review, completionPending: !!s.review?.completing,
      refinementPending: false };
    if (state !== this.loggedState) {
      this.loggedState = state; this.diagnostics?.log('ask-state', { state, conversationVisible: !!s.layout });
    }
    this.keyboard?.update();
    $('ask-open').setAttribute('aria-pressed', String(s.active && this.phoneVisible));
    if (!s.active) return;
    this.resizeQuestion();
    const desktop = connectionMode(this.config) === 'terminal'; const binding = this.binding();
    $('ask-chat-model-field').hidden = !desktop || this.terminalSession;
    $('ask-chat-model').value = this.config.agent || '';
    $('ask-chat-model').disabled = this.terminalSession || !!s.dialog();
    const librarian = this.librarian, terminalSession = this.terminalSession;
    document.querySelector('.ask-title-label').textContent = terminalSession ? 'Even Terminal' : librarian ? 'Librarian' : 'Ask';
    $('ask-panel').setAttribute('aria-label', terminalSession ? 'Even Terminal session' : librarian ? 'Librarian' : 'Ask about this');
    input.placeholder = terminalSession ? 'Continue this session…' : librarian ? 'Ask your librarian…' : 'Ask about this paper…';
    $('ask-paper-session').querySelector('summary').textContent = terminalSession ? 'Desktop session' : librarian ? 'Library session' : 'Session for this paper';
    $('ask-session-new').textContent = librarian ? 'New Librarian session' : 'New session for this paper';
    for (const id of ['ask-session-choice', 'ask-sessions-refresh', 'ask-session-use']) $(id).hidden = librarian || terminalSession;
    $('ask-session-new').hidden = terminalSession;
    $('ask-paper-directory-settings').hidden = librarian || terminalSession || this.automaticConnection;
    $('ask-session-help').textContent = terminalSession ? 'Continues the existing desktop conversation with its own model, tools and permissions.' : librarian ? 'A dedicated conversation in the shared library directory. New session keeps the old conversation on the desktop.' : 'Use a dedicated session for this paper. New session unlinks the current one; its desktop conversation is kept.';
    $('ask-history-help').textContent = terminalSession ? 'Recent messages sync with this desktop session. Each session keeps its own history and draft.' : connectionMode(this.config) === 'terminal'
      ? 'Each model keeps a separate conversation for this document or Librarian. Switching back restores its messages and desktop session. Recent messages sync with that session.'
      : 'Recent questions asked here are saved on this device, separately for each paper.';
    $('ask-voice-help').textContent = terminalSession ? 'Hold to speak. Release to review before sending. Swipe through replies; tap to return to sessions. Approvals stay on the desktop.' : librarian ? 'Hold on the glasses to speak, or tap the microphone. Release to review before sending. Swipe through replies; tap to return to the library. The librarian works in the shared desktop library. Sync the library to transfer file changes to your phone.' : this.documentVoiceHelp;
    $('ask-paper-session').hidden = !desktop;
    $('ask-session-label').textContent = binding.sessionId ? `${this.config.agent} · ${binding.sessionTitle || binding.sessionId}${binding.cwd ? `\nRequested directory: ${binding.cwd}` : ''}${binding.pending ? ' · Reply pending' : ''}` : binding.pending ? 'Submission uncertain. Check the desktop, then choose its session before asking again.' : librarian ? 'Your Librarian conversation starts in the shared desktop library with your first question.' : `${this.config.agent || 'Desktop'} · A separate conversation for this paper starts with your first question when supported by the desktop. You can also select an existing session.`;
    $('ask-workspace').hidden = !this.config.paperDirectories;
    $('ask-workspace').disabled = !!binding.sessionId || !!binding.pending || s.status === 'thinking';
    $('ask-paper-cwd').placeholder = this.config.paperDirectories ? 'Created automatically for a new session' : 'Even Terminal default';
    $('ask-paper-cwd').disabled = !!binding.sessionId || !!binding.pending || s.status === 'thinking';
    if (document.activeElement !== $('ask-paper-cwd')) $('ask-paper-cwd').value = binding.cwd ?? (this.config.paperDirectories ? '' : this.config.cwd) ?? '';
    $('ask-check-reply').hidden = !desktop || !(binding.pending || binding.reply?.unread); $('ask-check-reply').disabled = s.status === 'thinking';
    $('ask-check-reply').textContent = binding.reply?.unread ? 'Read reply' : 'Check reply';
    $('ask-session-use').disabled = $('ask-session-new').disabled = !!s.abort || this.deliveries.has(this.paperKey) || !!s.dialog() || s.status === 'thinking';
    $('ask-context').textContent = terminalSession ? `${this.config.agent === 'claude' ? 'Claude' : 'Codex'} · ${s.context.title}` : librarian ? 'Shared library' : `${s.savedReply ? 'Desktop reply · Current reading place: ' : ''}${s.context.title}${s.context.page ? ` · PDF page ${s.context.page}` : ''} · ${s.context.position}%${s.context.image ? ' · Text around this image; the image itself is not sent' : ''}`;
    if (this.renderedContext !== s.context || this.renderedFiles !== s.context.files || librarian && this.renderedLibraryDirectory !== binding.cwd) {
      this.renderedContext = s.context; this.renderedFiles = s.context.files; this.renderedLibraryDirectory = binding.cwd;
      $('ask-source-label').textContent = terminalSession ? 'Existing desktop conversation' : librarian ? 'Desktop library' : s.context.files ? 'Paper files and current position' : 'Passage included when you ask';
      $('ask-passage').textContent = terminalSession ? 'Messages go to this session. The open document is not included.' : librarian ? binding.cwd || 'Uses the same root directory as library sync. No document needs to be open.' : s.context.files ? s.context.files.files.map(file => `${file.name}: ${file.path}`).join('\n')
        + '\n\nCurrent position:\n' + JSON.stringify(s.context.files.position, null, 2) : s.context.passage;
      $('ask-context-size').textContent = librarian || terminalSession ? '' : s.context.files ? `· on desktop${s.context.partial ? ' · partial reflow; original complete' : ''}`
        : `· ~${(s.context.estimatedTokens || 0).toLocaleString()} tokens${s.context.partial ? ' · prepared text only' : ''}`;
    }
    $('ask-status').textContent = ({ ready: '', starting: 'Starting microphone…', listening: 'Listening…', transcribing: s.voiceProgress || 'Transcribing…', review: s.review?.refining ? 'Refining…' : '', thinking: s.progressText || 'Thinking…', answer: '', error: s.error })[s.status];
    $('ask-review-cancel').hidden = !s.review;
    $('ask-status').dataset.busy = String(s.status === 'thinking');
    const responseStatus = s.responseStatus || s.status;
    if (this.turnId && ['thinking', 'answer', 'error'].includes(responseStatus)) {
      // A completed reply is immutable here. In particular, a failed voice
      // follow-up must not mark the preceding completed turn as an error.
      const turn = this.chat.turns(this.paperKey).find(t => t.id === this.turnId);
      if (turn?.state !== 'complete') this.chat.update(this.paperKey, this.turnId, s.answer, responseStatus === 'answer' ? 'complete' : responseStatus === 'error' ? 'error' : 'pending');
    }
    this.session.syncConversation(this.chat.turns(this.paperKey));
    this.renderChat();
    $('ask-answer').setAttribute('aria-busy', String(s.status === 'thinking'));
    $('ask-send').disabled = !!this.unavailableReason || ['starting', 'listening', 'transcribing'].includes(s.status) || !!s.abort && !desktop || !!s.review && !s.review.text;
    $('ask-voice').disabled = !!this.unavailableReason || s.status === 'transcribing';
    const listening = ['starting', 'listening'].includes(s.status);
    const voiceLabel = listening ? 'Review voice question' : this.options().evenHost ? 'Start dictation from glasses' : 'Start dictation';
    $('ask-voice').setAttribute('aria-label', voiceLabel); $('ask-voice').title = voiceLabel;
    $('ask-voice').setAttribute('aria-pressed', String(listening));
    if (s.status === 'thinking' && !s.abort && !this.deliveries.has(this.paperKey) && binding.pending?.submitted && binding.sessionId) {
      // A POST may finish while a reopened view is reviewing another recording.
      // Resume its observer once that review is dismissed, without resending.
      queueMicrotask(() => { if (s.active && s.status === 'thinking' && !s.abort && this.binding().pending?.submitted) void this.checkReply(); });
    }
  }
  resizeQuestion() {
    const input = $('ask-question'); if (!input.clientWidth) return;
    const style = getComputedStyle(input), max = parseFloat(style.maxHeight) || 120;
    const key = `${input.clientWidth}:${max}:${style.fontSize}:${style.lineHeight}:${input.value}`;
    if (key === this.questionSizeKey) return;
    this.questionSizeKey = key;
    input.style.height = '0px'; input.style.height = `${Math.max(40, Math.min(max, input.scrollHeight))}px`;
    $('ask-question-colors').style.width = `${input.clientWidth}px`;
    $('ask-question-colors').style.height = `${input.clientHeight}px`;
  }
  scrollChat() {
    cancelAnimationFrame(this.chatScrollFrame);
    this.chatScrollFrame = requestAnimationFrame(() => {
      if (!this.chatFollowing || !this.session.active || this.chatScrollbar.dragging) return;
      $('ask-history').scrollTop = $('ask-history').scrollHeight; $('ask-latest').hidden = true;
    });
  }
  // Completed answers can be copied, or take the reader back to where the
  // question was asked. The position is the one recorded with the turn.
  answerActions(turn) {
    const actions = document.createElement('div'); actions.className = 'ask-message-actions'; actions.hidden = true;
    actions.dataset.location = JSON.stringify([turn.position, turn.page]);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'text-button'; copy.textContent = 'Copy';
    copy.setAttribute('aria-label', 'Copy answer');
    copy.onclick = async () => {
      const text = this.chat.turns(this.paperKey).find(t => t.id === turn.id)?.answer || '';
      try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; }
      catch {
        const range = document.createRange(); range.selectNodeContents(copy.closest('.ask-message').querySelector('.ask-message-text'));
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); copy.textContent = 'Selected';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    };
    actions.append(copy);
    if (Number.isFinite(Number(turn.position))) {
      const go = document.createElement('button'); go.type = 'button'; go.className = 'text-button';
      go.textContent = `Go to passage · ${turn.page ? `p. ${turn.page}` : `${Math.round(turn.position)}%`}`;
      go.setAttribute('aria-label', `Go to the passage this question was asked from, ${turn.page ? `PDF page ${turn.page}` : `${Math.round(turn.position)}%`}`);
      go.onclick = () => this.goToPosition(turn.position, turn);
      actions.append(go);
    }
    return actions;
  }
  renderChat() {
    const list = $('ask-messages'); const turns = this.chat.turns(this.paperKey);
    const signature = JSON.stringify(turns);
    if (this.renderedChatKey === this.paperKey && this.renderedChat === signature) return;
    if (this.renderedChatKey !== this.paperKey) { list.replaceChildren(); this.chatFollowing = true; }
    const scroller = $('ask-history'), top = scroller.getBoundingClientRect().top;
    const anchor = this.chatFollowing ? null : [...list.children].find(el => !el.hidden && el.getBoundingClientRect().bottom > top);
    const anchorOffset = anchor?.getBoundingClientRect().top;
    this.renderedChatKey = this.paperKey; this.renderedChat = signature;
    const keep = new Set();
    $('ask-answer')?.removeAttribute('id');
    for (const [i, turn] of turns.entries()) for (const entry of chatMessages(turn)) {
      const { role, text } = entry;
      if (role === 'user' && !turn.question) continue;
      const key = `${turn.id}:${entry.key}`; keep.add(key);
      let message = [...list.children].find(el => el.dataset.key === key);
      if (!message) {
        message = document.createElement('article'); message.dataset.key = key; message.className = `ask-message ask-message-${role}`;
        const label = document.createElement('p'); label.className = 'ask-speaker'; label.textContent = role === 'user' ? 'You' : role === 'activity' ? 'Activity' : 'Assistant';
        const body = document.createElement('div'); body.className = 'ask-message-text'; message.append(label, body); list.append(message);
        if (role === 'assistant') message.append(this.answerActions(turn));
      }
      // History can backfill questions and replies before already rendered
      // messages. Reorder existing nodes as well as inserting missing nodes.
      list.append(message);
      const body = message.querySelector('.ask-message-text');
      if (role === 'activity') message.dataset.lines = String(entry.lines || 1);
      let actions = message.querySelector('.ask-message-actions');
      if (actions && actions.dataset.location !== JSON.stringify([turn.position, turn.page])) {
        const next = this.answerActions(turn); actions.replaceWith(next); actions = next;
      }
      if (actions) actions.hidden = turn.state !== 'complete' || !turn.answer;
      if (body.textContent !== text) body.textContent = text;
      message.hidden = role === 'assistant' && !text;
      if (role === 'assistant' && i === turns.length - 1) { body.id = 'ask-answer'; body.setAttribute('aria-busy', String(this.session.status === 'thinking')); }
    }
    for (const child of [...list.children]) if (!keep.has(child.dataset.key)) child.remove();
    // Stable target for accessibility and integrations before the first reply.
    if (!$('ask-answer')) { const empty = document.createElement('div'); empty.id = 'ask-answer'; list.append(empty); }
    $('ask-empty').hidden = turns.length > 0;
    if (this.chatFollowing) this.scrollChat();
    else {
      if (anchor?.isConnected) scroller.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
      $('ask-latest').hidden = false;
    }
  }
}
