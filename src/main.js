import './style.css';
import { installHelpPopups } from './help-popups.js';
import { appMenu, READING_MODES, actionForMenu, gestureHelp, keyboardHelp } from './controls.js';
import { installPreviewInput } from './preview-input.js';
import { AskUI } from './ask-ui.js';
import { parseDocument, anchorAt, restoreAnchor, rowAt, searchDocument, positionForMatch, BODY_HEIGHT } from './document.js';
import { PassageView } from './passage.js';
import { updatePdfReader } from './pdf-progress.js';
import { PdfPassageView } from './pdf-passage.js';
import { PdfGallery } from './pdf-gallery.js';
import { pdfAnnotationItems } from './pdf-captions.js';
import { pdfAnchor, restorePdfAnchor, pdfPageTurn, PDF_WIDTH } from './pdf-layout.js';
import { pdfReadingViews, nearbyPdfNote } from './pdf-notes.js';
import { pdfNativeWindow, pdfImageEnd, PdfAutoscroll, pdfEntryLines } from './pdf-native.js';
import { openDocumentPicker, moveDocumentPicker, documentPickerText, LIBRARIAN_ID } from './document-picker.js';
import { TERMINAL_SESSIONS_ID, listTerminalSessions, terminalSessionPicker, sessionIdentity } from './terminal-sessions.js';
import { librarySort, orderedDocuments, recordDocumentOpen } from './library-order.js';
import { openNavigationPicker, refreshNavigationPicker, movePositionPicker, togglePositionStep } from './position-picker.js';
import { documentContents } from './document-contents.js';
import { Reader, autoSpeed, speedFromSlider, speedToSlider, stepAutoSpeed } from './reader.js';
import { wordsPerMinute, wordsPerGroup, wordSpeedFromSlider, wordSpeedToSlider, stepWordSpeed, MIN_WORD_RATE, MAX_WORD_RATE } from './speed-reading.js';
import { safeTimeout, cancelTimeout } from './timers.js';
import { speedTitleBitmap } from './speed-title.js';
import { pdfSettingsFor, normalizePdfSettings, usePdfDefaults, forgetPdfSettings } from './pdf-settings.js';
import { GlassesDisplay, paintFrame } from './glasses.js';
import { LocalLibrary } from './library.js';
import { libraryClearance, validLibraryActivity } from './library-clearance.js';
import { syncLibrary, desktopLibrary, preparedWordUpdates, downloadCatalogDocument } from './library-sync.js';
import { EvenTerminal } from './ask-terminal.js';
import { connectionMode } from './ask-connections.js';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { PhoneLibrary, PhonePreferences, AtomicPhoneValue, bridgeStorage, retryAfterStorageRecovery, storageWriteRejected, storageUnavailable } from './phone-storage.js';
import { waitForSpeechHost } from './speech-storage.js';
import { PdfPreparationCache, browserPdfStorage } from './pdf-cache.js';
import { readFileInBackground } from './file-reader.js';
import { prepareTextInBackground } from './text-reader.js';
import { ImportQueue, importFinished } from './import-queue.js';
import { nativeLayout, pageTurnY, measureNativeText } from './native-text.js';
import { Diagnostics, VERSION } from './diagnostics.js';
import { installDiagnosticCheckpoint } from './diagnostic-checkpoint.js';
import { installDebugExport } from './debug-export.js';
import { DEBUG, BUILD_CHANNEL, WEB } from 'virtual:build-profile';
import automaticTerminal from 'virtual:automatic-terminal';
import { automaticTerminalConfig, migrateTerminalPreferences } from './terminal-pairing.js';
import { FullscreenReader, installHoldButton } from './fullscreen-reader.js';
import { SharedReaderState, scopedReaderConfig } from './shared-reader-state.js';
import { desktopPdfCache } from './desktop-pdf-cache.js';
import { ReadingTracker, ReadingLog, readingWords } from './reading-activity.js';
import { browserReadingStorage, phoneReadingStorage, ReadingSync } from './reading-storage.js';
import { glassesReadingUnits } from './reading-view.js';
import { ReadingHistoryUI } from './reading-history-ui.js';
import { averageReadingSpeed, readingSpeedLabel, documentReadingWords, preparedReadingWords, readingDuration, libraryReadingEstimate } from './reading-estimates.js';

const $ = id => document.getElementById(id);
let fullscreenReader, sharedReader, PdfDocument;
const diagnostics = new Diagnostics(undefined, { enabled: DEBUG });
if (DEBUG) {
  window.addEventListener('error', event => diagnostics.error('js-error', event.error || new Error(event.message), { line: event.lineno, column: event.colno }));
  window.addEventListener('unhandledrejection', event => diagnostics.error('unhandled-rejection', event.reason));
}
const localKey = 'even-reader:preferences:v1';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let preferences;
try { preferences = JSON.parse(localStorage.getItem(localKey) || '{}'); } catch { preferences = {}; }
const privateTerminalConfig = () => WEB && window.pageborneConnection || automaticTerminalConfig(automaticTerminal, { evenHost: !!window.flutter_inappwebview?.callHandler, hostname: location.hostname });
const readerConnection = () => scopedReaderConfig(privateTerminalConfig() || preferences.ask || {}, preferences);
migrateTerminalPreferences(preferences, privateTerminalConfig());
preferences.positions ||= {}; preferences.bookmarks ||= {};
delete preferences.pageOverlap; delete preferences.askContextTokens;
preferences.pdfEntryLines = pdfEntryLines(preferences.pdfEntryLines);
// Retire stored credentials; old prototype URLs still open the local reader.
delete preferences.connection; delete preferences.clientId;
if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
// Appearance is shared like other reading settings. "system" follows the phone.
function applyTheme() {
  const theme = ['light', 'dark'].includes(preferences.theme) ? preferences.theme : 'system';
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = theme === 'system' ? (meta.media.includes('dark') ? '#0e110f' : '#f3f1ea') : theme === 'dark' ? '#0e110f' : '#f3f1ea';
  }
  for (const option of ['system', 'light', 'dark']) document.getElementById(`theme-${option}`)?.setAttribute('aria-pressed', String(option === theme));
}
applyTheme();
let snapshot = null; let active = null; let layout = null;
const fetchedReadingWords = new Map();
let readingCountsRefresh = null, readingCountsAttempt = 0;
let deleteStatus = '', deleting = false, deletionPending = false;
let libraryBusy = false; let libraryReady = false; let deleteId = null; let picker = null; let positionPicker = null; let modePicker = null;
let librarySync = null; let librarySyncLabel = ''; let librarySyncHold = false;
let positionPickerHold = false;
let dirty = true; let lastSentKey = ''; let lastSend = 0; let lastPassage = -1;
let persistTimer = null; let searchTimer = null;
let animationTimer = null; let playbackBlocked = true;
let pdfDocument = null; let selectionVersion = 0; let pdfBitmap = null; let pdfRendering = false;
let pdfOpenMessage = null;
const pdfPreparations = new Set();
let pdfProgressRefresh = null;
let pendingPdfPosition = null;
let pdfNotes = null; let footnotesView = null; let askUI;
const browserStore = new LocalLibrary({ lazy: true });
let documentLoadController = null;
let pdfPreparationCache = new PdfPreparationCache(browserPdfStorage(browserStore));
let store = browserStore; let phonePreferences = null; let openingLibrary = null;
let readingLog = null, readingLayout = null, readingPreview = null;
const previewContext = $('preview').getContext('2d');

function notice(text, error = false) {
  $('notice').hidden = !text; $('notice-text').textContent = text;
  if (DEBUG) $('error-export').hidden = !error;
  $('notice').classList.toggle('error', error);
}
function savePreferences() {
  // A fresh WebView origin starts with defaults while native preferences wait
  // behind voice setup. Lifecycle events must not timestamp or persist those
  // defaults: a newer timestamp would make them replace the saved phone state.
  if (!libraryReady) return;
  preferences.updatedAt = Math.max(Date.now(), (Number(preferences.updatedAt) || 0) + 1);
  if (store.readOnly) phonePreferences?.suspend();
  phonePreferences?.schedule(preferences);
  try { localStorage.setItem(localKey, JSON.stringify(preferences)); }
  catch { if (!phonePreferences) notice('Phone storage is full or unavailable. Keep this page open to retain your place.', true); }
}
function documentKey() { return active?.positionKey; }
function readingAnchor() {
  const anchor = layout?.format === 'pdf' ? pdfAnchor(layout, reader.positionY) : anchorAt(layout, reader.positionY);
  return { ...anchor, percent: readingPercent(), speedCursor: reader.speedReading.saved };
}
function readingPercent() {
  return Math.round((reader.mode === 'speed' ? reader.speedReading.percent : layout?.maxY ? reader.y / layout.maxY * 100 : 0) * 10) / 10;
}
function restorePosition(anchor) { return layout?.format === 'pdf' ? restorePdfAnchor(layout, anchor) : restoreAnchor(layout, anchor); }
function rememberPosition() {
  if (active) {
    if (layout && !pendingPdfPosition) preferences.positions[documentKey()] = readingAnchor();
    preferences.selected = { id: active.id };
  }
  // Positions are tiny, but do not let removed libraries grow this forever.
  const keys = Object.keys(preferences.positions);
  for (const key of keys.slice(0, Math.max(0, keys.length - 2000))) delete preferences.positions[key];
  savePreferences();
}
function changed() {
  dirty = true;
  if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; rememberPosition(); }, 400);
}
let previewInput; let previewMenu = null;
const reader = new Reader({ onChange: changed });
const passage = new PassageView($('passage'), y => jump(y));
const pdfPassage = new PdfPassageView($('pdf-passage'), y => jump(y));
const pdfGallery = new PdfGallery($('pdf-gallery'), $('figure-dialog'));
const pdfAnnotations = new PdfGallery($('pdf-annotations'), $('annotation-dialog'), pdfAnnotationItems);
reader.mode = preferences.mode === 'speed' ? 'speed' : ['auto', 'native'].includes(preferences.mode) ? 'auto' : 'page';
reader.speed = autoSpeed(preferences.autoSpeed);
reader.speedReading.rate = wordsPerMinute(preferences.wordSpeed);
reader.speedReading.count = wordsPerGroup(preferences.wordGroup);
reader.pauseAtTitles = preferences.pauseAtTitles === true;
preferences.mode = reader.mode;
delete preferences.preloadText; delete preferences.speed;
// The mirror shows a one-word connection state; the full status stays available
// to assistive technology and as a tooltip. Reconnect appears only when it can help.
function setConnection(text) {
  $('connection').textContent = text;
  const lower = text.toLowerCase();
  const state = lower.startsWith('device reader') ? 'Reader' : lower.startsWith('phone preview') ? 'Preview' : lower.startsWith('connecting') ? 'Connecting…'
    : (lower === 'connected' || lower.endsWith(' connected')) ? 'Connected' : lower.includes('paused') ? 'Paused' : lower.includes('closed') ? 'Closed' : 'Needs attention';
  $('connection-state').textContent = state; $('connection-state').title = text;
  $('connection-state').closest('.connection-line').dataset.state = state.toLowerCase().replace(/[^a-z]/g, '');
  $('reconnect').hidden = ['Preview', 'Reader', 'Connected', 'Connecting…'].includes(state);
}
const glasses = new GlassesDisplay({ diagnostics, onStatus: text => {
  setConnection(text); lastSentKey = ''; dirty = true;
}, onAction: dispatchAction, onAudio: bytes => askUI?.mic.receive(bytes), onAccepted: frame => {
  if (!glasses.suspended) askUI?.acceptFrame(frame);
  // Wake again once the whole transfer releases the display lane.
  if (reader.playing && ['auto', 'speed'].includes(reader.mode)) scheduleAnimation();
}, onReadingAccepted: frame => {
  sampleReading(frame);
  // Words can already be read while the footer is still being transferred.
  if (reader.playing && ['auto', 'speed'].includes(reader.mode)) scheduleAnimation();
} });
askUI = new AskUI({
  pdfProcessing: () => pdfPreparations.size > 0,
  readVocabulary: () => preferences.speechVocabulary || '',
  saveVocabulary: value => { preferences.speechVocabulary = value; savePreferences(); },
  readContextVocabulary: () => preferences.speechContextVocabulary !== false,
  saveContextVocabulary: value => { preferences.speechContextVocabulary = value; savePreferences(); },
  readSpeech: () => preferences.speechBackend,
  saveSpeech: backend => { preferences.speechBackend = backend; savePreferences(); },
  diagnostics,
  snapshot: () => ({ document: active, bodyLayout: layout, notes: pdfNotes, layout: footnotesView?.layout || layout, y: footnotesView?.y ?? reader.y, title: active?.title, paperId: documentKey(), platform: WEB ? 'web' : 'glasses', wordFrame: reader.mode === 'speed' ? reader.speedReading.current : null }),
  pause: () => { useReadyPdfPages(); reader.pause(); picker = null; positionPicker = null; modePicker = null; previewMenu = null; }, changed: () => { dirty = true; },
  returnToSessions: session => { void openTerminalSessions(sessionIdentity(session)); },
  returnToLibrary: () => { picker = openDocumentPicker(libraryDocuments(), active?.id, LIBRARIAN_ID); setLibraryOpen(true, false); dirty = true; renderControls(); },
  presentVoiceOverlay: () => { dirty = true; animate(performance.now(), true); if (!WEB) return glasses.queue?.whenIdle(); },
  automaticConnection: !!automaticTerminal || WEB,
  readConfig: readerConnection,
  saveConfig: config => { preferences.ask = config; savePreferences(); },
  readModels: () => { const scope = readerConnection().chatScope; return (scope ? preferences.readerModels?.[scope] : preferences.askModels) || {}; },
  saveModels: value => { const scope = readerConnection().chatScope; if (scope) { preferences.readerModels ||= {}; preferences.readerModels[scope] = value; } else preferences.askModels = value; savePreferences(); },
  readBindings: () => preferences.askSessions || {}, saveBindings: bindings => { preferences.askSessions = bindings; savePreferences(); },
  readChats: () => preferences.askChats || {}, saveChats: chats => { preferences.askChats = chats; savePreferences(); },
  reveal: () => {
    if (fullscreenReader?.active) return;
    showTab(null); renderControls();
    // Wide screens show the conversation in the right-hand pane; keep the header in view.
    if (matchMedia('(min-width: 1200px)').matches) document.querySelector('.reader-content').scrollTop = 0;
    else scrollToTool($('ask-panel'));
  },
  onLibraryFile: async (endpoint, file) => {
    preferences.librarySync ||= {};
    const previous = preferences.librarySync[endpoint];
    preferences.librarySync[endpoint] = { id: file.id, directory: file.directory, at: Date.now(),
      files: { ...(previous?.id === file.id ? previous.files : {}), [file.name]: file.sha256 } };
    savePreferences(); await phonePreferences?.flush();
  },
  paperIdentity: key => { preferences.askPaperIds ||= {}; if (!preferences.askPaperIds[key]) { preferences.askPaperIds[key] = crypto.randomUUID(); savePreferences(); } return preferences.askPaperIds[key]; },
  audioControl: async enabled => {
    if (!glasses.bridge || enabled && !glasses.ready) { if (!enabled) return true; throw new Error('Open Pageborne in the Even app to use the glasses microphone, or type on the phone.'); }
    return glasses.lane.run(enabled ? 'microphone-start' : 'microphone-stop', () => glasses.bridge.audioControl(enabled));
  },
  showSettings: () => setSettingsOpen(true),
  goToPosition: (percent, turn) => {
    askUI.returnToReading();
    if (!layout) return;
    if (turn?.page && layout.format === 'pdf') jump(layout.blocks.find(b => b.page === turn.page)?.y || 0);
    else seekPercent(Math.min(100, Math.max(0, Number(percent) || 0)));
  },
  captureQrImage: async kind => {
    if (!glasses.bridge) throw new Error('Camera is not ready.');
    return kind === 'camera' ? glasses.bridge.captureImageFromCamera() : glasses.bridge.pickImageFromAlbum();
  },
});
sharedReader = new SharedReaderState({
  client: () => {
    const config = privateTerminalConfig() || preferences.ask;
    if (!libraryReady || config?.mode !== 'terminal') return null;
    return new EvenTerminal(config, askUI.options());
  },
  documents: () => snapshot?.documents || [], read: () => preferences,
  save: patch => { Object.assign(preferences, patch); savePreferences(); },
  changed: ({ scopeChanged, chats }) => {
    if (scopeChanged) askUI.close();
    // Merge only coordinates into live turns: never discard an in-flight answer.
    for (const [key, turns] of askUI.chat.cache) for (const turn of turns) {
      const saved = chats[key]?.find(t => t.id === turn.id);
      if (saved?.position != null && turn.position == null) { turn.position = saved.position; turn.page = saved.page; }
    }
    askUI.loadModels(); askUI.renderedChat = null; askUI.render();
  },
});
setInterval(() => { if (!document.hidden && libraryReady) void sharedReader.sync(); }, 5000);
function readingSessions(entry) {
  const sessions = [...(entry.sessions || [])];
  for (const [key, binding] of Object.entries(preferences.askSessions || {})) {
    let parts; try { parts = JSON.parse(key); } catch { continue; }
    if (parts[0] === entry.document.key && parts[1] === 'terminal' && parts[2] === entry.scope && binding?.sessionId)
      sessions.push({ agent: parts[3], id: binding.sessionId, ...(binding.cwd ? { cwd: binding.cwd } : {}) });
  }
  const remote = sharedReader.remote;
  if (remote && entry.scope === `pageborne:${remote.instanceId}:${remote.libraryId}`) for (const record of remote.records) {
    if (record.document === entry.document.id) for (const session of record.sessions)
      sessions.push({ agent: record.agent, id: session.id, ...(session.cwd ? { cwd: session.cwd } : {}) });
  }
  return [...new Map(sessions.filter(s => ['claude', 'codex'].includes(s.agent)).map(s => [`${s.agent}:${s.id}`, s])).values()].slice(-100);
}
const recordReading = entry => {
  if (readingLog) void readingLog.add([{ ...entry, sessions: readingSessions(entry) }]).catch(readingSaveError);
};
const readingTracker = new ReadingTracker(recordReading), askReadingTracker = new ReadingTracker(recordReading);
function readingSaveError(error) { notice(`Reading history could not be saved: ${error.message}`, true); }
const readingSync = new ReadingSync({
  log: () => readingLog, scope: () => readerConnection().chatScope, sessions: readingSessions,
  client: () => libraryReady && connectionMode(readerConnection()) === 'terminal' ? new EvenTerminal(readerConnection(), askUI.options()) : null,
  changed: () => readingHistory.render(),
});
const syncReading = async () => { await readingLog?.flush().catch(readingSaveError); await sharedReader.sync(); await readingSync.sync(); await refreshLibraryActivity(); };
syncReading.status = () => readingSync.status;
const readingHistory = new ReadingHistoryUI({
  log: () => readingLog, sync: syncReading, sessions: readingSessions,
  pause: () => { reader.pause(); readingTracker.leave(); askReadingTracker.leave(); },
  exists: entry => entry.scope === (readerConnection().chatScope || '') && snapshot?.documents.some(d => d.id === entry.document.id),
  openDocument: async entry => { await selectDocument(entry.document.id); setLibraryOpen(false, false); },
  conversation: async (entry, session, signal) => {
    const config = readerConnection();
    if (entry.scope !== (config.chatScope || config.endpoint)) throw new Error('Connect to the desktop library where this conversation was recorded.');
    return new EvenTerminal({ ...config, agent: session.agent }, askUI.options()).conversation({ sessionId: session.id }, signal);
  },
});
$('reading-history-open').onclick = () => void readingHistory.open();
setInterval(() => { if (libraryReady && !document.hidden) void syncReading(); }, 30000);
function sampleReading(frame, now = performance.now()) {
  const platform = WEB ? 'web' : glasses.bridge ? 'glasses' : 'preview';
  const blocked = !libraryReady || !readingLog || readingHistory.dialog.open || footnotesView || askUI?.speech.setup.blocked;
  const displayBlocked = glasses.bridge ? !glasses.ready || glasses.suspended : document.hidden || previewMenu || !$('shared-settings').hidden;
  let askView = null;
  if (!blocked && !askUI?.session.dialog()) {
    const message = frame?.message;
    if (!displayBlocked && !frame?.dialog && !frame?.modePicker && message?.kind === 'ask' && !message.dialog && message.readingContext && message.readingUnits?.length)
      askView = { ...message.readingContext, units: message.readingUnits, pane: `glasses:${message.readingPane}`,
        page: message.readingPage, surface: 'glasses' };
    // Use one surface at a time. The acknowledged glasses/preview pane takes
    // precedence when shown; otherwise the phone chat can be read independently.
    else if ((!askUI?.glassesVisible || displayBlocked) && !document.hidden && $('shared-settings').hidden) askView = askUI?.phoneReadingView();
  }
  askReadingTracker.observe(askView ? { ...askView, platform: askView.surface === 'phone' ? WEB ? 'web' : 'preview' : platform } : null, now);
  if (blocked || displayBlocked || askView || !active || !layout || !frame || frame.selection !== selectionVersion
    || !glasses.bridge && !fullscreenReader?.active && drawerQuery.matches && $('library-panel').dataset.open === 'true') {
    readingTracker.observe(null, now); return;
  }
  const displayed = frame.layout;
  if (readingLayout !== displayed) { readingTracker.leave(now, 'layout'); readingLayout = displayed; }
  if (frame.message || frame.dialog || frame.picker || frame.positionPicker || frame.modePicker) { readingTracker.observe(null, now); return; }
  const units = glassesReadingUnits(frame, frame.layout === reader.pageLayout ? reader.speedReading.entries : undefined), config = readerConnection();
  readingTracker.observe({ document: { id: active.id, key: active.positionKey, title: String(active.title).slice(0, 300), revision: active.revision },
    scope: config.chatScope || '', platform,
    pane: `${frame.mode}:${units[0]?.key ?? `image:${frame.y}`}:${units.at(-1)?.key || ''}`,
    page: units[0]?.page || layout.blocks?.findLast(block => block.y <= frame.y)?.page,
    position: Math.min(100, Math.max(0, 100 * frame.y / (displayed?.maxY || 1))), units }, now);
}
async function preserveReadingSessions(doc) {
  if (!readingLog) return;
  const entries = readingLog.entries.filter(e => e.document.key === doc.positionKey).map(e => ({ ...e, sessions: readingSessions(e) }));
  if (entries.length) await readingLog.add(entries);
}
function dispatchAction(action, source = 'glasses') {
  if (source === 'glasses') previewInput?.cancel();
  else diagnostics.log('gesture', { action, source });
  handleAction(action, true, source);
  // Keep the simulated root library reachable on the phone after Pages Back.
  if (source !== 'glasses' && action === 'back' && picker && !active) setLibraryOpen(false, false);
}
function handleAction(action, gesture = false, source) {
  if (askUI?.speech.setup.blocked) return;
  if (action === 'menu') { previewInput?.cancel(); reader.pause(); modePicker = null; previewMenu = previewMenu ? null : { index: 0 }; dirty = true; return; }
  if (previewMenu) {
    if (['previous', 'next', 'previous-page', 'next-page'].includes(action)) {
      const count = appMenu(askUI?.glassesVisible, documentContents(layout).length > 0).length;
      previewMenu.index = (previewMenu.index + (action.startsWith('next') ? 1 : -1) + count) % count;
      dirty = true; return;
    }
    if (action === 'back') { previewMenu = null; dirty = true; return; }
    if (action === 'play') action = actionForMenu(appMenu(askUI?.glassesVisible, documentContents(layout).length > 0)[previewMenu.index].itemID);
    previewMenu = null; dirty = true;
  }
  if (modePicker) {
    if (['previous', 'next', 'previous-page', 'next-page'].includes(action)) {
      modePicker.index = (modePicker.index + (action.startsWith('next') ? 1 : -1) + READING_MODES.length) % READING_MODES.length;
      dirty = true; return;
    }
    if (action === 'play') { setMode(READING_MODES[modePicker.index].value); dirty = true; return; }
    if (action === 'back' || action === 'mode') { modePicker = null; dirty = true; return; }
    // Foreground notifications from the OS menu must not dismiss its selector.
    if (!['suspend', 'resume'].includes(action)) { modePicker = null; dirty = true; }
  }
  if (picker?.kind === 'terminal-sessions') {
    if (['previous', 'next', 'previous-page', 'next-page'].includes(action)) {
      picker = moveDocumentPicker(picker, action.startsWith('next') ? 1 : -1); dirty = true; return;
    }
    if (action === 'back' || action === 'documents') { returnFromTerminalSessions(); return; }
    if (action === 'ask-hold') { librarySyncHold = true; void openTerminalSessions(picker.items[picker.index]?.id); return; }
    if (action === 'play') {
      const item = picker.items[picker.index];
      if (item.action === 'back') returnFromTerminalSessions();
      else if (item.action === 'refresh') void openTerminalSessions();
      else if (item.session) {
        if (terminalCatalogScope !== terminalConnectionIdentity()) { void openTerminalSessions(); return; }
        if (!askUI.openTerminalSession(item.session)) {
          picker.status = askUI.unavailableReason || 'Connect Even Terminal in phone Settings.'; dirty = true;
        } else terminalListRequest?.abort();
      }
      return;
    }
    // A session list has no recording target until an owner is selected.
    if (['ask-release', 'ask-cancel'].includes(action)) { librarySyncHold = false; return; }
    if (['ask', 'ask-toggle'].includes(action)) return;
  }
  if (action === 'ask-hold' && picker) { librarySyncHold = true; startLibrarySync(); return; }
  if (librarySyncHold && ['ask-release', 'ask-cancel'].includes(action)) { librarySyncHold = false; return; }
  if (action === 'ask-hold' && positionPicker) {
    if (!positionPickerHold) positionPicker = togglePositionStep(positionPicker);
    positionPickerHold = true; dirty = true; return;
  }
  if (positionPickerHold && ['ask-release', 'ask-cancel'].includes(action)) { positionPickerHold = false; return; }
  if (askUI?.handle(action, source === 'glasses' ? 'glasses' : navigator.mediaDevices?.getUserMedia ? 'phone' : undefined)) return;
  if (action === 'footnotes') { toggleFootnotes(); return; }
  if (footnotesView && ['play', 'back'].includes(action)) { closeFootnotes(); return; }
  if (footnotesView && ['previous', 'next'].includes(action)) { move(action === 'next' ? 1 : -1); return; }
  if (footnotesView && ['mode', 'position', 'documents', 'start', 'autoplay'].includes(action)) closeFootnotes();
  if (action === 'mode') {
    if (!active) return;
    reader.pause(); picker = null; positionPicker = null;
    modePicker = { index: Math.max(0, READING_MODES.findIndex(mode => mode.value === reader.mode)) };
    dirty = true; return;
  }
  if (action === 'back') {
    reader.pause();
    if (positionPicker) { positionPicker = null; dirty = true; return; }
    if (picker && active) { picker = null; dirty = true; return; }
    if (active) {
      if (reader.mode !== 'page') { askUI.handle('ask-toggle'); return; }
      const previousId = active.id;
      selectDocument(null);
      picker = openDocumentPicker(libraryDocuments(), null, previousId);
      setLibraryOpen(true, false);
      dirty = true; return;
    }
    glasses.close(); return;
  }
  if (action === 'position') {
    if (!layout) return;
    reader.pause(); picker = null;
    positionPicker = positionPicker ? null : openNavigationPicker(layout, reader.y);
    if (positionPicker && positionPicker.kind !== 'contents' && reader.mode === 'speed') positionPicker = { ...positionPicker, percent: readingPercent(), max: 100 };
    updatePickerContext();
    dirty = true; return;
  }
  if (positionPicker && ['previous', 'next', 'play'].includes(action)) {
    if (action === 'play') {
      if (positionPicker.kind === 'contents') { jump(positionPicker.entries[positionPicker.index].y); renderControls(); }
      else seekPercent(positionPicker.percent);
    }
    else positionPicker = movePositionPicker(positionPicker, action === 'next' ? 1 : -1);
    updatePickerContext();
    dirty = true; return;
  }
  if (action === 'documents') {
    reader.pause(); positionPicker = null;
    picker = picker && active ? null : openDocumentPicker(libraryDocuments(), active?.id);
    dirty = true; return;
  }
  if (picker && ['previous', 'next', 'play'].includes(action)) {
    if (action === 'play') {
      const id = picker.items[picker.index]?.id;
      if (id === LIBRARIAN_ID) { openLibrarian(); return; }
      if (id === TERMINAL_SESSIONS_ID) { void openTerminalSessions(); return; }
      if (!id && !picker.canReturn) return;
      picker = null;
      if (id) { selectDocument(id); setLibraryOpen(false, false); }
    } else picker = moveDocumentPicker(picker, action === 'next' ? 1 : -1);
    dirty = true; return;
  }
  if (!active && ['start', 'autoplay', 'previous-page', 'next-page'].includes(action)) return;
  if (['start', 'autoplay'].includes(action)) { picker = null; positionPicker = null; modePicker = null; }
  if (action === 'previous' || action === 'next') {
    if (reader.mode !== 'page') setSpeed(steppedSpeed(action === 'previous' ? 1 : -1));
    else move(action === 'next' ? 1 : -1);
  }
  if (action === 'previous-page') move(-1);
  if (action === 'next-page') move(1);
  if (action === 'play' && layout?.preparation?.complete === false && reader.mode === 'speed' && reader.speedReading.finished) return;
  if (action === 'play') {
    if (reader.mode === 'page' && gesture) { askUI.handle('ask-toggle'); return; }
    useReadyPdfPages(); if (reader.mode !== 'page') reader.togglePlay(); else move(1);
  }
  if (action === 'autoplay') { useReadyPdfPages(); if (reader.mode !== 'auto') setMode('auto'); reader.togglePlay(); }
  if (action === 'start') seekPercent(0);
  if (action === 'end') seekPercent(100);
  if (['suspend', 'close', 'exit'].includes(action)) { reader.pause(); flushPosition(); }
  if (action === 'resume') { dirty = true; lastSentKey = ''; }
}

function closeFootnotes() {
  footnotesView = null; dirty = true; lastSentKey = ''; renderControls();
}
function toggleFootnotes() {
  if (footnotesView) { closeFootnotes(); return; }
  if (!layout) return;
  reader.pause(); picker = null; positionPicker = null; modePicker = null;
  footnotesView = { layout: pdfNotes, y: nearbyPdfNote(layout, pdfNotes, reader.y) };
  // The Reader itself is untouched: exact word cursor, gradual text entry,
  // saved position and mode survive this temporary, manually paged view.
  dirty = true; lastSentKey = ''; renderControls();
}

function updatePickerContext() {
  if (positionPicker && positionPicker.kind !== 'contents' && reader.mode === 'speed') {
    const entries = reader.speedReading.entries;
    positionPicker.y = entries[Math.round((entries.length - 1) * positionPicker.percent / 100)]?.y || 0;
  }
}

function documentsWithReadingCounts() {
  return (snapshot?.documents || []).map(doc => documentReadingWords(doc) == null && fetchedReadingWords.has(doc.sha256)
    ? { ...doc, readingWords: fetchedReadingWords.get(doc.sha256) } : doc);
}
function libraryDocuments() { return orderedDocuments(documentsWithReadingCounts(), preferences); }
function refreshDocumentPicker() {
  if (picker?.kind === 'terminal-sessions') return;
  if (!picker && active) return;
  picker = openDocumentPicker(libraryDocuments(), active?.id, picker?.items[picker.index]?.id);
  dirty = true; lastSentKey = '';
}

function empty(target, text) {
  const p = document.createElement('p'); p.className = 'empty'; p.textContent = text;
  target.replaceChildren(p);
}
function navigationButton(text, detail, onClick, query = '') {
  const button = document.createElement('button'); button.className = 'nav-item';
  const label = document.createElement('span');
  if (query) label.append(...searchSnippet(text, query)); else label.textContent = text;
  const small = document.createElement('small'); small.textContent = detail;
  button.append(label, small); button.onclick = onClick;
  return button;
}
// Search results show about 40 characters either side of the match, with the
// match emphasized, instead of a row that may start and end mid-word.
function searchSnippet(text, query, radius = 40) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const at = clean.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  if (at < 0) return [document.createTextNode(clean.length > radius * 2 ? `${clean.slice(0, radius * 2).trimEnd()}…` : clean)];
  let start = Math.max(0, at - radius), end = Math.min(clean.length, at + query.trim().length + radius);
  if (start > 0) { const space = clean.indexOf(' ', start); if (space > 0 && space < at) start = space + 1; }
  if (end < clean.length) { const space = clean.lastIndexOf(' ', end); if (space > at + query.trim().length) end = space; }
  const match = document.createElement('mark'); match.textContent = clean.slice(at, at + query.trim().length);
  return [document.createTextNode(`${start > 0 ? '…' : ''}${clean.slice(start, at)}`), match,
    document.createTextNode(end < clean.length ? `${clean.slice(at + query.trim().length, end).replace(/[\s.,;:…]+$/, '')}…` : clean.slice(at + query.trim().length, end))];
}
function renderLibraryAvailability() {
  $('library-sort').value = librarySort(preferences.librarySort);
  $('library-sort').disabled = !libraryReady;
  $('library-librarian').disabled = !libraryReady || !!askUI?.unavailableReason;
  $('library-sync').disabled = libraryBusy || !libraryReady;
  renderSyncSummary();
  $('import').disabled = libraryBusy || !libraryReady || !!store.readOnly;
  const status = $('library-storage-status'); status.hidden = !store.onDemand;
  if (store.onDemand) status.textContent = store.readOnly
    ? 'Even storage is unavailable. You can read from the desktop while connected. Imports, deletion and offline saves are paused until you reopen the app. Reading history will sync to the desktop when connected; keep this page open until it has synced.'
    : `Documents download when opened. Offline document cache: ${(store.cacheUsage / 1048576).toFixed(1)} / 32 MiB encoded data. Older desktop-backed copies are cleared automatically; unsynced imports are kept.`;
}
function renderDeleteStatus() {
  for (const button of $('documents').querySelectorAll('.document-delete, .delete-actions button')) button.disabled = libraryBusy || !!store.readOnly;
  const status = $('documents').querySelector('.delete-status');
  if (status) { status.textContent = deleteStatus; status.hidden = !deleteStatus; }
  const confirm = $('documents').querySelector('[data-confirm-delete]');
  if (confirm) confirm.textContent = deleting ? 'Deleting…' : 'Delete';
  const cancel = $('documents').querySelector('.delete-actions .secondary');
  if (cancel) cancel.textContent = deletionPending ? 'Close' : 'Cancel';
}
function renderLibrary() {
  renderLibraryEstimates(); renderLibraryAvailability();
  // Cache recovery can refresh the catalog during a deletion. Keep its touch
  // target mounted until the transaction finishes or the user can retry it.
  if (deleting && deleteId) { renderDeleteStatus(); return; }
  $('documents').replaceChildren();
  $('doc-count').textContent = String(snapshot?.documents.length || 0);
  if (!snapshot?.documents.length) return empty($('documents'), 'No documents yet.');
  const query = $('filter').value.toLocaleLowerCase().trim();
  const docs = libraryDocuments().filter(doc => `${doc.title} ${doc.id}`.toLocaleLowerCase().includes(query));
  if (!docs.length) return empty($('documents'), `No documents match “${$('filter').value.trim()}”.`);
  for (const doc of docs) {
    const current = active?.id === doc.id;
    const button = document.createElement('button'); button.className = 'document-card';
    button.setAttribute('aria-current', String(current));
    const format = doc.format === 'pdf' ? 'PDF' : /\.txt$/i.test(doc.id) ? 'TXT' : 'MD';
    const icon = document.createElement('span'); icon.className = 'file-icon'; icon.textContent = format; icon.setAttribute('aria-hidden', 'true');
    const description = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = doc.title;
    const info = document.createElement('small'); info.className = 'document-info';
    const saved = preferences.positions[doc.positionKey];
    const details = document.createElement('span'); details.className = 'document-details';
    details.textContent = [current ? 'Reading' : format, saved ? `${Math.round(saved.percent)}%` : null, doc.remote ? doc.availableOffline ? 'Offline' : 'On desktop' : null].filter(Boolean).join(' · ');
    const estimate = document.createElement('span'); estimate.className = 'document-reading-time';
    info.append(details, estimate);
    const file = document.createElement('small'); file.className = 'file-name'; file.textContent = doc.id;
    description.append(title, info); if (doc.id !== doc.title) description.append(file);
    if (saved?.percent > 0) {
      const bar = document.createElement('span'); bar.className = 'doc-progress'; bar.setAttribute('aria-hidden', 'true');
      const fill = document.createElement('span'); fill.style.width = `${Math.min(100, saved.percent)}%`; bar.append(fill);
      description.append(bar);
    }
    button.append(icon, description);
    button.onclick = () => openFromPhone(doc.id);
    const entry = document.createElement('div'); entry.className = 'document-entry'; entry.dataset.documentId = doc.id;
    entry.append(button);
    if (deleteId === doc.id) {
      entry.classList.add('confirming');
      const confirm = document.createElement('div'); confirm.className = 'delete-confirm';
      const label = document.createElement('p'); label.className = 'delete-question';
      const question = document.createElement('strong'); question.textContent = `Delete ${doc.id} from Pageborne?`;
      const detail = document.createElement('span'); detail.textContent = doc.remote || Object.values(preferences.librarySync || {}).some(state => state.files?.[doc.id])
        ? 'Its position and bookmarks go too. Next sync removes the desktop copy; a recoverable version stays in desktop history.'
        : 'Its position and bookmarks go too. Your original file stays where it is.';
      label.append(question, detail);
      const cancel = document.createElement('button'); cancel.className = 'secondary'; cancel.textContent = 'Cancel'; cancel.disabled = libraryBusy;
      cancel.onclick = () => { deleteId = null; renderLibrary(); $('documents').querySelector(`[data-document-id="${CSS.escape(doc.id)}"] .document-delete`)?.focus(); };
      const yes = document.createElement('button'); yes.className = 'danger-button'; yes.textContent = 'Delete';
      yes.dataset.confirmDelete = doc.id; yes.disabled = libraryBusy;
      yes.onclick = () => deleteDocument(doc.id);
      const actions = document.createElement('div'); actions.className = 'delete-actions'; actions.append(cancel, yes);
      const status = document.createElement('p'); status.className = 'delete-status'; status.setAttribute('role', 'status');
      confirm.append(label, actions, status); entry.append(confirm);
    } else {
      const remove = document.createElement('button'); remove.className = 'document-delete';
      remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3.5 5h11M7 5V3.5h4V5M5 5l.7 9.5h6.6L13 5"/></svg>';
      remove.setAttribute('aria-label', `Delete ${doc.id}`); remove.disabled = libraryBusy || !!store.readOnly;
      remove.onclick = () => { reader.pause(); deleteId = doc.id; deleteStatus = ''; deletionPending = false; renderLibrary(); $('documents').querySelector('[data-confirm-delete]')?.focus({ preventScroll: true }); };
      entry.append(remove);
    }
    $('documents').append(entry);
  }
  renderLibraryEstimates(); renderDeleteStatus();
}
function renderLibraryEstimates() {
  const average = averageReadingSpeed(readingLog?.entries), documents = documentsWithReadingCounts();
  const byId = new Map(documents.map(doc => [doc.id, doc]));
  for (const entry of $('documents').children) {
    const doc = byId.get(entry.dataset.documentId), estimate = entry.querySelector('.document-reading-time');
    if (!doc || !estimate) continue;
    const words = documentReadingWords(doc), duration = readingDuration(words, average);
    estimate.textContent = duration;
    estimate.title = words == null ? 'Reading time available once PDF text is prepared and synced.' : `${duration} for the full text · ${readingSpeedLabel(average)}`;
    estimate.setAttribute('aria-label', estimate.title);
  }
  const total = libraryReadingEstimate(documents, average);
  $('library-reading-time').textContent = `${total.duration}${total.unknown && total.duration !== '—' ? '+' : ''}`;
  const config = readerConnection(), activity = snapshot?.libraryActivity?.endpoint === config.endpoint ? snapshot.libraryActivity : null;
  const clearance = libraryClearance({ documents, entries: readingLog?.entries, activity,
    removals: snapshot?.libraryRemovals, scope: config.chatScope || '', endpoint: config.endpoint });
  $('library-clearance-days').textContent = clearance.days == null ? '— days' : `${clearance.days === 0 ? '0' : '~' + Math.max(1, Math.ceil(clearance.days)).toLocaleString()} days`;
  const ratio = clearance.ratio == null ? clearance.available && clearance.addedWords > 0 && !clearance.clearedWords
    && !clearance.missingAdded && !clearance.missingDeleted ? 'no clearance yet' : '—' : clearance.ratio.toFixed(2);
  $('library-clearance-ratio').textContent = `Additions / clearance: ${ratio}`;
  $('library-clearance-rate').textContent = clearance.available
    ? `${Math.round(clearance.wordsPerDay).toLocaleString()} words cleared/day · last 14 days${clearance.preliminary ? ' · preliminary' : ''}${clearance.pending ? ' · deletions pending sync' : ''}`
    : 'Sync to load library clearance history.';
  $('library-clearance-detail').textContent = `Last 14 days: ${Math.round(clearance.readWords).toLocaleString()} words read from texts not deleted, plus ${clearance.deletedWords.toLocaleString()} words in deleted texts. ${clearance.addedWords.toLocaleString()} words added.`
    + (clearance.missingAdded + clearance.missingDeleted + clearance.missingCurrent ? ' Some word counts are missing; affected estimates are unavailable.' : '')
    + (activity && clearance.preliminary ? ` Deletion tracking began ${new Date(activity.startedAt).toLocaleDateString()}; earlier deletions are unavailable. The daily rate always divides by 14 while history builds up.` : '');
  $('library-reading-speed').textContent = readingSpeedLabel(average);
  const combined = averageReadingSpeed(readingLog?.entries, { includeAsk: true });
  $('library-reading-combined-speed').textContent = `Including Ask: ${combined == null ? 'no reading logged yet' : `${Math.round(combined).toLocaleString()} wpm`}`;
  $('library-reading-pending').hidden = !total.unknown;
  $('library-reading-pending').textContent = readingCountsRefresh ? 'Checking desktop word counts…'
    : `${total.unknown} ${total.unknown === 1 ? 'document awaits' : 'documents await'} a word count. Connect to the desktop or open the document to update its reading time.`;
  diagnostics.library = { documents: documents.length, missingWordCounts: total.unknown, refreshingWordCounts: !!readingCountsRefresh, onDemand: !!store.onDemand, readOnly: !!store.readOnly, cachedCharacters: store.cacheUsage, storageHealth: store.kv?.health };
}
async function refreshReadingCounts() {
  if (!libraryReady || libraryBusy || readingCountsRefresh || Date.now() - readingCountsAttempt < 60000
    || !snapshot.documents.some(doc => doc.format === 'pdf' && documentReadingWords(doc) == null && !fetchedReadingWords.has(doc.sha256))) return;
  const config = askUI.readConfig();
  if (connectionMode(config) !== 'terminal' || !config.endpoint) return;
  const target = store; readingCountsAttempt = Date.now();
  readingCountsRefresh = (async () => {
    const remote = await desktopLibrary(new EvenTerminal(config, askUI.options()));
    if (store !== target || libraryBusy) return;
    const updates = preparedWordUpdates(snapshot, remote);
    // Still show verified counts if the native store refuses persistence.
    // The digest prevents counts surviving a replacement with different bytes.
    for (const update of updates) fetchedReadingWords.set(update.expected.sha256, update.readingWords);
    readingCountsChanged();
    if (updates.length) {
      const result = await target.updateMetadata(updates); snapshot = result.snapshot;
      diagnostics.log('library-word-counts', { updated: updates.length });
    }
  })().catch(error => diagnostics.error('library-word-count-error', error, { code: error.code, storage: error.storage }))
    .finally(() => { readingCountsRefresh = null; renderLibraryEstimates(); });
  renderLibraryEstimates();
  return readingCountsRefresh;
}
let libraryActivityRefresh = null;
async function refreshLibraryActivity(force = false) {
  if (!libraryReady || libraryActivityRefresh || libraryBusy && !force) return;
  const config = readerConnection(), target = store;
  if (connectionMode(config) !== 'terminal' || !config.endpoint) return;
  libraryActivityRefresh = (async () => {
    const client = new EvenTerminal(config, askUI.options());
    let activity = await client.api('pageborne/library/activity');
    if (!validLibraryActivity(activity)) throw Error('Invalid library activity.');
    if (target !== store || readerConnection().endpoint !== config.endpoint) return;
    const removals = (snapshot.libraryRemovals || []).filter(event => (!event.endpoint || event.endpoint === config.endpoint)
      && (!event.libraryId || event.libraryId === activity.libraryId)
      && !activity.events.some(saved => saved.operationId === event.id));
    for (let offset = 0; offset < removals.length; offset += 1000) {
      activity = await client.api('pageborne/library/activity', { body: { removals: removals.slice(offset, offset + 1000) } });
    }
    if (!validLibraryActivity(activity)) throw Error('Invalid library activity.');
    if (target !== store || readerConnection().endpoint !== config.endpoint) return;
    const value = { ...activity, endpoint: config.endpoint };
    if (JSON.stringify(snapshot.libraryActivity) === JSON.stringify(value)) return;
    snapshot = { ...snapshot, libraryActivity: value };
    if (!target.readOnly) {
      try { snapshot = (await target.saveLibraryActivity(value)).snapshot; }
      catch (error) { diagnostics.error('library-activity-cache-error', error); }
    }
  })().catch(error => { if (error.status !== 404) diagnostics.error('library-activity-error', error); })
    .finally(() => { libraryActivityRefresh = null; renderLibraryEstimates(); });
  return libraryActivityRefresh;
}
function readingLogChanged() { readingHistory.render(); renderLibraryEstimates(); }
function readingCountsChanged() {
  if (librarySort(preferences.librarySort) === 'time') { renderLibrary(); refreshDocumentPicker(); }
  else renderLibraryEstimates();
}
async function cacheReadingWords(doc, words) {
  if (words == null || doc.readingWords === words || !store.updateMetadata) return;
  try {
    const result = await store.updateMetadata([{ id: doc.id, expected: doc, readingWords: words }]);
    snapshot = result.snapshot;
    if (active?.id === doc.id && active.revision === doc.revision) active.readingWords = words;
    readingCountsChanged();
  } catch (error) { diagnostics.error('reading-estimate-save-error', error); }
}
function openFromPhone(id) {
  selectDocument(id);
  setLibraryOpen(false);
}
const drawerQuery = matchMedia('(max-width: 999px)');
let settingsTrigger = null;
function setLibraryOpen(open, focus = true) {
  if (open) void refreshReadingCounts();
  if (open) { previewInput?.cancel(); fullscreenReader?.exit(); }
  const drawer = drawerQuery.matches;
  const shown = drawer ? open : true;
  $('library-panel').dataset.open = String(shown);
  if (shown && (open || !drawer)) { failedSeen = imports.jobs.filter(job => job.phase === 'failed').length; renderImports(imports.jobs); }
  const returnToSettings = !open && !$('shared-settings').hidden && settingsTrigger === $('reader-settings-toggle');
  if (drawer && !open && !$('shared-settings').hidden) setSettingsOpen(false, false);
  $('library-toggle').setAttribute('aria-expanded', String(shown));
  $('library-scrim').hidden = !(drawer && open);
  document.body.classList.toggle('library-open', drawer && open);
  // The dock remains usable while the drawer covers the reader. Keep covered
  // controls out of keyboard/VoiceOver navigation and notices in view.
  if (drawer && open) $('library-body').before($('notice'));
  else document.querySelector('.navigation-tabs').before($('notice'));
  for (const section of document.querySelector('.reader-content').children) section.inert = drawer && open;
  if (!drawer || !focus) return;
  if (open) $('library-heading').focus({ preventScroll: true });
  else if (returnToSettings || $('library-panel').contains(document.activeElement)) $(returnToSettings ? 'reader-settings-toggle' : 'library-toggle').focus({ preventScroll: true });
}
new ResizeObserver(() => document.documentElement.style.setProperty('--dock-height', `${$('reader-controls').offsetHeight}px`)).observe($('reader-controls'));
$('library-toggle').onclick = () => setLibraryOpen($('library-panel').dataset.open !== 'true');
// Shared settings can be opened directly from the reader or from the library.
function setSettingsOpen(open, focus = true, trigger = $('settings-toggle')) {
  if (open) fullscreenReader?.exit();
  if (open && $('shared-settings').hidden) settingsTrigger = trigger;
  if (!open) {
    askUI?.cancelPairing();
  }
  if (open && $('library-panel').dataset.open !== 'true') setLibraryOpen(true, false);
  $('shared-settings').hidden = !open; $('library-body').hidden = open;
  if (open) renderSettingsSummaries();
  for (const id of ['settings-toggle', 'reader-settings-toggle']) $(id).setAttribute('aria-expanded', String(open));
  const returnTo = settingsTrigger || $('settings-toggle');
  if (!open) {
    settingsTrigger = null;
    if (returnTo === $('reader-settings-toggle') && drawerQuery.matches && $('library-panel').dataset.open === 'true') setLibraryOpen(false, false);
  }
  if (!focus) return;
  if (open) { $('shared-settings').scrollIntoView({ block: 'start' }); $('settings-heading').focus({ preventScroll: true }); }
  else returnTo.focus({ preventScroll: true });
}
$('settings-toggle').onclick = () => setSettingsOpen($('shared-settings').hidden);
$('reader-settings-toggle').onclick = () => setSettingsOpen($('shared-settings').hidden, true, $('reader-settings-toggle'));
$('settings-done').onclick = () => setSettingsOpen(false);
let terminalCatalog = [], terminalCatalogScope = '', terminalListRequest;
const terminalConnectionIdentity = () => {
  const config = readerConnection();
  return JSON.stringify([config.endpoint, config.chatScope, config.token]);
};
function returnFromTerminalSessions() {
  terminalListRequest?.abort(); terminalListRequest = null;
  picker = openDocumentPicker(libraryDocuments(), active?.id, TERMINAL_SESSIONS_ID);
  dirty = true; renderControls();
}
async function openTerminalSessions(selected) {
  if (!libraryReady || askUI.speech.setup.blocked) return;
  terminalListRequest?.abort();
  const request = new AbortController(); terminalListRequest = request;
  const connection = terminalConnectionIdentity();
  if (terminalCatalogScope !== connection) { terminalCatalog = []; terminalCatalogScope = connection; }
  reader.pause(); askUI.close(); positionPicker = null; modePicker = null;
  setLibraryOpen(false, false);
  picker = { ...terminalSessionPicker(terminalCatalog, selected, 'Loading sessions…'), request };
  dirty = true; renderControls();
  try {
    const config = readerConnection();
    if (connectionMode(config) !== 'terminal' || !config.endpoint) throw new Error('connection');
    const result = await listTerminalSessions(provider => new EvenTerminal({ ...config, agent: provider }, askUI.options()), request.signal);
    if (picker?.request !== request) return;
    if (terminalConnectionIdentity() !== connection) {
      picker = { ...terminalSessionPicker([], 'refresh', 'Connection changed. Tap Refresh to reload.'), request }; return;
    }
    const highlighted = picker.items[picker.index]?.id || picker.items[picker.index]?.action;
    terminalCatalog = result.sessions;
    picker = { ...terminalSessionPicker(terminalCatalog, highlighted, result.warnings.join(' · ')), request };
  } catch {
    if (picker?.request === request) picker = { ...picker, status: 'Check desktop connection. Tap Refresh to retry.' };
  } finally { if (picker?.request === request) { dirty = true; renderControls(); } }
}
function openLibrarian() {
  if (!libraryReady || askUI.speech.setup.blocked) return;
  setLibraryOpen(false, false);
  askUI.openLibrarian();
  renderControls();
}
$('library-librarian').onclick = openLibrarian;
$('library-close').onclick = () => setLibraryOpen(false);
$('library-scrim').onclick = () => setLibraryOpen(false);
drawerQuery.addEventListener('change', () => setLibraryOpen(!active, false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('value-dialog').open && !$('debug-dialog')?.open && drawerQuery.matches && $('library-panel').dataset.open === 'true') { event.preventDefault(); setLibraryOpen(false); }
});
function buildLayout() { layout = nativeLayout(parseDocument(active.content), 0); }
async function trackPdfPreparation(work) {
  // Cancellation may overlap a new selection. Keep Ask blocked until every
  // outstanding preparation has settled and released its working memory.
  const preparation = {}; pdfPreparations.add(preparation);
  try {
    dirty = true; renderControls();
    return await work();
  }
  finally {
    pdfPreparations.delete(preparation);
    dirty = true; renderControls();
  }
}

async function selectDocument(id, save = true) {
  readingTracker.leave(); readingLayout = null;
  documentLoadController?.abort();
  documentLoadController = null;
  previewInput?.cancel(); previewMenu = null;
  askUI?.close();
  if ($('value-dialog').open) $('value-dialog').close();
  picker = null; positionPicker = null; modePicker = null;
  if (save) rememberPosition();
  footnotesView = null; pdfNotes = null;
  const version = ++selectionVersion;
  pendingPdfPosition = null;
  notice('');
  diagnostics.log('select-document', { selection: version });
  pdfRendering?.controller?.abort(); pdfProgressRefresh = null;
  pdfDocument?.destroy().catch(() => {}); pdfDocument = null; pdfBitmap = null; pdfOpenMessage = null; pdfRendering = false;
  pdfPassage.setLayout(null, 0);
  pdfGallery.setLayout(null);
  pdfAnnotations.setLayout(null);
  active = snapshot?.documents.find(d => d.id === id) || null;
  diagnostics.renderer = active?.format === 'pdf' ? 'pdf-image' : 'native-text';
  layout = null;
  if (active) {
    if (save) recordDocumentOpen(preferences, active.id);
    $('title').textContent = active.title; $('doc-path').textContent = active.id;
    if (typeof active.content !== 'string') {
      const controller = new AbortController(), selected = active; documentLoadController = controller;
      reader.setDocument(0); passage.setLayout(null, 0);
      pdfOpenMessage = { body: 'Opening document…', status: 'Loading', kind: 'loading' };
      notice('Opening document…'); lastPassage = -1; lastSentKey = ''; dirty = true;
      renderLibrary(); renderOutline(); renderBookmarks(); renderControls();
      try {
        const document = await trackPdfPreparation(async () => {
          controller.signal.throwIfAborted();
          return store.loadDocument(selected, { signal: controller.signal, backgroundCache: true, progress: text => { if (version === selectionVersion) notice(text); } });
        });
        if (version !== selectionVersion) return;
        active = document; if (store.onDemand) snapshot = store.snapshot; pdfOpenMessage = null; notice('');
      } catch (error) {
        if (version !== selectionVersion || controller.signal.aborted) return;
        notice(`Could not open document: ${storageMessage(error)}`, true);
        pdfOpenMessage = { body: 'Could not open document.\nOpen the phone app for details.\nDouble tap to choose another file.', status: 'File error', kind: 'error' };
        dirty = true; renderControls(); return;
      } finally { if (documentLoadController === controller) documentLoadController = null; }
    }
    if (active.format === 'pdf') {
      reader.setDocument(0); notice('Opening PDF…');
      pdfOpenMessage = { body: 'Opening PDF…', status: 'Loading', kind: 'loading' };
      const ocrConfig = askUI.readConfig();
      let ocrClient = null;
      try {
        if (connectionMode(ocrConfig) === 'terminal' && ocrConfig.endpoint)
          ocrClient = new EvenTerminal(ocrConfig, { ...askUI.options(), diagnostics: undefined });
      } catch { /* An incomplete optional connection must not prevent reading. */ }
      try {
        await trackPdfPreparation(async () => { PdfDocument ||= (await import('./pdf.js')).PdfDocument; });
      } catch (error) {
        if (version === selectionVersion) { notice(`Could not load PDF reader: ${error.message}`, true); pdfOpenMessage = { body: 'Could not load PDF reader.\nReopen the document to retry.', status: 'PDF error', kind: 'error' }; dirty = true; }
        return;
      }
      if (version !== selectionVersion) return;
      pdfDocument = new PdfDocument({ diagnostics, selection: version,
        preparationCache: desktopPdfCache(pdfPreparationCache.forDocument(active.id), ocrClient, active.id, () => version === selectionVersion) }); const opening = pdfDocument;
      const { mode, keepMarginNotes, keepRepeatedText, normalizeColors, reflow, textSize } = pdfSettingsFor(preferences, documentKey());
      $('pdf-layout').value = mode;
      $('pdf-margin-notes').checked = keepMarginNotes;
      $('pdf-repeated-text').checked = keepRepeatedText;
      $('pdf-colors').checked = normalizeColors;
      $('pdf-default-status').textContent = '';
      $('pdf-reflow').checked = reflow; $('pdf-text-size').value = String(textSize);
      $('pdf-text-size-control').hidden = !reflow;
      const savedPosition = preferences.positions[documentKey()];
      let progressText = 'Opening PDF…'; let progressAt = 0;
      pdfProgressRefresh = (force = false) => {
        if (version !== selectionVersion || !force && performance.now() - progressAt < 500) return;
        progressAt = performance.now();
        if (layout?.preparation?.complete === false) {
          const { readyPages, totalPages } = layout.preparation;
          notice(`${readyPages} of ${totalPages} PDF pages ready. ${progressText} ${pendingPdfPosition
            ? `Preparing your saved place on page ${pendingPdfPosition.pdf.page}. Start reading or choose a position to stay in the ready pages.`
            : 'You can read now.'} Position and reading time cover the ready pages.`);
        } else if (!layout) {
          notice(progressText); pdfOpenMessage = { body: progressText, status: 'Loading PDF', kind: 'loading' }; dirty = true;
        }
      };
      const acceptLayout = result => {
        if (version !== selectionVersion) return;
        // Show ready pages even when the saved place is farther ahead. Keep
        // that save until it is ready, unless the reader chooses to move/play.
        if (!layout && result.preparation?.complete === false
          && savedPosition?.pdf?.page > result.preparation.readyPages) pendingPdfPosition = savedPosition;
        const resume = pendingPdfPosition && (result.preparation?.complete !== false
          || pendingPdfPosition.pdf.page <= result.preparation.readyPages) ? pendingPdfPosition : null;
        result.document = opening;
        const measuring = document.createElement('canvas').getContext('2d');
        const views = pdfReadingViews(result, { measure: (text, size) => {
          measuring.font = `${size}px sans-serif`;
          return Math.max(measuring.measureText(text).width, measureNativeText(text) * 552 / 544);
        } });
        const previous = layout;
        layout = views.body; pdfNotes = views.notes; pdfOpenMessage = null;
        if (reflow && result.preparation?.complete !== false) void cacheReadingWords(active, preparedReadingWords(result));
        positionPicker = refreshNavigationPicker(positionPicker, layout);
        updatePdfReader(reader, resume ? null : previous, layout, resume || (pendingPdfPosition ? null : savedPosition), preferences.pdfEntryLines);
        if (resume) pendingPdfPosition = null;
        if (footnotesView) {
          const note = footnotesView.layout && pdfAnchor(footnotesView.layout, footnotesView.y);
          footnotesView = { layout: pdfNotes, y: pdfNotes ? restorePdfAnchor(pdfNotes, note) : 0 };
        }
        lastPassage = -1; lastSentKey = '';
        if (layout.preparation?.complete === false) pdfProgressRefresh?.(true);
        else { pdfProgressRefresh = null; notice(opening.warnings.join(' ')); }
        renderOutline(); renderBookmarks(); renderControls(); rememberPosition(); dirty = true;
        animate(performance.now(), true);
      };
      const content = active.content;
      // Closing Ask cancelled recording above. Give PDF reflow the memory held
      // by idle speech workers; their saved checks/weights survive this release.
      void trackPdfPreparation(() => askUI.speech.releaseForReading().then(() => opening.open(content, mode, text => {
        if (version !== selectionVersion) return;
        progressText = text; pdfProgressRefresh?.();
      }, { keepMarginNotes, keepRepeatedText, normalizeColors, reflow, textSize, onPartial: acceptLayout })).then(acceptLayout).catch(async error => {
        if (error !== opening.openError) opening.report('pdf-open-error', error);
        if (!layout || version !== selectionVersion) await opening.destroy().catch(() => {});
        else await opening.ocr?.destroy().catch(() => {});
        if (version === selectionVersion) {
          pdfProgressRefresh = null;
          if (layout) {
            layout.preparation = { ...layout.preparation, failed: true };
            reader.pause(); lastSentKey = ''; dirty = true;
            notice(`The remaining PDF pages could not be prepared: ${error.message}. You can read the pages already ready. Reopen the document to retry.`, true);
            renderControls(); animate(performance.now(), true); return;
          }
          notice(`Could not open PDF: ${error.message}`, true);
          pdfOpenMessage = { body: 'Could not open PDF.\nOpen the phone app for details.\nDouble tap to choose another file.', status: 'PDF error', kind: 'error' };
          dirty = true; renderControls(); animate(performance.now(), true);
        }
      }));
    } else {
      let entries;
      if (active.content.length > 100000) {
        const controller = new AbortController(); documentLoadController = controller;
        reader.setDocument(0); pdfOpenMessage = { body: 'Preparing text…', status: 'Loading', kind: 'loading' };
        notice('Preparing text…'); dirty = true;
        try {
          const prepared = await trackPdfPreparation(() => prepareTextInBackground(active.content, controller.signal, stage => {
            if (version === selectionVersion) { notice(stage); pdfOpenMessage.body = stage; dirty = true; }
          }));
          if (version !== selectionVersion) return;
          layout = prepared.layout; entries = prepared.entries; pdfOpenMessage = null; notice('');
        } catch (error) {
          if (version !== selectionVersion || controller.signal.aborted) return;
          diagnostics.error('text-open-error', error); notice(`Could not prepare text: ${error.message}`, true);
          pdfOpenMessage = { body: 'Could not prepare text. Reopen the document to retry.', status: 'File error', kind: 'error' }; dirty = true; return;
        } finally { if (documentLoadController === controller) documentLoadController = null; }
      } else buildLayout();
      void cacheReadingWords(active, layout.blocks.reduce((sum, block) => sum + readingWords(block.text), 0));
      reader.setDocument(layout.maxY, restorePosition(preferences.positions[documentKey()]), layout.pages,
        (y, direction) => pageTurnY(layout, y, direction));
      reader.setSpeedDocument(layout, preferences.positions[documentKey()]?.speedCursor, entries);
    }
  } else {
    delete preferences.selected;
    picker = openDocumentPicker(libraryDocuments());
    reader.setDocument(0); $('title').textContent = 'Choose something good.';
    $('doc-path').textContent = 'Select a document from your library.';
  }
  $('search').value = ''; $('search-results').replaceChildren(); searchIndex = -1; $('search-step').hidden = true;
  $('preview').setAttribute('aria-label', active ? `Glasses preview: ${active.title}` : 'Choose a document to preview it on your glasses');
  lastPassage = -1; lastSentKey = '';
  renderLibrary(); renderOutline(); renderBookmarks(); renderControls();
  rememberPosition(); phonePreferences?.flush();
}
function jumpHeading(heading) {
  diagnostics.log('heading-jump', { index: heading.index }); jump(heading.y ?? layout.blockY[heading.index]);
}
// Headings (or PDF pages) and bookmarks as ticks on the position slider. Speed
// read positions follow its word sequence, so ticks are hidden in that mode.
function renderLandmarks() {
  const box = $('position-landmarks'); box.replaceChildren();
  if (!layout?.maxY) return;
  const place = (percent, kind) => {
    const tick = document.createElement('span'); tick.className = `landmark ${kind}`;
    tick.style.left = `calc(14px + (100% - 28px) * ${Math.min(1, Math.max(0, percent / 100))})`; box.append(tick);
  };
  const headings = navigationHeadings().filter(heading => heading.level <= 2 || layout.format === 'pdf');
  const every = Math.max(1, Math.ceil(headings.length / 60));
  headings.forEach((heading, i) => { if (i % every === 0) place((heading.y ?? layout.blockY[heading.index]) / layout.maxY * 100, 'heading'); });
  for (const mark of preferences.bookmarks[documentKey()] || []) place(restorePosition(mark) / layout.maxY * 100, 'mark');
}
function navigationHeadings() {
  const entries = documentContents(layout);
  return entries.length ? entries.map(entry => ({ ...entry, text: entry.title })) : layout?.headings || [];
}
function headingAt(y) {
  let found = null;
  for (const heading of navigationHeadings()) { if ((heading.y ?? layout.blockY[heading.index]) <= y + .5) found = heading; else break; }
  return found;
}
function renderOutline() {
  $('outline').replaceChildren();
  renderLandmarks();
  if (!navigationHeadings().length) return empty($('outline'), active ? 'No headings in this document. Use Search or the position slider to jump.' : 'Select a document to see its contents.');
  for (const heading of navigationHeadings()) {
    const y = heading.y ?? layout.blockY[heading.index];
    const button = navigationButton(heading.text, `${Math.round(Math.min(1, y / (layout.maxY || 1)) * 100)}%`, () => jumpHeading(heading));
    button.style.paddingLeft = `${8 + (heading.level - 1) * 12}px`;
    $('outline').append(button);
  }
}
function renderBookmarks() {
  $('bookmarks').replaceChildren();
  const marks = preferences.bookmarks[documentKey()] || [];
  $('bookmark-count').textContent = active && marks.length ? ` ${marks.length}` : '';
  renderLandmarks();
  if (!active || !marks.length) return empty($('bookmarks'), active ? 'Save your current position to return to it later.' : 'Open a document to add bookmarks.');
  marks.forEach((mark, i) => {
    const row = document.createElement('div'); row.className = 'bookmark-row';
    row.append(navigationButton(mark.heading || mark.text.slice(0, 60), `${Math.round(mark.percent)}%`, () => {
      if (layout) { jump(restorePosition(mark)); reader.restoreWords(mark.speedCursor); }
    }));
    if (layout?.preparation?.complete === false && mark.pdf?.page > layout.preparation.readyPages) {
      row.firstChild.disabled = true; row.firstChild.title = 'This PDF page is still preparing.';
    }
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Remove bookmark ${i + 1}`);
    remove.onclick = () => { marks.splice(i, 1); savePreferences(); renderBookmarks(); };
    row.append(remove); $('bookmarks').append(row);
  });
}
function renderPassage() {
  pdfGallery.setLayout(layout?.format === 'pdf' ? layout : null);
  pdfAnnotations.setLayout(layout?.format === 'pdf' ? layout : null);
  if (layout?.format === 'pdf') { passage.setLayout(null, 0); pdfPassage.setLayout(layout, reader.y); }
  else { passage.setLayout(layout, reader.y); pdfPassage.setLayout(null, 0); }
  lastPassage = layout ? rowAt(layout, reader.y) : -1;
  renderFollow();
}
function renderControls() {
  const micAvailable = !!navigator.mediaDevices?.getUserMedia && !!globalThis.AudioWorkletNode;
  $('preview-speak').hidden = !micAvailable;
  $('preview-speak').disabled = !libraryReady || (!active && !askUI.session.active) || pdfPreparations.size > 0 || !!askUI.speech.setup.blocked;
  $('preview-speak').textContent = pdfPreparations.size ? 'Document loading' : ['starting', 'listening'].includes(askUI.session.status) ? 'Release to review' : 'Hold to talk';

  const pdf = active?.format === 'pdf';
  const speedMode = reader.mode === 'speed';
  const rate = speedMode ? reader.speedReading.rate : reader.speed;
  const group = reader.speedReading.current;
  $('tab-pdf').hidden = !pdf; if (!pdf && activeTab === 'pdf') showTab(null);

  $('passage').hidden = pdf; $('pdf-passage').hidden = !pdf;
  renderFollow();
  $('auto-note').textContent = pdf ? 'Text advances a line at a time, figures in small steps. Jumping pauses.' : 'Advances one line at a time. Jumping pauses.';
  $('mode-page').setAttribute('aria-pressed', String(reader.mode === 'page'));
  $('mode-auto').setAttribute('aria-pressed', String(reader.mode === 'auto'));
  $('mode-speed').setAttribute('aria-pressed', String(speedMode));
  $('speed-control').hidden = reader.mode === 'page';
  $('word-group-control').hidden = !speedMode;
  $('pdf-footnotes').hidden = !pdf;
  $('pdf-footnotes').disabled = !layout;
  $('pdf-footnotes').textContent = footnotesView ? 'Back to reading' : 'Footnotes';
  $('pause-at-titles').checked = reader.pauseAtTitles;
  $('word-group-value').textContent = `${reader.speedReading.count} word${reader.speedReading.count === 1 ? '' : 's'}`;
  $('word-group').value = String(reader.speedReading.count);
  $('entry-lines').value = String(preferences.pdfEntryLines);
  $('entry-lines-value').textContent = preferences.pdfEntryLines === 9 ? 'Full screen' : `${preferences.pdfEntryLines} line${preferences.pdfEntryLines === 1 ? '' : 's'}`;
  $('entry-lines-value').setAttribute('aria-label', `${preferences.pdfEntryLines} initial lines after images. Enter line count`);
  if (!draggingRanges.has($('speed'))) $('speed').value = String(speedMode ? wordSpeedToSlider(rate) : speedToSlider(rate));
  $('speed').setAttribute('aria-label', speedMode ? 'Speed reading rate' : 'Autoscroll speed');
  $('speed').setAttribute('aria-valuetext', `${rate} ${speedMode ? 'words' : pdf ? 'steps' : 'lines'} per minute`);
  $('speed-value').textContent = `${rate} ${speedMode ? 'wpm' : pdf ? 'steps/min' : 'l/min'}`;
  $('speed-value').setAttribute('aria-label', `${rate} ${speedMode ? 'words' : pdf ? 'steps' : 'lines'} per minute. Enter speed`);
  $('speed-value').title = speedMode ? 'Enter words per minute' : 'Enter an autoscroll rate';
  $('play').textContent = positionPicker ? 'Read from here' : reader.mode === 'page' ? 'Next page' : reader.playing ? 'Pause'
    : speedMode ? reader.speedReading.finished ? 'Restart' : reader.wordStop ? 'Continue' : 'Start speed reading' : 'Start autoscroll';
  $('preview').setAttribute('aria-label', picker ? `${picker.kind === 'terminal-sessions' ? 'Even Terminal sessions' : 'Choose document'}: ${picker.items[picker.index]?.title || 'No saved documents'}`
    : positionPicker ? positionPicker.kind === 'contents' ? `Contents: ${positionPicker.entries[positionPicker.index].title}` : `Choose reading position: ${positionPicker.percent}%`
    : active ? `Glasses preview: ${active.title}` : 'Choose a document to preview it on your glasses');
  if (speedMode) $('auto-note').textContent = `Centered word groups. Titles ${reader.pauseAtTitles ? 'wait for a tap' : 'show at half speed'}; figures wait for a tap. Jumping pauses.`;
  else if (pdf && reader.mode === 'auto') $('auto-note').textContent = `After an image, text ${preferences.pdfEntryLines === 9 ? 'returns as a full screen' : `starts with ${preferences.pdfEntryLines} line${preferences.pdfEntryLines === 1 ? '' : 's'}`} (Settings). Jumping pauses.`;
  $('auto-note').hidden = reader.mode === 'page';
  $('gesture-note').textContent = gestureHelp({ mode: reader.mode, view: picker || positionPicker ? 'picker' : 'reader', documentPicker: !!picker, positionStep: positionPicker?.step, contents: positionPicker?.kind === 'contents' });
  if (layout?.preparation?.complete === false && !reader.playing
    && (speedMode ? reader.speedReading.finished : !reader.canAutoAdvance)) {
    $('play').textContent = layout.preparation.failed ? 'Ready pages finished' : 'More pages preparing…';
  }
  $('play').setAttribute('aria-pressed', String(reader.playing));
  const modeName = READING_MODES.find(mode => mode.value === reader.mode)?.label;
  const pace = reader.mode === 'page' ? '' : reader.mode === 'auto' ? `${rate} ${pdf ? 'steps' : 'lines'}/min` : `${rate} wpm`;
  const summary = footnotesView ? 'Footnotes' : modeName;
  const shortPace = footnotesView ? '' : pace.replace('lines/min', 'l/min').replace('steps/min', 'steps/m');
  if ($('dock-summary').textContent !== summary) $('dock-summary').textContent = summary;
  if ($('dock-pace').textContent !== shortPace) $('dock-pace').textContent = shortPace;
  $('dock-toggle').setAttribute('aria-label', `Reading mode: ${footnotesView ? 'Footnotes' : modeName}. Change mode`);
  $('pace-toggle').setAttribute('aria-label', `Pace: ${pace.replace('/min', ' per minute')}. Pace controls`);
  // Narrow phones share the transport row with the pace button; the play
  // button then shows a short label while keeping its full accessible name.
  const shortPlay = { 'Start autoscroll': 'Start', 'Start speed reading': 'Start', Pause: 'Pause', Continue: 'Continue', Restart: 'Restart' }[$('play').textContent];
  if (shortPlay) $('play').dataset.short = shortPlay; else delete $('play').dataset.short;
  const percent = readingPercent();
  if (!draggingRanges.has($('position'))) $('position').value = String(Math.round(percent * 10));
  $('position').setAttribute('aria-valuetext', `${percent}%`);
  $('position-value').textContent = `${percent}%`;
  $('position-value').setAttribute('aria-label', `${percent}%. Enter reading position`);
  const pages = layout?.pages.length || 1;
  $('page-number').value = String(layout ? Math.max(1, layout.pages.filter(y => y <= reader.y + .5).length) : 1);
  $('page-number').max = String(pages);
  const pageLabel = `Page ${$('page-number').value} of ${pages}`;
  if ($('page-value').textContent !== pageLabel) $('page-value').textContent = pageLabel;
  $('page-value').setAttribute('aria-label', `${pageLabel}. Enter page number`);
  for (const control of document.querySelectorAll('#reader-controls button, #reader-controls input, #reader-controls select, #transport button, .jump-row button, .jump-row input')) control.disabled = !layout;
  $('dock-toggle').disabled = false;
  const paceShown = reader.mode !== 'page' && !footnotesView;
  $('pace-toggle').hidden = !paceShown;
  $('reader-controls').dataset.pace = paceShown ? 'shown' : 'hidden';
  $('word-group-down').disabled = !layout || reader.speedReading.count <= 1; $('word-group-up').disabled = !layout || reader.speedReading.count >= 10;
  $('entry-lines-down').disabled = preferences.pdfEntryLines <= 1; $('entry-lines-up').disabled = preferences.pdfEntryLines >= 9;
  $('bookmark-quick').disabled = !layout || Boolean(footnotesView);
  $('reader-controls').dataset.mode = reader.mode;
  $('speed-down').disabled = !layout || rate <= (speedMode ? MIN_WORD_RATE : 6); $('speed-up').disabled = !layout || rate >= (speedMode ? MAX_WORD_RATE : 200);
  $('bookmark').disabled = !layout;
  $('passage-current').disabled = !layout;
  $('previous').setAttribute('aria-label', speedMode ? 'Previous word group or figure' : 'Previous page');
  $('next').setAttribute('aria-label', speedMode ? 'Next word group or figure' : 'Next page');
  $('previous').disabled = !layout || (speedMode ? reader.speedReading.cursor <= 0 : reader.y <= 0);
  $('next').disabled = !layout || (speedMode ? group?.end >= reader.speedReading.entries.length : reader.y >= reader.maxY);
  $('play').disabled = !layout || (speedMode ? !group : !positionPicker && !reader.playing
    && (reader.mode === 'auto' ? !reader.canAutoAdvance : reader.y >= reader.maxY));
  if (layout?.preparation?.complete === false && speedMode && reader.speedReading.finished) $('play').disabled = true;
  if (footnotesView) {
    $('preview').setAttribute('aria-label', `Footnotes: ${active?.title || ''}`);
    $('gesture-note').textContent = gestureHelp({ view: 'footnotes' });
    $('auto-note').hidden = true;
    $('play').textContent = 'Back to reading'; $('play').disabled = false;
    $('previous').setAttribute('aria-label', 'Previous footnote page');
    $('next').setAttribute('aria-label', 'Next footnote page');
    $('previous').disabled = !footnotesView.layout || footnotesView.y <= 0;
    $('next').disabled = !footnotesView.layout || footnotesView.y >= footnotesView.layout.maxY;
    $('bookmark').disabled = true;
  }
  $('ask-open').disabled = !layout || !!askUI?.unavailableReason;
  $('library-librarian').disabled = !libraryReady || !!askUI?.unavailableReason;
  $('library-librarian').title = askUI?.unavailableReason || '';
  askUI?.renderFooter();
  const askControls = Boolean(askUI?.glassesVisible || askUI?.session.dialog());
  const askOpen = !$('ask-panel').hidden;
  $('transport').hidden = askOpen;
  $('reader-controls').dataset.transport = askOpen ? 'away' : 'home';
  if (askControls) { $('pace-toggle').hidden = true; $('reader-controls').dataset.pace = 'hidden'; }
  document.querySelector('.reading-panel').dataset.ask = askOpen ? 'open' : 'closed';
  if (askControls) {
    const ask = askUI.session;
    $('preview').setAttribute('aria-label', askUI.librarian ? 'Librarian conversation' : `Ask about this: ${active?.title || ''}`);
    $('gesture-note').textContent = gestureHelp({ view: 'answer' });
    $('auto-note').hidden = true;
    $('play').textContent = 'Back to reading'; $('play').disabled = false;
    $('previous').setAttribute('aria-label', 'Previous conversation page'); $('next').setAttribute('aria-label', 'Next conversation page');
    $('previous').disabled = !ask.review && (!ask.layout || ask.y <= 0);
    $('next').disabled = !ask.review && (!ask.layout || ask.y >= (ask.layout?.maxY || 0));
    if (ask.dialog()) {
      $('play').textContent = 'Accept';
      $('previous').setAttribute('aria-label', 'Previous part of message'); $('next').setAttribute('aria-label', 'Next part of message');
      $('previous').disabled = !!ask.review && ask.review.page <= 0;
      $('next').disabled = !!ask.review && ask.review.page >= ask.review.pages.length - 1;
      $('gesture-note').textContent = gestureHelp({ view: 'transcription' });
    }
    $('bookmark').disabled = true;
  }
  if (modePicker) {
    $('preview').setAttribute('aria-label', `Choose reading mode: ${READING_MODES[modePicker.index].label}. Swipe to choose, tap to select.`);
    $('gesture-note').textContent = gestureHelp({ view: 'picker' });
    $('auto-note').hidden = true;
    $('play').textContent = 'Use this mode'; $('play').disabled = false;
  }
  if (previewMenu) {
    $('preview').setAttribute('aria-label', `App menu: ${appMenu(askUI?.glassesVisible, documentContents(layout).length > 0)[previewMenu.index].itemName}. Swipe to choose, tap to select.`);
    $('gesture-note').textContent = gestureHelp({ view: 'menu' });
    $('auto-note').hidden = true;
    $('play').textContent = 'Select'; $('play').disabled = false;
    $('previous').disabled = $('next').disabled = false;
  }
  $('preview-menu-toggle').setAttribute('aria-expanded', String(!!previewMenu));

}
let followShown = null;
function renderFollow() {
  const pdf = layout?.format === 'pdf' || active?.format === 'pdf';
  const following = !layout || (pdf ? pdfPassage.follow : passage.follow);
  const key = `${pdf}:${following}:${Boolean(layout)}`;
  if (key === followShown) return;
  followShown = key;
  $('passage-current').setAttribute('aria-pressed', String(following));
  $('passage-current').textContent = following ? 'Following' : 'Show current';
  $('passage-current').setAttribute('aria-label', following ? 'Following the glasses position' : `Browsing. Show the current ${pdf ? 'position' : 'line'}`);
  $('passage-help').textContent = pdf ? 'Tap a point to read from there on your glasses. Long-press to bookmark it.'
    : 'Tap a line to read from there on your glasses. Long-press to bookmark it.';
  $('passage').closest('.reading-panel').dataset.browsing = String(!following);
}
let followFrame = 0;
for (const id of ['passage', 'pdf-passage']) for (const type of ['scroll', 'wheel', 'touchstart', 'pointerdown', 'keydown', 'click']) {
  $(id).addEventListener(type, () => { cancelAnimationFrame(followFrame); followFrame = requestAnimationFrame(renderFollow); }, { passive: true });
}
function move(direction) {
  if (askUI?.glassesVisible || askUI?.session.review) { askUI.session.move(direction); return; }
  picker = null; positionPicker = null; modePicker = null;
  if (footnotesView) {
    if (footnotesView.layout) footnotesView.y = pdfPageTurn(footnotesView.layout, footnotesView.y, direction);
    dirty = true; renderControls(); return;
  }
  useReadyPdfPages();
  diagnostics.log('navigate', { direction, mode: reader.mode });
  reader.pageStep(direction);
}
function setSpeed(value) {
  if (reader.mode === 'speed') { reader.setWordSpeed(value); preferences.wordSpeed = reader.speedReading.rate; }
  else { reader.setSpeed(value); preferences.autoSpeed = reader.speed; }
  savePreferences(); renderControls();
  diagnostics.log('reading-speed', { mode: reader.mode, rate: reader.mode === 'speed' ? reader.speedReading.rate : reader.speed });
}
function steppedSpeed(direction) { return reader.mode === 'speed' ? stepWordSpeed(reader.speedReading.rate, direction) : stepAutoSpeed(reader.speed, direction); }
function setWordGroup(value) { reader.setWordGroup(value); preferences.wordGroup = reader.speedReading.count; savePreferences(); renderControls(); }
function setEntryLines(value) {
  preferences.pdfEntryLines = pdfEntryLines(value);
  if (reader.autoPosition instanceof PdfAutoscroll) reader.autoPosition.initialLines = preferences.pdfEntryLines;
  savePreferences(); renderControls();
}
function useReadyPdfPages() {
  if (!layout || !pendingPdfPosition) return;
  pendingPdfPosition = null;
  const { readyPages, totalPages } = layout.preparation;
  notice(`${readyPages} of ${totalPages} PDF pages ready. You can read now; more pages are preparing. Position and reading time cover the ready pages.`);
}
function jump(position) { useReadyPdfPages(); previewInput?.cancel(); previewMenu = null; askUI?.returnToReading(); if (footnotesView) closeFootnotes(); picker = null; positionPicker = null; modePicker = null; reader.jump(position); }
let seekFrame = 0;
function seekPercent(percent) {
  useReadyPdfPages();
  askUI?.returnToReading();
  if (footnotesView) closeFootnotes();
  if (!layout) return;
  if (reader.mode === 'speed') { picker = null; positionPicker = null; modePicker = null; reader.seekWords(percent); }
  else jump(reader.maxY * percent / 100);
  renderPassage();
  (layout.format === 'pdf' ? pdfPassage : passage).showCurrent(true);
  renderFollow();
  renderControls();
  // Paint visible phone controls on the next animation frame, while glasses
  // updates keep their existing serial queue and rate limit.
  if (!seekFrame) seekFrame = requestAnimationFrame(now => { seekFrame = 0; animate(now); });
}
function setMode(mode) {
  previewInput?.cancel(); previewMenu = null;
  askUI?.returnToReading();
  if (footnotesView) closeFootnotes();
  if ($('value-dialog').open) $('value-dialog').close();
  picker = null; positionPicker = null; modePicker = null; diagnostics.log('mode', { mode }); reader.setMode(mode); preferences.mode = mode; rememberPosition(); phonePreferences?.flush(); renderControls();
}
let activeTab = null;
const toolPanes = { outline: ['outline', 'Contents'], search: ['search-pane', 'Search'], bookmarks: ['bookmarks-pane', 'Bookmarks'], pdf: ['pdf-controls', 'This PDF · formatting'] };
function showTab(tab) {
  if (tab === 'pdf' && active?.format !== 'pdf') tab = null;
  if (tab && askUI.session.active) askUI.returnToReading();
  activeTab = tab;
  for (const [name, [pane]] of Object.entries(toolPanes)) {
    $(`tab-${name}`).setAttribute('aria-pressed', String(name === tab));
    $(pane).hidden = name !== tab;
  }
  $('tool-panel').hidden = !tab;
  if (tab) $('tool-title').textContent = toolPanes[tab][1];
  if (tab) {
    const pane = $(toolPanes[tab][0]); pane.scrollTop = 0;
    for (const child of pane.querySelectorAll('.navigation-content, #search-results')) child.scrollTop = 0;
    if (tab === 'search') $('search').focus({ preventScroll: true });
    scrollToTool($('tool-panel'));
  }
}
function scrollToTool(panel) {
  requestAnimationFrame(() => {
    if (panel.hidden) return;
    const content = document.querySelector('.reader-content');
    const tabs = document.querySelector('.reader-sticky');
    const offset = panel.getBoundingClientRect().top - content.getBoundingClientRect().top;
    content.scrollTo({ top: content.scrollTop + offset - tabs.offsetHeight - 8, behavior: 'instant' });
  });
}
// Use the actual space above the dock, including expanded controls and viewport
// changes. Leave a generous area outside nested scrollers to move the main page.
const readerContent = document.querySelector('.reader-content');
new ResizeObserver(() => readerContent.style.setProperty('--reader-height', `${readerContent.clientHeight}px`)).observe(readerContent);
$('tool-close').onclick = () => { const tab = activeTab; showTab(null); if (tab) $(`tab-${tab}`).focus(); };
function setLibraryBusy(value) {
  libraryBusy = value; renderLibraryAvailability(); renderDeleteStatus(); renderImports(imports.jobs);
}
function syncProgress(text, label = text) {
  $('library-sync-status').hidden = !text; $('library-sync-status').textContent = text;
  librarySyncLabel = label; dirty = true; renderSyncSummary();
}
async function startLibrarySync() {
  if (!libraryReady || libraryBusy || librarySync) return;
  const controller = new AbortController(); librarySync = controller;
  $('library-sync-cancel').hidden = false; setLibraryBusy(true);
  syncProgress('Preparing library sync…');
  try {
    await imports.idle(); controller.signal.throwIfAborted();
    const config = askUI.readConfig();
    if (connectionMode(config) !== 'terminal') throw new Error('Connect Even Terminal in Settings → Ask connection to sync your library.');
    const client = new EvenTerminal(config, askUI.options());
    const endpoint = client.config.endpoint;
    const result = await syncLibrary({ client, snapshot, store, signal: controller.signal,
      saved: preferences.librarySync?.[endpoint] || {}, progress: text => syncProgress(text),
      saveState: async state => {
        preferences.librarySync ||= {}; preferences.librarySync[endpoint] = state; savePreferences(); await phonePreferences?.flush();
      },
      changed: async (result, id) => {
        const wasPicker = picker, selectedId = active?.id;
        if (selectedId === id) rememberPosition();
        snapshot = result.snapshot;
        if (id) await pdfPreparationCache.remove(id).catch(error => diagnostics.error('pdf-cache-delete-error', error));
        if (selectedId === id) {
          if (!snapshot.documents.some(doc => doc.id === id)) delete preferences.selected;
          selectDocument(snapshot.documents.some(doc => doc.id === id) ? id : null, false);
          if (wasPicker) picker = wasPicker;
        }
        refreshDocumentPicker(); renderLibrary(); savePreferences();
      },
    });
    await sharedReader.sync(); await refreshLibraryActivity(true);
    if (result.readOnly) { syncProgress(`Opened ${result.listed} desktop catalog entries. Files download when opened.`, 'Read-only desktop library'); return; }
    const detail = `${result.uploaded} sent · ${result.listed == null ? result.downloaded + ' received' : result.listed + ' catalog entries updated'} · ${result.deleted} deleted${result.conflicts ? ` · ${result.conflicts} conflicts kept as copies` : ''}`;
    syncProgress(`Synced ${result.directory}. ${detail}${result.skipped.length ? `. ${result.skipped.length} desktop files skipped: ${result.skipped.map(f => f.name).join(', ')}` : ''}`, result.skipped.length ? 'Synced; some files skipped' : result.conflicts ? 'Synced; kept both copies' : 'Library synced');
  } catch (error) {
    if (!controller.signal.aborted && store.onDemand && (storageUnavailable(error) || storageWriteRejected(error))) {
      store.readOnly = true;
      try {
        const client = new EvenTerminal(askUI.readConfig(), askUI.options()), remote = await desktopLibrary(client, controller.signal);
        snapshot = store.browseRemote(remote, { endpoint: client.config.endpoint, libraryId: remote.id }).snapshot;
        renderLibrary(); syncProgress('Desktop catalog opened. Even storage is unavailable; downloads will stay in this session.', 'Read-only desktop library');
        return;
      } catch (fallbackError) { diagnostics.error('library-fallback-error', fallbackError); }
    }
    const message = controller.signal.aborted ? 'Sync cancelled. Completed files are saved; sync again to continue.'
      : error.status === 409 ? 'A file changed during sync. Sync again to preserve both copies.' : storageMessage(error);
    if (!controller.signal.aborted) diagnostics.error('library-sync-error', new Error('Library sync failed.'), {
      failure: error.code === 'library-capacity' ? 'capacity' : error.connectionFailure || (error.status ? 'http' : 'other'),
      status: error.status,
      ...(error.code === 'library-capacity' ? { bytes: error.totalBytes, files: error.files } : {}),
    });
    syncProgress(message, controller.signal.aborted ? 'Sync cancelled' : error.code === 'library-capacity' ? 'Library full; see phone' : 'Sync failed; see phone');
  } finally {
    librarySync = null; $('library-sync-cancel').hidden = true; setLibraryBusy(false); refreshDocumentPicker(); renderSyncSummary();
  }
}
// A quiet status beside the sync button: when the library last synced, or
// that sync needs an Even Terminal connection (which opens Settings).
function relativeTime(at) {
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function renderSyncSummary() {
  const config = askUI?.readConfig() || {};
  const ready = connectionMode(config) === 'terminal' && !!config.endpoint;
  const endpoint = String(config.endpoint || '').trim().replace(/\/+$/, '');
  const last = preferences.librarySync?.[endpoint]?.at || 0;
  const text = librarySync ? 'Syncing…' : store.readOnly ? 'Desktop · read-only' : !ready ? 'Not set up' : last ? `Synced ${relativeTime(last)}` : 'Not synced yet';
  if ($('library-sync-summary').textContent !== text) $('library-sync-summary').textContent = text;
  $('library-sync-summary').dataset.state = librarySync ? 'busy' : ready ? 'ready' : 'setup';
  $('library-sync-summary').setAttribute('aria-label', ready ? `Library sync: ${text}. Sync now` : 'Library sync is not set up. Open connection settings');
  $('library-sync-summary').disabled = !!librarySync || ready && ($('library-sync').disabled);
}
$('library-sync').onclick = $('library-sync-summary').onclick = () => {
  const config = askUI?.readConfig() || {};
  if (connectionMode(config) === 'terminal' && config.endpoint) startLibrarySync();
  else { setSettingsOpen(true); $('ask-connection-settings').open = true; $('settings-connection-label').scrollIntoView({ block: 'start' }); }
};
setInterval(renderSyncSummary, 30000);
$('library-sync-cancel').onclick = () => librarySync?.abort();
function storageMessage(error) {
  return error.name === 'QuotaExceededError' ? 'App storage could not save this change. Free cached space and try again.' : error.message;
}
const imports = new ImportQueue({
  prepare: readFileInBackground,
  save: async (document, onProgress) => {
    const result = await store.save(document, onProgress);
    snapshot = result.snapshot; refreshDocumentPicker(); renderLibrary();
    // Keep the current document and playback untouched, including for the
    // first import. Opening a file is a separate, explicit action.
    return { id: result.document.id, title: result.document.title };
  },
  onChange: renderImports,
});
const importNodes = new Map();
let failedSeen = 0; let importsCollapsed = false; let lastPending = 0;
function renderImports(jobs) {
  const pending = jobs.filter(job => !importFinished(job)).length;
  const added = jobs.filter(job => job.phase === 'done').length;
  const failed = jobs.filter(job => job.phase === 'failed').length;
  $('imports').hidden = !jobs.length; $('imports').dataset.pending = String(pending);
  const status = `${pending ? `${pending} pending · ` : ''}${added} added${failed ? ` · ${failed} failed` : ''}`;
  if ($('import-status').textContent !== status) $('import-status').textContent = status;
  $('clear-imports').hidden = !added && !failed;
  // A failure is announced once: opening the library (or a visible desktop
  // library) acknowledges it. Finished trays fold to their summary and failures.
  if (!drawerQuery.matches || $('library-panel').dataset.open === 'true') failedSeen = failed;
  failedSeen = Math.min(failedSeen, failed);
  const unseen = failed - failedSeen;
  $('import-badge').hidden = !pending && !unseen;
  $('import-badge').textContent = pending ? `${pending} adding` : `${unseen} failed`;
  $('import-badge').classList.toggle('error', !pending && unseen > 0);
  if (pending) importsCollapsed = false; else if (lastPending) importsCollapsed = true;
  lastPending = pending;
  $('imports').dataset.collapsed = String(importsCollapsed && !pending);
  $('imports-details').hidden = Boolean(pending) || !added;
  $('imports-details').textContent = importsCollapsed ? 'Details' : 'Hide';
  $('imports-details').setAttribute('aria-expanded', String(!importsCollapsed));
  const kept = new Set(jobs.map(job => job.id));
  const savedIds = new Set(snapshot?.documents.map(doc => doc.id));
  for (const [id, nodes] of importNodes) if (!kept.has(id)) { nodes.row.remove(); importNodes.delete(id); }
  for (const job of jobs) {
    let nodes = importNodes.get(job.id);
    if (!nodes) {
      const row = document.createElement('li'); row.className = 'import-job';
      const name = document.createElement('strong'); name.textContent = job.name;
      const detail = document.createElement('span'); detail.className = 'import-detail';
      const progress = document.createElement('progress'); progress.max = 100; progress.setAttribute('aria-label', `Adding ${job.name}`);
      const open = document.createElement('button'); open.textContent = 'Open'; open.className = 'text-button';
      open.setAttribute('aria-label', `Open imported ${job.name}`);
      open.onclick = () => { if (job.document) openFromPhone(job.document.id); };
      row.append(name, detail, progress, open); $('import-jobs').append(row);
      nodes = { row, detail, progress, open }; importNodes.set(job.id, nodes);
    }
    const signature = `${job.phase}:${job.loaded}:${job.total}:${savedIds.has(job.document?.id)}`;
    if (nodes.signature === signature) continue;
    nodes.signature = signature; nodes.row.dataset.phase = job.phase;
    const percent = job.total ? Math.min(100, Math.floor(job.loaded / job.total * 100)) : 0;
    nodes.detail.textContent = job.phase === 'queued' ? 'Waiting' : job.phase === 'reading' ? `Reading · ${percent}%`
      : job.phase === 'checking' ? 'Checking text…' : job.phase === 'saving' ? job.total ? `Saving · ${percent}%` : 'Saving…'
        : job.phase === 'failed' ? job.error : job.document.id === job.name ? 'Added' : `Added as ${job.document.id}`;
    nodes.progress.hidden = importFinished(job);
    if (job.phase === 'reading' || job.phase === 'queued' || job.phase === 'saving' && job.total) nodes.progress.value = percent; else nodes.progress.removeAttribute('value');
    nodes.open.hidden = job.phase !== 'done';
    nodes.open.disabled = !savedIds.has(job.document?.id);
  }
}
$('clear-imports').onclick = () => imports.clearFinished();
$('imports-details').onclick = () => { importsCollapsed = !importsCollapsed; renderImports(imports.jobs); };
async function deleteDocument(id) {
  if (libraryBusy || !libraryReady || store.readOnly) return;
  const doc = snapshot.documents.find(doc => doc.id === id);
  if (!doc) return;
  reader.pause(); deleting = true; deleteStatus = 'Deleting…'; setLibraryBusy(true);
  let stage = 'reading-history';
  diagnostics.log('library-delete-start', { format: doc.format || 'text', bytes: doc.bytes });
  try {
    if (active?.id === id) readingTracker.leave();
    const result = await retryAfterStorageRecovery(async () => {
      stage = 'reading-history'; await preserveReadingSessions(doc);
      stage = 'library-index'; return store.remove(id);
    }, async () => {
      diagnostics.log('library-delete-recovery', { stage });
      stage = 'free-cache'; deleteStatus = 'Freeing cached space before deleting…'; renderDeleteStatus();
      return freeCachedSpace(store.kv, pdfPreparationCache);
    });
    await pdfPreparationCache.remove(id).catch(error => diagnostics.error('pdf-cache-delete-error', error));
    rememberPosition(); snapshot = result.snapshot; deleteId = null;
    if (preferences.recent) preferences.recent = preferences.recent.filter(item => item !== id);
    if (preferences.openedAt) delete preferences.openedAt[id];
    delete preferences.positions[doc.positionKey]; delete preferences.bookmarks[doc.positionKey];
    askUI.forgetPaper(doc.positionKey);
    if (preferences.askPaperIds) delete preferences.askPaperIds[doc.positionKey];
    forgetPdfSettings(preferences, doc.positionKey);
    if (active?.id === id) {
      delete preferences.selected;
      selectDocument(null, false);
    } else { refreshDocumentPicker(); savePreferences(); renderLibrary(); }
    if (!active) setLibraryOpen(true, false);
    dirty = true;
    diagnostics.log('library-delete-ok', { documents: snapshot.documents.length });
    notice(`Deleted ${doc.id} from this reader.${Object.values(preferences.librarySync || {}).some(state => state.files?.[doc.id]) ? ' Next sync also removes the desktop copy, keeping its history.' : ' The original file is unchanged.'}`);
  } catch (error) {
    deletionPending = !!error.deletionPending;
    diagnostics.error('library-delete-error', error, { stage, code: error.code, storage: error.storage, deletionPending });
    deleteStatus = deletionPending ? `Deletion is saved but unfinished. Retry or reopen Pageborne to finish. ${storageMessage(error)}`
      : `Could not delete: ${storageMessage(error)}`; renderDeleteStatus();
  }
  finally { deleting = false; setLibraryBusy(false); }
}
$('import').onclick = () => $('file-picker').click();
$('file-picker').onchange = () => {
  const files = Array.from($('file-picker').files); $('file-picker').value = '';
  if (libraryReady && !libraryBusy && files.length) imports.enqueue(files);
};
$('filter').oninput = renderLibrary;
$('library-sort').onchange = () => {
  preferences.librarySort = librarySort($('library-sort').value);
  savePreferences(); renderLibrary(); refreshDocumentPicker();
};
$('previous').onclick = () => move(-1);
$('next').onclick = () => move(1);
$('play').onclick = () => { picker = null; handleAction('play'); };
$('pdf-footnotes').onclick = () => handleAction('footnotes');
$('mode-page').onclick = () => setMode('page');
$('mode-auto').onclick = () => setMode('auto');
$('mode-speed').onclick = () => setMode('speed');
$('word-group').oninput = () => setWordGroup($('word-group').value);
$('entry-lines').oninput = () => setEntryLines($('entry-lines').value);
$('word-group-down').onclick = () => setWordGroup(reader.speedReading.count - 1);
$('word-group-up').onclick = () => setWordGroup(reader.speedReading.count + 1);
$('entry-lines-down').onclick = () => setEntryLines(preferences.pdfEntryLines - 1);
$('entry-lines-up').onclick = () => setEntryLines(preferences.pdfEntryLines + 1);
const draggingRanges = new Set();
for (const id of ['position', 'speed']) $(id).addEventListener('pointerdown', () => draggingRanges.add($(id)));
for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, () => { draggingRanges.clear(); $('scrub-label').hidden = true; renderControls(); });
$('position').oninput = () => {
  seekPercent(Number($('position').value) / 10);
  const label = $('scrub-label');
  if (!draggingRanges.has($('position')) || reader.mode === 'speed' || !layout) { label.hidden = true; return; }
  const fraction = Number($('position').value) / 1000;
  const heading = headingAt(layout.maxY * fraction);
  label.hidden = !heading; if (!heading) return;
  label.textContent = heading.text;
  label.style.left = `calc(14px + (100% - 28px) * ${fraction})`;
};
$('start').onclick = () => jump(0);
function goToPage(number) {
  const index = Math.min((layout?.pages.length || 1) - 1, Math.max(0, Math.round(Number(number) || 1) - 1));
  jump(layout?.pages[index] || 0);
}
installHelpPopups();
$('speed').oninput = () => setSpeed((reader.mode === 'speed' ? wordSpeedFromSlider : speedFromSlider)($('speed').value));
$('speed-down').onclick = () => setSpeed(steppedSpeed(-1));
$('speed-up').onclick = () => setSpeed(steppedSpeed(1));
$('speed').onkeydown = event => {
  const steps = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 3, PageDown: -3 };
  if (event.key in steps || ['Home', 'End'].includes(event.key)) {
    event.preventDefault();
    setSpeed(event.key === 'Home' ? reader.mode === 'speed' ? MIN_WORD_RATE : 6 : event.key === 'End' ? reader.mode === 'speed' ? MAX_WORD_RATE : 200 : steppedSpeed(steps[event.key]));
  }
};
let editingValue = null;
function editValue(kind) {
  if (!layout) return;
  const pdf = layout.format === 'pdf';
  const fields = {
    position: { title: 'Reading position', label: 'Percentage', min: 0, max: 100, step: 0.1,
      value: readingPercent(),
      help: 'Enter 0–100%. Jumping pauses playback and moves the document preview.', apply: 'Go' },
    speed: { title: 'Autoscroll speed', label: `${pdf ? 'Steps' : 'Lines'} per minute`, min: 6, max: 200, step: 1,
      value: reader.speed, help: `Enter 6–200 ${pdf ? 'steps' : 'lines'} per minute.`, apply: 'Set speed' },
    'word-group': { title: 'Words per group', label: 'Words', min: 1, max: 10, step: 1, value: reader.speedReading.count,
      help: 'Enter 1–10 words. Long groups use fewer words to fit the screen.', apply: 'Set word count' },
    page: { title: 'Go to page', label: 'Page number', min: 1, max: layout.pages.length || 1, step: 1, value: Number($('page-number').value) || 1,
      help: `Enter 1–${layout.pages.length || 1}. Jumping pauses playback.`, apply: 'Go' },
    'entry-lines': { title: 'Text after images', label: 'Initial lines', min: 1, max: 9, step: 1, value: preferences.pdfEntryLines,
      help: 'Enter 1–9 lines to show when autoscroll next returns from an image. Lines enter from the bottom. Choose 9 to fill the screen immediately.', apply: 'Set line count' },
  };
  if (reader.mode === 'speed') fields.speed = { title: 'Speed reading rate', label: 'Words per minute', min: MIN_WORD_RATE, max: MAX_WORD_RATE, step: 1,
    value: reader.speedReading.rate, help: `Enter ${MIN_WORD_RATE}–${MAX_WORD_RATE} words per minute. Actual pace depends on glasses update speed.`, apply: 'Set speed' };
  const field = fields[kind];
  editingValue = { kind, selection: selectionVersion };
  $('value-title').textContent = field.title;
  $('value-label').textContent = field.label;
  const input = $('value-input');
  input.min = String(field.min); input.max = String(field.max); input.step = String(field.step);
  input.inputMode = kind === 'position' ? 'decimal' : 'numeric';
  input.value = String(field.value);
  $('value-help').textContent = field.help;
  $('value-apply').textContent = field.apply;
  $('value-dialog').showModal(); input.focus(); input.select();
}
$('position-value').onclick = () => editValue('position');
$('page-value').onclick = () => editValue('page');
$('speed-value').onclick = () => editValue('speed');
$('word-group-value').onclick = () => editValue('word-group');
$('entry-lines-value').onclick = () => editValue('entry-lines');
$('value-cancel').onclick = () => $('value-dialog').close();
$('value-dialog').addEventListener('close', () => { editingValue = null; });
$('value-form').onsubmit = event => {
  event.preventDefault();
  if (!$('value-input').reportValidity() || !editingValue || editingValue.selection !== selectionVersion || !layout) return;
  const value = Number($('value-input').value);
  if (editingValue.kind === 'position') seekPercent(value);
  else if (editingValue.kind === 'page') goToPage(value);
  else if (editingValue.kind === 'word-group') setWordGroup(value);
  else if (editingValue.kind === 'entry-lines') setEntryLines(value);
  else setSpeed(value);
  $('value-dialog').close();
};
// One shared scale applies to UI typography and the virtualized reading pane.
function applyAppTextSize() {
  const size = [12, 22, 26].includes(Number(preferences.size)) ? Number(preferences.size) : 12;
  const scale = { 12: 1, 22: 1.2, 26: 1.4 }[size];
  $('font-size').value = String(size);
  document.documentElement.style.setProperty('--app-text-scale', scale);
  passage.setSize(12 * scale);
  askUI?.resizeQuestion();
}
applyAppTextSize();
$('font-size').onchange = () => { preferences.size = Number($('font-size').value); savePreferences(); applyAppTextSize(); };
$('passage-current').onclick = () => { if (layout?.format === 'pdf') pdfPassage.showCurrent(); else passage.showCurrent(); renderFollow(); };
for (const option of ['system', 'light', 'dark']) $(`theme-${option}`).onclick = () => {
  if (option === 'system') delete preferences.theme; else preferences.theme = option;
  savePreferences(); applyTheme();
};
// Phones keep mode and rate controls folded into the floating dock until asked
// for; the summary button names the current mode and pace. Desktop shows them.
const dockKey = 'pageborne:dock-expanded';
let dockExpanded = false;
try { dockExpanded = localStorage.getItem(dockKey) === 'true'; } catch {}
function setDockExpanded(value) {
  dockExpanded = value;
  $('reader-controls').dataset.expanded = String(value);
  $('pace-toggle').setAttribute('aria-expanded', String(value));
  try { localStorage.setItem(dockKey, String(value)); } catch {}
}
setDockExpanded(dockExpanded);
$('pace-toggle').onclick = () => setDockExpanded(!dockExpanded);
// The mode chip opens a small menu above the dock on phones. Choosing a mode,
// Escape, the chip again or a tap elsewhere closes it. Desktop shows the modes.
function setModeMenu(open, focus = false) {
  const wasOpen = $('reader-controls').dataset.menu === 'open';
  $('reader-controls').dataset.menu = open ? 'open' : 'closed';
  $('dock-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('mode-menu').querySelector('[aria-pressed=true]')?.focus({ preventScroll: true });
  else if (wasOpen && focus) $('dock-toggle').focus({ preventScroll: true });
}
$('dock-toggle').onclick = () => setModeMenu($('reader-controls').dataset.menu !== 'open');
for (const id of ['mode-page', 'mode-auto', 'mode-speed']) $(id).addEventListener('click', () => setModeMenu(false, true));
document.addEventListener('pointerdown', event => {
  if ($('reader-controls').dataset.menu === 'open' && !event.target.closest('#mode-menu, #dock-toggle')) setModeMenu(false);
}, true);
$('mode-menu').addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setModeMenu(false, true); }
  if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation();
    const items = [...$('mode-menu').querySelectorAll('button')]; const i = items.indexOf(document.activeElement);
    items[(i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  }
});
$('pause-at-titles').onchange = () => {
  reader.setPauseAtTitles($('pause-at-titles').checked);
  preferences.pauseAtTitles = reader.pauseAtTitles; savePreferences(); renderControls();
};
// Collapsed settings sections say what they are set to. The connection opens
// by default until one is saved, so first-time setup is visible.
function renderSettingsSummaries() {
  const config = askUI?.readConfig() || {};
  const mode = connectionMode(config);
  const ready = mode === 'terminal' ? !!config.endpoint : mode === 'bridge' ? !!config.endpoint : !!(config.baseUrl && config.model);
  const label = !ready ? 'Not set up' : mode === 'terminal' ? `Even Terminal · ${config.agent === 'codex' ? 'Codex' : 'Claude'}` : mode === 'bridge' ? 'Pageborne bridge' : `${config.model}`;
  $('ask-connection-summary').textContent = label; $('ask-connection-summary').dataset.ready = String(ready);
  if (!renderSettingsSummaries.initialized) { $('ask-connection-settings').open = !ready; renderSettingsSummaries.initialized = true; }
  $('speech-backend-summary').textContent = $('speech-backend').value === 'remote' ? 'Speech provider' : 'On device';
  renderSyncSummary();
}
$('ask-config-save').addEventListener('click', () => setTimeout(renderSettingsSummaries));
$('ask-config-clear').addEventListener('click', () => setTimeout(renderSettingsSummaries));
$('speech-backend').addEventListener('change', renderSettingsSummaries);
for (const link of document.querySelectorAll('.settings-jump a')) link.onclick = event => {
  event.preventDefault();
  const target = document.querySelector(link.getAttribute('href'));
  target.closest('details')?.setAttribute('open', '');
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
};
for (const [id, field, type] of [['pdf-layout', 'mode', 'value'], ['pdf-margin-notes', 'keepMarginNotes', 'checked'],
  ['pdf-colors', 'normalizeColors', 'checked'], ['pdf-reflow', 'reflow', 'checked'], ['pdf-text-size', 'textSize', 'value'],
  ['pdf-repeated-text', 'keepRepeatedText', 'checked']]) {
  $(id).onchange = () => {
    if (active?.format !== 'pdf') return;
    rememberPosition();
    pdfSettingsFor(preferences, documentKey())[field] = field === 'textSize' ? Number($(id).value) : $(id)[type];
    savePreferences(); selectDocument(active.id, false);
  };
}
$('pdf-save-defaults').onclick = () => {
  if (active?.format !== 'pdf') return;
  preferences.pdfDefaults = normalizePdfSettings(pdfSettingsFor(preferences, documentKey()));
  savePreferences();
  $('pdf-default-status').textContent = 'Defaults saved for PDFs you open for the first time. Existing PDFs keep their formatting.';
};
$('pdf-reset-defaults').onclick = () => {
  if (active?.format !== 'pdf') return;
  rememberPosition(); usePdfDefaults(preferences, documentKey()); savePreferences(); selectDocument(active.id, false);
  $('pdf-default-status').textContent = 'This PDF now uses your saved defaults.';
};
function addBookmark(anchor) {
  if (!layout || footnotesView) return false;
  const marks = preferences.bookmarks[documentKey()] ||= [];
  if (marks.length >= 100) { notice('This document already has 100 bookmarks. Remove one to add another.'); return false; }
  marks.push(anchor); savePreferences(); renderBookmarks(); return true;
}
let flashTimer = 0;
function flash(text) {
  notice(text); clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if ($('notice-text').textContent === text) notice(''); }, 3200);
}
$('bookmark').onclick = () => { if (addBookmark(readingAnchor())) showTab('bookmarks'); };
$('bookmark-quick').onclick = () => {
  const anchor = readingAnchor();
  if (addBookmark(anchor)) flash(`Bookmarked at ${Math.round(anchor.percent ?? readingPercent())}%. Find it in Marks.`);
};
// Long-press a line or a point in the PDF to bookmark it without moving the glasses.
let pressTimer = 0; let pressStart = null; let suppressClick = false;
function cancelPress() { clearTimeout(pressTimer); pressTimer = 0; pressStart = null; }
for (const id of ['passage', 'pdf-passage']) {
  const pane = $(id);
  pane.addEventListener('pointerdown', event => {
    cancelPress(); suppressClick = false;
    const target = event.target.closest('[data-row], .pdf-tile');
    if (!target || !layout || event.button > 0) return;
    pressStart = { x: event.clientX, y: event.clientY };
    const pressedLayout = layout;
    pressTimer = setTimeout(() => {
      pressTimer = 0;
      if (layout !== pressedLayout || !target.isConnected || !pressStart) return;
      let y;
      if (target.classList.contains('pdf-tile')) y = Math.min(layout.maxY, Number(target.dataset.y) + (pressStart.y - target.getBoundingClientRect().top) / (pane.clientWidth / PDF_WIDTH));
      else y = layout.rows[Number(target.dataset.row)]?.y;
      if (y == null) return;
      suppressClick = true;
      const anchor = layout.format === 'pdf' ? pdfAnchor(layout, y) : anchorAt(layout, y);
      if (addBookmark(anchor)) { navigator.vibrate?.(12); flash(`Bookmarked “${(anchor.heading || anchor.text || '').slice(0, 40)}”. Your glasses stay where they are.`); }
    }, 550);
  });
  pane.addEventListener('pointermove', event => { if (pressStart && Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 10) cancelPress(); }, { passive: true });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave', 'scroll']) pane.addEventListener(type, () => { if (pressTimer) cancelPress(); }, { passive: true });
  pane.addEventListener('click', event => { if (suppressClick) { suppressClick = false; event.stopImmediatePropagation(); event.preventDefault(); } }, true);
  pane.addEventListener('contextmenu', event => { if (event.target.closest('[data-row], .pdf-tile')) event.preventDefault(); });
}
for (const tab of Object.keys(toolPanes)) $(`tab-${tab}`).onclick = () => showTab(tab);
let searchIndex = -1;
function searchButtons() { return [...$('search-results').querySelectorAll('.nav-item')]; }
function renderSearchStep() {
  const results = searchButtons();
  $('search-step').hidden = !results.length;
  $('search-count').textContent = searchIndex < 0 ? `${results.length}${results.length === 100 ? '+' : ''} match${results.length === 1 ? '' : 'es'}` : `${searchIndex + 1} of ${results.length}${results.length === 100 ? '+' : ''}`;
  results.forEach((button, i) => { if (i === searchIndex) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current'); });
}
function stepSearch(direction) {
  const results = searchButtons(); if (!results.length) return;
  searchIndex = searchIndex < 0 ? (direction > 0 ? 0 : results.length - 1) : (searchIndex + direction + results.length) % results.length;
  results[searchIndex].click(); results[searchIndex].scrollIntoView({ block: 'nearest' });
}
$('search-prev').onclick = () => stepSearch(-1);
$('search-next').onclick = () => stepSearch(1);
$('search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); stepSearch(event.shiftKey ? -1 : 1); } });
$('search-results').addEventListener('click', event => {
  const button = event.target.closest('.nav-item'); if (!button) return;
  searchIndex = searchButtons().indexOf(button); renderSearchStep();
});
$('search').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchIndex = -1;
    $('search-results').replaceChildren(); renderSearchStep();
    if (!layout || !$('search').value.trim()) return;
    if (layout.format === 'pdf') {
      const query = $('search').value.trim().toLocaleLowerCase(); let count = 0;
      for (const block of layout.blocks) for (const line of block.lines) {
        if (count >= 100 || !line.text.toLocaleLowerCase().includes(query)) continue;
        $('search-results').append(navigationButton(line.text, `PDF page ${block.page}`, () => jump(Math.max(block.y, block.y + (line.displayY ?? (line.y - block.sourceY - 4) * block.scale))), query)); count++;
      }
      if (!count) empty($('search-results'), 'No searchable text found. For scanned pages, enable Reflow body text to recognize text on this device.');
      renderSearchStep(); return;
    }
    const hits = searchDocument(layout, $('search').value);
    if (!hits.length) return empty($('search-results'), 'No matches in this document.');
    for (const hit of hits) $('search-results').append(navigationButton(hit.text, `Line ${hit.sourceLine}`, () => jump(positionForMatch(layout, hit)), $('search').value));
    if (hits.length === 100) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Showing the first 100 matches. Refine your search for more specific results.'; $('search-results').append(p); }
    renderSearchStep();
  }, 150);
};
$('reconnect').onclick = () => glasses.connect();
$('keyboard-note').textContent = keyboardHelp();
$('preview-menu-toggle').onclick = () => dispatchAction('menu', 'preview');
previewInput = installPreviewInput($('preview'), {
  dispatch: dispatchAction,
  coordinates: event => fullscreenReader?.coordinates(event) || [event.clientX, event.clientY],
  canUse: () => !document.hidden && !document.querySelector('dialog[open]'),
  keyboardAllowed: event => {
    if (event.defaultPrevented || document.querySelector('dialog[open]')) return false;
    if (drawerQuery.matches && $('library-panel').dataset.open === 'true' && !$('reader-controls').contains(event.target)) return false;
    return !$('figure-dialog').open && !$('annotation-dialog').open && !event.target.closest?.('input, textarea, select, button, [contenteditable], #passage, #pdf-passage, #pdf-gallery, #pdf-annotations, #ask-history, #ask-passage') && !!(active || picker || positionPicker || modePicker || previewMenu);
  },
});
fullscreenReader = new FullscreenReader(document.querySelector('.preview-wrap'), $('preview-fullscreen'), {
  cancel: () => previewInput.cancel(), landscape: () => !!window.flutter_inappwebview?.callHandler,
});
installHoldButton($('preview-speak'), { start: () => askUI.hold('phone'), release: () => askUI.release(), cancel: () => askUI.cancelDictation() });
document.querySelector('.brand').onclick = event => { event.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
function flushPosition() { rememberPosition(); phonePreferences?.flush(); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (WEB || !glasses.bridge)) { readingTracker.observe(null); askReadingTracker.observe(null); }
  if (document.hidden && (askUI?.phoneMic.capturing || askUI?.phoneMic.pending)) askUI.close();
  diagnostics.log('visibility', { state: document.visibilityState }); flushPosition();
  if (!document.hidden) { pdfProgressRefresh?.(true); dirty = true; animate(performance.now(), true); }
});
window.addEventListener('pagehide', () => { readingTracker.leave(); askReadingTracker.leave(); void readingLog?.flush().catch(readingSaveError); askUI?.cancelPairing(); askUI?.close(); askUI?.speech.dispose(); flushPosition(); });
window.addEventListener('pageshow', event => { if (event.persisted) voiceStartup = startVoiceSetup(); });


let lastTick = performance.now();
function nativePdfFrame() {
  if (layout?.format !== 'pdf' || reader.mode === 'speed') return null;
  return reader.mode === 'auto' ? reader.autoPosition.window(reader.y) : pdfNativeWindow(layout, reader.y);
}
function animate(now, immediate = false) {
  sampleReading(glasses.bridge ? glasses.readingFrame : readingPreview, now);
  if (askUI?.speech.setup.blocked) {
    playbackBlocked = true;
    lastTick = now;
    const frame = { mode: 'page', message: askUI.speech.setup.frame() };
    const key = JSON.stringify(frame.message);
    if (key !== lastSentKey && (immediate || now - lastSend >= 250)) {
      paintFrame(previewContext, frame); glasses.submit(frame); lastSentKey = key; lastSend = now;
    }
    dirty = true; return;
  }
  if (askUI?.session.tick(now, reducedMotion.matches)) dirty = true;
  // Count visible reading time during footer work, but wait for the display
  // lane before advancing. Slow transport must never skip unread positions.
  const wordFrame = reader.mode === 'speed' ? reader.speedReading.current : null;
  const nativePdf = nativePdfFrame();
  const needsPdf = layout?.format === 'pdf' && (!wordFrame || wordFrame.image) && !nativePdf && !picker && !positionPicker && !modePicker;
  const waitingForDisplay = Boolean(!layout || !glasses.bridge && document.hidden || previewMenu || askUI?.glassesVisible || askUI?.session.dialog() || footnotesView || picker || positionPicker || modePicker || needsPdf && (pdfRendering || pdfBitmap?.layout !== layout || pdfBitmap?.y !== reader.y || pdfBitmap?.mode !== reader.mode) || glasses.bridge && (!glasses.ready || glasses.suspended || glasses.readingFrame?.layout !== layout
    || glasses.readingFrame?.y !== reader.y || glasses.readingFrame?.mode !== reader.mode
    || glasses.readingFrame?.playing !== reader.playing
    || reader.mode === 'auto' && glasses.readingFrame?.speed !== reader.speed
    || reader.mode === 'speed' && glasses.readingFrame?.wordRate !== reader.speedReading.rate
    || glasses.readingFrame?.nativePdf?.reveal !== nativePdf?.reveal
    || glasses.readingFrame?.wordFrame?.start !== wordFrame?.start || glasses.readingFrame?.wordFrame?.end !== wordFrame?.end));
  const displayBusy = Boolean(glasses.bridge && (glasses.lane.busy && !diagnostics.active?.name.startsWith('storage-')
    || glasses.queue?.running || glasses.queue?.pending));
  // The first timer interval after an acknowledgement may straddle the
  // transfer. Count only the time for which the new frame was accepted.
  const tickStart = glasses.bridge ? Math.max(lastTick, glasses.readingAcceptedAt ?? lastTick) : lastTick;
  playbackBlocked = waitingForDisplay || displayBusy;
  reader.tick((now - tickStart) / 1000, waitingForDisplay, !displayBusy); lastTick = now;
  if (dirty) {
    const message = active && !layout ? pdfOpenMessage
      : !libraryReady ? { body: 'Opening your saved library…', status: 'Loading', kind: 'loading' } : null;
    const frame = { layout, y: reader.y, title: active?.title, mode: reader.mode, playing: reader.playing,
      speed: reader.speed, picker: picker ? { ...picker, syncEnabled: picker.kind !== 'terminal-sessions', syncing: picker.kind !== 'terminal-sessions' && !!librarySync, syncStatus: picker.kind === 'terminal-sessions' ? '' : librarySyncLabel } : null, positionPicker, selection: selectionVersion, message,
      wordFrame: reader.mode === 'speed' ? reader.speedReading.current : null, wordRate: reader.speedReading.rate,
      remainingSeconds: reader.speedReading.remainingSeconds,
      pageRemainingSeconds: reader.pageRemainingSeconds,
      percent: readingPercent(), finished: reader.speedReading.finished, pauseAtTitles: reader.pauseAtTitles,
      nativePdf: nativePdfFrame() };
    if (footnotesView) Object.assign(frame, { footnotes: true, layout: footnotesView.layout || layout, y: footnotesView.y,
      mode: 'page', playing: false, wordFrame: null,
      nativePdf: footnotesView.layout ? pdfNativeWindow(footnotesView.layout, footnotesView.y) : null,
      message: footnotesView.layout ? null : { body: 'No recognized footnotes in this document.\n\nTap to return to your place.', status: 'Footnotes · Tap to return' } });
    frame.askStatus = askUI?.footerStatus();
    frame.askUnavailable = !!askUI?.unavailableReason;
    frame.voiceUnavailable = !!askUI?.speech.setup.suspended && askUI.speech.backend !== 'remote';
    frame.dialog = askUI?.session.active ? askUI.session.dialog() : null;
    frame.askMenu = !!askUI?.glassesVisible;
    if (askUI?.glassesVisible) Object.assign(frame, { message: askUI.frame(), wordFrame: null, nativePdf: null, picker: null, positionPicker: null, mode: 'page', playing: false });
    if (modePicker) frame.modePicker = { ...modePicker };
    if (previewMenu) Object.assign(frame, { message: { body: `Pageborne menu\n\n${appMenu(frame.askMenu, documentContents(layout).length > 0).map((item, i) => `${i === previewMenu.index ? '> ' : '  '}${item.itemName}`).join('\n')}`, statusLeft: 'Swipe to choose', statusRight: 'Tap to select' }, wordFrame: null, nativePdf: null, picker: null, positionPicker: null, mode: 'page', playing: false });
    const needsBitmap = frame.layout?.format === 'pdf' && !frame.message && (!frame.wordFrame || frame.wordFrame.image) && !frame.nativePdf && !picker && !positionPicker;
    if (pdfRendering && (!needsBitmap || pdfRendering.layout !== frame.layout || pdfRendering.y !== frame.y || pdfRendering.mode !== frame.mode)) {
      pdfRendering.controller.abort(); pdfRendering = false;
    }
    if (needsBitmap) {
      if (pdfBitmap?.layout !== frame.layout || pdfBitmap?.y !== frame.y || pdfBitmap?.mode !== frame.mode) {
        if (!pdfRendering) {
          const job = { layout: frame.layout, y: frame.y, mode: frame.mode, controller: new AbortController() };
          pdfRendering = job; const version = selectionVersion;
          frame.layout.pdf.draw(frame.y, BODY_HEIGHT, true, { signal: job.controller.signal, paging: frame.mode !== 'auto', centerImages: true, endAt: frame.wordFrame?.endAt ?? pdfImageEnd(frame.layout, frame.y) }).then(bitmap => {
            if (version === selectionVersion && pdfRendering === job && !job.controller.signal.aborted) pdfBitmap = { layout: frame.layout, y: frame.y, mode: frame.mode, bitmap };
            else bitmap.width = bitmap.height = 1;
          }).catch(error => { if (version === selectionVersion && !job.controller.signal.aborted) { reader.pause(); notice(`Could not render PDF: ${error.message}`, true); } })
            .finally(() => {
              if (version === selectionVersion && pdfRendering === job) { pdfRendering = false; dirty = true; animate(performance.now(), true); }
            });
        }
        // A cold PDF raster must not hide the microphone popup. Show cached
        // pixels if available, otherwise leave the underlay blank until ready.
        if (!frame.dialog && !frame.modePicker) { renderControls(); renderPassage(); return; }
        if (pdfBitmap?.layout === frame.layout) frame.bitmap = pdfBitmap.bitmap;
        // Also distinguish this temporary frame in the deduplication key so
        // the finished raster replaces it even if the dialog text stays still.
        frame.message = { body: ' ', status: '' };
      } else {
        frame.bitmap = pdfBitmap.bitmap;
      }
    }
    frame.bitmap ||= speedTitleBitmap(frame.wordFrame);
    paintFrame(previewContext, frame); renderControls();
    readingPreview = frame;
    if (!glasses.bridge && !window.flutter_inappwebview?.callHandler) sampleReading(frame, now);
    if (!glasses.bridge && !window.flutter_inappwebview?.callHandler && !document.hidden) askUI?.acceptFrame(frame);
    if (!layout || rowAt(layout, reader.y) !== lastPassage) renderPassage();
    const key = `${active?.id}:${Math.floor(frame.y)}:${frame.mode}:${frame.playing}:${layout?.size}:${reader.speed}:${frame.nativePdf?.reveal}:${frame.wordFrame?.start}:${frame.wordFrame?.end}:${frame.wordRate}:${frame.finished}:${frame.pauseAtTitles}:${frame.pageRemainingSeconds}:${positionPicker ? `position-${positionPicker.kind}-${positionPicker.index}-${positionPicker.percent}-${positionPicker.step}-${positionPicker.entries?.length}` : picker ? documentPickerText(picker) : 'reader'}:${librarySyncLabel}:${!!librarySync}:${frame.message?.body || ''}:${frame.message?.status || ''}:${frame.message?.statusCenter || ""}:${frame.message?.statusLeft || ""}:${frame.message?.statusRight || ""}:${JSON.stringify(frame.dialog || null)}:${frame.modePicker?.index ?? ''}:${!!footnotesView}:${frame.askStatus}:${frame.askUnavailable}:${frame.voiceUnavailable}`;
    const timedWords = frame.mode === 'speed' && frame.playing && frame.wordFrame && !frame.dialog && !frame.modePicker;
    if (key !== lastSentKey && (immediate || timedWords || now - lastSend >= 120)) {
      glasses.submit(frame); lastSentKey = key; lastSend = now;
    }
    dirty = key !== lastSentKey;
  }
}
function scheduleAnimation(delay = 0) {
  cancelTimeout(animationTimer);
  animationTimer = safeTimeout(() => {
    animationTimer = null;
    animate(performance.now());
    const playing = reader.playing && !playbackBlocked;
    const group = reader.mode === 'speed' && playing && reader.speedReading.current;
    // Schedule at the remaining dwell instead of rounding each line/group to a
    // 100 ms tick. Keep slow/background transfers gated and never catch up by
    // skipping content. safeTimeout also prevents SDK shadow-clock duplication.
    const duration = group ? group.words * (group.heading ? 120000 : 60000) / reader.speedReading.rate
      : playing && reader.mode === 'auto' ? 60000 / reader.speed : null;
    const remaining = duration == null ? 100 : duration - reader.elapsed * 1000;
    // Round up so a fractional deadline does not fire early and require a
    // second timer (with the browser's minimum delay) for the last fraction.
    scheduleAnimation(Math.max(4, Math.min(100, Math.ceil(remaining))));
  }, delay);
}
let voiceStartup, voiceDiagnosticsInstalled = false;
async function startVoiceSetup() {
  await askUI.speech.setup.start(initializeVoiceStorage);
  // Commit every successful check before enabling the library. Otherwise a
  // quick exit can leave the delayed native checkpoint looking interrupted.
  if (DEBUG) await diagnostics.flushCheckpoint?.();
}
async function freeCachedSpace(kv, cache) {
  let cleared = 0, failure;
  for (const clean of [() => cache.clear(), () => askUI.speech.recoverDownloads(), () => kv ? freeDocumentCache(kv) : 0]) {
    try { cleared += await clean(); }
    catch (error) { failure ||= error; diagnostics.error('cache-cleanup-error', error, { code: error.code, storage: error.storage }); }
  }
  if (!cleared && failure) throw failure;
  if (cleared && store.onDemand && !store.uncertain) {
    store.readOnly = false; store.cacheError = null;
    await phonePreferences?.resume(); renderLibrary();
  }
  return cleared;
}
async function freeDocumentCache(kv) {
  const target = store.onDemand && !store.readOnly ? store : new PhoneLibrary(kv, { lazy: true, onDemand: true });
  if (target !== store) await target.read();
  if (target.catalog.documents.some(d => d.body && !d.remote)) {
    const config = askUI.readConfig();
    if (connectionMode(config) === 'terminal' && config.endpoint) {
      try {
        const client = new EvenTerminal(config, askUI.options()), remote = await desktopLibrary(client);
        await target.confirmRemote(remote.files, { libraryId: remote.id, endpoint: client.config.endpoint });
      } catch (error) { diagnostics.error('cache-backup-check-error', error); }

    }
  }
  const cleared = await target.clearCachedDocuments();
  if (store.onDemand) {
    if (target !== store) { store.catalog = target.catalog; store.index = target.index; store.uncertain = false; store.refreshSnapshot(); }
    snapshot = store.snapshot; renderLibrary();
  }
  return cleared;
}
async function initializeVoiceStorage() {
  if (await waitForSpeechHost()) {
    const bridge = await waitForEvenAppBridge();
    const kv = bridgeStorage(bridge, glasses.lane);
    askUI.speech.setStorage(kv);
    const cache = new PdfPreparationCache(kv, { maxEntryChars: 16 * 1024 * 1024 });
    // Once the library opens it installs its live cache here. Keep that
    // instance on setup retries so clearing also invalidates in-flight writes.
    askUI.speech.setup.recoverStorage ||= () => freeCachedSpace(kv, cache);
    if (DEBUG && !voiceDiagnosticsInstalled) {
      const savedDiagnostics = new AtomicPhoneValue(kv, 'diagnostics');
      diagnostics.restore(await savedDiagnostics.read().catch(() => null));
      installDiagnosticCheckpoint(diagnostics, savedDiagnostics);
      voiceDiagnosticsInstalled = true;
    }
  } else askUI.speech.setStorage(null);
  if (DEBUG) {
    await diagnostics.flushCheckpoint?.();
    return { recoveredSetup: diagnostics.unfinishedSetups.some(entry => !entry.resolvedAt) };
  }
}
async function openLibrary() {
  if (openingLibrary) return openingLibrary;
  if (libraryReady && (store !== browserStore || !window.flutter_inappwebview?.callHandler)) return;
  libraryReady = false; $('import').disabled = true;
  openingLibrary = (async () => {
    // Download, load and exercise every recognizer before restoring documents,
    // starting PDF reflow, or enabling either phone or glasses interactions.
    if (WEB) { askUI.speech.setStorage(null); askUI.speech.setup.blocked = false; }
    else await (voiceStartup ||= startVoiceSetup());
    await imports.idle();
    const hasHost = !!window.flutter_inappwebview?.callHandler;
    const legacy = () => new LocalLibrary().read().catch(error => { if (!hasHost) throw error; return null; });
    if (hasHost) {
      notice('Opening your saved phone library…');
      const bridge = await waitForEvenAppBridge();
      const kv = bridgeStorage(bridge, glasses.lane);
      askUI.speech.setStorage(kv);
      const nextPreferences = new PhonePreferences(kv, error => {
        diagnostics.error('position-save-error', error, { code: error.code, storage: error.storage });
        if (store.onDemand && (storageUnavailable(error) || storageWriteRejected(error))) { store.readOnly = true; renderLibrary(); }
        notice(`Your place is kept in this session, but Even storage could not save it. Keep the reader open. ${error.message}`, true);
      }, 500, { recover: () => freeDocumentCache(kv) });
      const savedPreferences = await nextPreferences.read(preferences);
      const phoneStore = new PhoneLibrary(kv, { lazy: true, onDemand: true,
        download: (doc, options) => downloadCatalogDocument(new EvenTerminal(askUI.readConfig(), askUI.options()), doc, options),
        cacheChanged: () => {
          if (phoneStore.cacheError) {
            diagnostics.error('library-cache-save-error', phoneStore.cacheError);
            if (storageUnavailable(phoneStore.cacheError)) { phoneStore.readOnly = true; nextPreferences.suspend(); }
          }
          if (store === phoneStore) { snapshot = phoneStore.snapshot; renderLibrary(); }
        } });
      try { snapshot = await phoneStore.read(legacy, text => notice(text)); }
      catch (error) {
        if (!storageUnavailable(error) && !storageWriteRejected(error)) throw error;
        diagnostics.error('library-storage-error', error); phoneStore.readOnly = true;
        phoneStore.refreshSnapshot(); snapshot = phoneStore.snapshot;
      }
      if (['rejected', 'unavailable'].includes(kv.health.write)) phoneStore.readOnly = true;
      store = phoneStore; preferences = savedPreferences;
      migrateTerminalPreferences(preferences, privateTerminalConfig()); askUI.load();
      pdfPreparationCache = new PdfPreparationCache({ get: key => kv.get(key), set: (key, value) => {
        phoneStore.requireWritable(); return kv.set(key, value);
      } }, { maxEntryChars: 16 * 1024 * 1024 });
      askUI.speech.setup.recoverStorage = () => freeCachedSpace(kv, pdfPreparationCache);
      preferences.positions ||= {}; preferences.bookmarks ||= {};
      delete preferences.pageOverlap; delete preferences.askContextTokens;
      preferences.pdfEntryLines = pdfEntryLines(preferences.pdfEntryLines);
      delete preferences.connection; delete preferences.clientId;
      reader.mode = preferences.mode === 'speed' ? 'speed' : ['auto', 'native'].includes(preferences.mode) ? 'auto' : 'page';
      reader.speed = autoSpeed(preferences.autoSpeed); preferences.mode = reader.mode;
      reader.speedReading.rate = wordsPerMinute(preferences.wordSpeed);
      reader.speedReading.count = wordsPerGroup(preferences.wordGroup);
      reader.pauseAtTitles = preferences.pauseAtTitles === true;
      applyTheme();
      delete preferences.preloadText; delete preferences.speed;
      applyAppTextSize();
      phonePreferences = nextPreferences;
      readingLog = new ReadingLog(phoneReadingStorage(kv, { writable: () => !store.readOnly }), readingLogChanged);
      if (DEBUG && !voiceDiagnosticsInstalled) {
        const savedDiagnostics = new AtomicPhoneValue(kv, 'diagnostics');
        diagnostics.restore(await savedDiagnostics.read().catch(() => null));
        installDiagnosticCheckpoint(diagnostics, savedDiagnostics);
        voiceDiagnosticsInstalled = true;
      }
    } else { snapshot = await browserStore.read(); readingLog = new ReadingLog(browserReadingStorage(browserStore), readingLogChanged); }
    try { await readingLog.load(); } catch (error) { readingSaveError(error); }
    $('reading-history-open').disabled = false;
    if (!store.readOnly) await pdfPreparationCache.retain(snapshot.documents.map(doc => doc.id)).catch(error => diagnostics.error('pdf-cache-cleanup-error', error));
    libraryReady = true; $('import').disabled = false; notice('');
    if (WEB) await sharedReader.sync(); else void sharedReader.sync();
    const selected = snapshot.documents.some(doc => doc.id === preferences.selected?.id) ? preferences.selected.id : null;
    selectDocument(selected, false);
    setLibraryOpen(!active, false);
    void refreshReadingCounts();
    await phonePreferences?.flush();
    if (WEB || store.onDemand && connectionMode(askUI.readConfig()) === 'terminal' && askUI.readConfig().endpoint) void startLibrarySync();
  })().catch(error => { diagnostics.error('library-open-error', error, { code: error.code, storage: error.storage }); notice(`Could not open the saved library: ${error.message}`, true); renderLibrary(); renderControls(); setLibraryOpen(true, false); })
    .finally(() => { openingLibrary = null; });
  return openingLibrary;
}
window.addEventListener('flutterInAppWebViewPlatformReady', () => openLibrary());
async function start() {
  // requestAnimationFrame stops when the phone screen is hidden. Timer ticks keep
  // glasses input and automatic line advances working for as long as the WebView is alive.
  scheduleAnimation(100);
  animate(performance.now(), true);
  if (!WEB) void glasses.connect();
  await openLibrary();
  // Phone controls work independently while the SDK waits for its WebView host.
  if (!WEB && !glasses.ready) void glasses.connect();
  if (WEB) setConnection('Device reader');
  else setTimeout(() => { if (!glasses.bridge) setConnection('Device reader · Open in the Even app for glasses'); }, 5000);
}
$('app-version').textContent = `Pageborne ${VERSION} · ${BUILD_CHANNEL}`;
if (DEBUG) {
  $('debug-version').textContent = `${VERSION} · debug`;
  installDebugExport(diagnostics);
}
start();
