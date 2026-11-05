import test from 'node:test';
import assert from 'node:assert/strict';
import { GlassesDisplay, pageDefinition, pdfPageDefinition, modePageDefinition, MODE_POPUP, readingTimeText, statusText, footerTextObjects, bodyText, documentPageText, reviewPageDefinition } from '../src/glasses.js';
import { nativeLayout, LINE_HEIGHT } from '../src/native-text.js';
import { parseDocument } from '../src/document.js';
import { TERMINAL_SESSIONS_ID } from '../src/terminal-sessions.js';
import { openDocumentPicker, moveDocumentPicker, documentPickerText, LIBRARIAN_ID } from '../src/document-picker.js';
import { byteLength, VISIBLE_LINES } from '../src/native-text.js';
import { getTextWidth } from '@evenrealities/pretext';
import { TRANSCRIPTION_HINT } from '../src/controls.js';
import { AskSession } from '../src/ask.js';
import { ASK_STATUS_SYMBOLS } from '../src/ask-status.js';
import { getAdvW } from '@evenrealities/pretext';
import { setImmediate as nextTurn } from 'node:timers/promises';

test('reading acknowledgement precedes footer completion and survives footer-only changes', async () => {
  const previous = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pending = [], acknowledgements = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} },
      onReadingAccepted: f => acknowledgements.push(f) });
    display.ready = true;
    display.bridge = { textContainerUpgrade: box => new Promise(resolve => pending.push({ box, resolve })) };
    const layout = nativeLayout(parseDocument('one two three four five six'));
    const frame = { layout, mode: 'speed', playing: true, y: 0, wordRate: 1000, wordFrame: { start: 0, end: 3, content: 'one two three' } };
    const sending = display.send(frame);
    await nextTurn();
    assert.equal(pending[0].box.containerName, 'body'); assert.equal(display.readingFrame, undefined);
    pending.shift().resolve(true); await nextTurn();
    assert.equal(display.readingFrame, frame); assert.equal(display.acceptedFrame, undefined);
    assert.equal(pending[0].box.containerName, 'status');
    const acceptedAt = display.readingAcceptedAt;
    pending.shift().resolve(true); await nextTurn();
    assert.equal(pending[0].box.containerName, 'commands');
    pending.shift().resolve(true); await sending;
    assert.equal(display.acceptedFrame, frame);
    const footer = { ...frame, askStatus: 'Unread reply' }, updating = display.send(footer);
    await nextTurn();
    assert.equal(pending[0].box.containerName, 'status');
    assert.equal(display.readingAcceptedAt, acceptedAt); assert.equal(acknowledgements.length, 1);
    pending.shift().resolve(true); await nextTurn();
    if (pending.length) { assert.equal(pending[0].box.containerName, 'commands'); pending.shift().resolve(true); }
    await updating;
    assert.equal(display.readingAcceptedAt, acceptedAt);
    const next = display.send({ ...footer, wordFrame: { start: 3, end: 6, content: 'four five six' } });
    await nextTurn();
    assert.equal(display.readingFrame, footer, 'new words must wait for their own acknowledgement');
    pending.shift().resolve(true); await next;
    assert.equal(acknowledgements.length, 2);
    const failing = display.send({ ...footer, wordFrame: { start: 6, end: 9, content: 'unaccepted words' } });
    await nextTurn();
    pending.shift().resolve(false); await assert.rejects(failing, /Text update failed/);
    assert.equal(display.readingFrame.wordFrame.start, 3, 'a rejected body cannot start a new dwell');
  } finally { globalThis.window = previous; }
});

test('Ask page count is centered, actions are right aligned and scrolling only updates text', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const updates = [], diagnostics = { enabled: true, log() {} };
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics }); display.ready = true;
    display.askMenu = true; // Already showing Ask; scrolling must only update text.
    display.bridge = { async textContainerUpgrade(box) { updates.push(box); return true; },
      async rebuildPageContainer() { throw new Error('Scrolling must not rebuild'); },
      async updateImageRawData() { throw new Error('Conversation must not use images'); } };
    const session = new AskSession(); session.open({}, [], [{ id: 'one', question: 'Why?', answer: 'An extended explanation. '.repeat(150) }]);
    const frame = { y: 0, mode: 'page', message: session.frame() };
    const footer = statusText(frame);
    assert.match(footer, /^Ask +\d+ \/ \d+ +Hold: speak · Tap: back$/); assert.doesNotMatch(footer, /Latest/);
    assert(Math.abs(getTextWidth(footer) - 544) <= getTextWidth(' '));
    const page = pageDefinition('page', frame.message);
    assert(page.textObject.length <= 8); assert.equal(page.textObject.filter(b => b.isEventCapture).length, 1);
    await display.send(frame);
    const count = frame.message.statusCenter;
    const prefix = footer.slice(0, footer.indexOf(count));
    assert(Math.abs(12 + getTextWidth(prefix) + getTextWidth(count) / 2 - 288) <= getTextWidth(' '));
    const initial = updates.find(b => b.containerName === 'body').content;
    session.y = 0; session.conversation.following = false;
    await display.send({ ...frame, message: session.frame() });
    const changed = updates.filter(b => b.containerName === 'body').at(-1).content;
    assert.notEqual(initial, changed); assert(!page.textObject.some(b => b.containerName === 'chat-scroll'));
    assert(diagnostics.display.accepted);
    assert(!JSON.stringify(diagnostics.display).includes('explanation'), 'diagnostics record byte counts, not conversation text');
    display.bridge.rebuildPageContainer = async page => { assert.equal(page.menuObject.menuItems[1].itemName, 'Go to position'); return true; };
    await display.send({ y: 0, mode: 'page', layout: nativeLayout(parseDocument('Back to reading')) });
    assert(updates.every(b => ['body', 'status', 'commands'].includes(b.containerName)));
  } finally { globalThis.window = priorWindow; }
});

test('Ask replaces only Go to position in the native menu and restores it on returning to reading', async () => {
  const previous = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pages = [], actions = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction: action => actions.push(action), diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(page) { pages.push(page); return true; }, async textContainerUpgrade() { return true; } };
    const frame = { mode: 'page', y: 0, message: { kind: 'ask', body: 'First reply' } };
    await display.send(frame);
    assert.equal(pages[0].menuObject.menuItems[1].itemName, 'Go to latest');
    display.handleEvent({ menuItemClickEvent: { itemID: pages[0].menuObject.menuItems[1].itemID } });
    assert.deepEqual(actions, ['ask-latest']);
    await display.send({ ...frame, message: { ...frame.message, body: 'Another reply' } });
    assert.equal(pages.length, 1);
    await display.send({ ...frame, message: { body: 'Reader' } });
    assert.equal(pages.length, 2); assert.equal(pages[1].menuObject.menuItems[1].itemName, 'Go to position');
  } finally { globalThis.window = previous; }
});

test('contextual PDF menu preserves the supplied footer above the image layers', () => {
  for (const askMenu of [false, true]) {
    const footer = footerTextObjects({ message: { status: 'PDF' } });
    const page = pdfPageDefinition(258, { footer, askMenu });
    const layers = [...page.textObject, ...page.imageObject];
    assert.equal(new Set(layers.map(box => box.zOrderIndex)).size, layers.length);
    assert(footer.every(box => box.zOrderIndex > Math.max(...page.imageObject.map(tile => tile.zOrderIndex))));
    assert.equal(page.menuObject.menuItems[1].itemName, askMenu ? 'Go to latest' : 'Go to position');
  }
});

test('review uses native containers, updates transcript pages without rebuilding and restores the conversation', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const rebuilds = [], updates = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(page) { rebuilds.push(page); return true; }, async textContainerUpgrade(box) { updates.push(box); return true; }, async updateImageRawData() { throw new Error('Review must not use images'); } };
    const frame = { y: 0, mode: 'page', message: { body: 'An earlier answer\nSecond line\nThird line\nFourth line', status: 'Review', dialog: { text: 'Is this right?', hint: TRANSCRIPTION_HINT } } };
    const page = reviewPageDefinition(frame.message, frame.message.dialog);
    assert(page.textObject.length <= 8); assert.equal(page.textObject.filter(b => b.isEventCapture).length, 1);
    const longPage = reviewPageDefinition(frame.message, { ...frame.message.dialog, text: 'One\nTwo\nThree', hint: TRANSCRIPTION_HINT });
    assert(longPage.textObject.length <= 8, 'stay within the native text-container limit for long questions too');
    assert.equal(new Set(page.textObject.map(b => b.zOrderIndex)).size, page.containerTotalNum);
    assert(page.textObject.every(b => b.xPosition + b.width <= 576 && b.yPosition + b.height <= 288 && byteLength(b.content) < 900));
    await display.send(frame); assert.equal(rebuilds.length, 1); assert.equal(updates.length, 0);
    frame.message.dialog.text = 'Another page'; await display.send(frame); assert.equal(rebuilds.length, 1);
    assert.deepEqual(updates.map(b => b.content), ['Another page']);
    frame.message.dialog.dimmed = true; await display.send(frame);
    assert.equal(updates.at(-1).textColor, 1); assert.equal(updates.at(-1).containerName, 'review-text');
    frame.message.dialog.dimmed = false; await display.send(frame);
    assert.equal(updates.at(-1).textColor, 4); assert.equal(rebuilds.length, 1, 'brightness changes do not rebuild the display');
    delete frame.message.dialog; await display.send(frame); assert.equal(rebuilds.length, 2);
    assert.match(rebuilds[1].textObject.find(b => b.containerName === 'body').content, /Fourth line/);
  } finally { globalThis.window = priorWindow; }
});

test('PDF preparation and errors have explicit glasses states instead of the empty-library prompt', () => {
  const message = { body: 'Preparing PDF page 1 of 28…', status: 'Loading PDF', kind: 'loading' };
  const frame = { layout: null, y: 0, mode: 'page', message };
  assert.equal(bodyText(frame), message.body); assert.equal(statusText(frame), 'Loading PDF');
  assert.equal(bodyText({ ...frame, message: { body: 'Could not open PDF.', status: 'PDF error' } }), 'Could not open PDF.');
  assert.match(bodyText({ ...frame, picker: openDocumentPicker([]) }), /No saved documents/);
  assert.doesNotMatch(pageDefinition().textObject.find(t => t.containerName === 'body').content, /Choose a document/);
});

test('Pages footer uses the session estimate only when available, including image pages', () => {
  const layout = nativeLayout(parseDocument('A page of text.'));
  const frame = { mode: 'page', layout, y: 0 };
  assert.equal(readingTimeText(frame), '');
  assert.match(statusText(frame), /^0%  Pages +pg\. 1 +Hold: speak · Tap: Ask$/);
  for (const value of [undefined, NaN, Infinity, -1]) assert.equal(readingTimeText({ ...frame, pageRemainingSeconds: value }), '');
  for (const [seconds, expected] of [[120, '~2m'], [18, '<1m'], [6000, '~2h']]) {
    const time = readingTimeText({ ...frame, pageRemainingSeconds: seconds });
    assert.equal(time, expected);
    const status = statusText({ ...frame, pageRemainingSeconds: seconds });
    assert(status.includes(`Pages  ${expected}`)); assert(getTextWidth(status) <= 552);
    assert.equal(readingTimeText({ ...frame, layout: { format: 'pdf', rows: [] }, pageRemainingSeconds: seconds }), expected);
  }
});

test('time estimates round to a single minute or hour without claiming nonzero time is zero', () => {
  for (const [seconds, expected] of [[0, '~0m'], [1, '<1m'], [59, '<1m'], [60, '~1m'],
    [89, '~1m'], [90, '~2m'], [3540, '~59m'], [3570, '~1h'], [3600, '~1h'],
    [5399, '~1h'], [5400, '~2h'], [36000, '~10h']]) {
    assert.equal(readingTimeText({ mode: 'speed', remainingSeconds: seconds }), expected);
    assert.equal(readingTimeText({ mode: 'page', pageRemainingSeconds: seconds }), expected);
  }
});

test('remaining reading time uses wrapped rows from the current position and selected speed', () => {
  const layout = nativeLayout(parseDocument('```\n' + Array.from({ length: 600 }, (_, i) => `Row ${i}`).join('\n') + '\n```'));
  const frame = { layout, y: 0, speed: 200, mode: 'auto', playing: true };
  assert.equal(readingTimeText(frame), '~3m');
  assert.equal(readingTimeText({ ...frame, y: 400 * LINE_HEIGHT }), '~1m');
  assert.equal(readingTimeText({ ...frame, speed: 100 }), '~6m');
  assert.equal(readingTimeText({ ...frame, speed: 6 }), '~2h');
  assert.equal(readingTimeText({ ...frame, y: layout.maxY }), '<1m', 'include the final visible rows still to read');
  assert.equal(readingTimeText({ ...frame, layout: null }), '');
  assert.match(statusText(frame), /^0% ▶ 200 l\/min ~3m +pg\. 1 +Hold: speak · 2× tap: Ask$/);
  assert.match(statusText({ ...frame, playing: false }), /^0% Ⅱ 200 l\/min ~3m +pg\. 1 +Hold: speak · 2× tap: Ask$/);
  assert.equal(statusText({ ...frame, askStatus: 'No new replies' }), statusText(frame));
  for (const askStatus of Object.keys(ASK_STATUS_SYMBOLS)) {
    const text = statusText({ ...frame, askStatus });
    assert.match(text, /^0% ▶ 200 l\/min ~3m/); assert(text.includes(`${ASK_STATUS_SYMBOLS[askStatus]} Hold: speak · `)); assert.match(text, /2×(?: tap)?: Ask$/);
    assert(Math.abs(getTextWidth(text) - 544) <= getTextWidth(' '), 'notification reaches the right edge');
    assert.equal(statusText({ ...frame, askStatus, message: { status: 'Conversation' } }), 'Conversation');
  }
});

test('mode popup preserves the reading rows and footer around its left-side box', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const layout = nativeLayout(parseDocument('```\n' + Array.from({ length: 30 }, (_, i) => `Line ${i}: a long reading row with visible words beside the popup.`).join('\n') + '\n```'));
    const frame = { layout, mode: 'auto', y: 0, speed: 30, playing: false, modePicker: { index: 1 } };
    const content = { body: bodyText(frame), status: statusText(frame), footer: footerTextObjects(frame) };
    const page = modePageDefinition(content, 1);
    assert.equal(page.textObject.length, 8); assert.equal(page.textObject.filter(box => box.isEventCapture).length, 1);
    assert.equal(new Set(page.textObject.map(box => box.zOrderIndex)).size, 8);
    assert(page.textObject.every(box => box.xPosition >= 0 && box.yPosition >= 0 && box.xPosition + box.width <= 576 && box.yPosition + box.height <= 288 && byteLength(box.content) < 900));
    const get = name => page.textObject.find(box => box.containerName === name);
    assert.equal(get('mode-picker').xPosition, 12); assert.match(get('mode-option-1').content, /> Autoscroll/);
    for (let i = 0; i < 3; i++) {
      const item = get(`mode-option-${i}`);
      assert.equal(item.yPosition, MODE_POPUP.y + MODE_POPUP.padding + i * 40);
      assert(item.yPosition + item.height <= MODE_POPUP.y + MODE_POPUP.height - MODE_POPUP.padding);
    }
    assert.equal(get('status').content, content.footer[0].content); assert.equal(get('status').yPosition, 260);
    assert(Math.abs(MODE_POPUP.y + MODE_POPUP.height / 2 - 258 / 2) <= LINE_HEIGHT / 2);
    assert.equal(get('body').yPosition, 0);
    const first = MODE_POPUP.y / LINE_HEIGHT;
    assert(!get('mode-underlay'), 'preserve the container budget by masking the existing body');
    for (const [row, line] of get('body').content.split('\n').entries()) {
      const original = content.body.split('\n')[row];
      if (row < first || row >= first + MODE_POPUP.height / LINE_HEIGHT) { assert.equal(line, original); continue; }
      if (!line.trim()) continue;
      assert(original.endsWith(line.trimStart()));
      const start = original.length - line.trimStart().length;
      const oldX = 12 + getTextWidth(original.slice(0, start));
      const newX = 12 + getTextWidth(line.slice(0, line.length - line.trimStart().length));
      assert(Math.abs(newX - oldX) <= getTextWidth(' ') / 2, 'right-side text stays within half a space of its original x');
      assert(getTextWidth(line) < get('body').width, 'masked rows must not wrap');
    }
    const pages = [], updates = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(p) { pages.push(p); return true; }, async textContainerUpgrade(box) { updates.push(box); return true; } };
    await display.send(frame); assert.equal(pages.length, 1);
    await display.send({ ...frame, modePicker: { index: 2 } });
    assert.equal(pages.length, 1); assert.deepEqual(updates.map(box => box.containerName), ['mode-option-1', 'mode-option-2']);
    await display.send({ ...frame, modePicker: null }); assert.equal(pages.length, 2);
    assert.equal(pages[1].textObject.find(box => box.containerName === 'body').content, content.body);
  } finally { globalThis.window = priorWindow; }
});

test('paused rate returns after recording even with an agent notification', () => {
  const layout = nativeLayout(parseDocument('A reading passage. '.repeat(100)));
  for (const mode of ['auto', 'speed']) {
    const frame = { layout, mode, playing: false, speed: 30, wordRate: 250, y: 0, percent: 0, remainingSeconds: 100 };
    assert.equal(statusText({ ...frame, dialog: { text: 'Words', status: 'Listening…' } }), 'Listening…');
    for (const askStatus of ['Thinking…', 'Reply in progress', 'Unread reply', 'No new replies']) {
      const footer = statusText({ ...frame, askStatus });
      assert.match(footer, mode === 'auto' ? /Ⅱ 30 l\/min/ : /Ⅱ 250 wpm/);
    }
  }
});

test('mode popup masks only its rectangle in PDF transfers and restores the cached figure', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const transfers = [], pages = [];
    const bitmap = { getContext: () => ({ getImageData: (_x, _y, width, height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(255) }) }) };
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(page) { pages.push(page); return true; }, async textContainerUpgrade() { return true; },
      async updateImageRawData(data) { transfers.push(data); return 'success'; } };
    const frame = { bitmap, layout: nativeLayout(parseDocument('PDF figure')), mode: 'page', y: 0, modePicker: { index: 0 } };
    await display.send(frame); assert.equal(transfers.length, 4);
    for (const [i, tile] of pages[0].imageObject.entries()) {
      for (let y = 0; y < tile.height; y++) for (let x = 0; x < tile.width; x += 2) {
        const px = tile.xPosition + x, py = tile.yPosition + y;
        const covered = px >= MODE_POPUP.x && px < MODE_POPUP.x + MODE_POPUP.width && py >= MODE_POPUP.y && py < MODE_POPUP.y + MODE_POPUP.height;
        assert.equal(transfers[i].imageData[(y * tile.width + x) / 2], covered ? 0 : 255, 'only the centered popup rectangle is masked');
      }
    }
    await display.send({ ...frame, modePicker: { index: 1 } }); assert.equal(transfers.length, 4, 'selection only updates native text');
    await display.send({ ...frame, modePicker: null }); assert.equal(transfers.length, 8);
    assert(transfers.slice(4).every(transfer => transfer.imageData.every(byte => byte === 255)), 'the original pixels return after cancellation');
  } finally { globalThis.window = priorWindow; }
});

test('document picker reaches all saved files and Back with bounded native text', () => {
  const documents = Array.from({ length: 1000 }, (_, i) => ({ id: `${i}.md`, title: '中文👓'.repeat(500) }));
  let picker = openDocumentPicker(documents, '950.md');
  assert.equal(picker.index, 953);
  assert.ok(documentPickerText(picker).includes('> 950.md'), 'duplicate titles show distinct filenames');
  const seen = new Set();
  for (let i = 0; i < documents.length + 3; i++) {
    seen.add(picker.items[picker.index].id);
    const text = documentPickerText(picker);
    assert.ok(byteLength(text) < 900);
    assert.ok(text.split('\n').length <= VISIBLE_LINES);
    assert.ok(text.split('\n').some(line => line.startsWith('> ')));
    picker = moveDocumentPicker(picker, 1);
  }
  assert.equal(seen.size, 1003);
  assert.equal(picker.index, 953);
  picker = openDocumentPicker(documents, '0.md');
  assert.equal(moveDocumentPicker(picker, -1).items[0].id, null);
  picker = openDocumentPicker([]);
  assert.equal(picker.index, 0);
  assert.equal(moveDocumentPicker(picker, -1).index, 1);
  assert.match(documentPickerText(picker), /Add files on phone/);
  assert.equal(picker.items.length, 2, 'an empty library offers Librarian and desktop sessions');
  assert.equal(picker.items[0].id, LIBRARIAN_ID);
  assert.match(documentPickerText(picker), /> Librarian/);
});

test('root document picker starts on a file, wraps, and can highlight the document just closed', () => {
  const docs = [{ id: 'a.md', title: 'A' }, { id: 'b.pdf', title: 'B' }];
  const first = openDocumentPicker(docs);
  assert.equal(first.canReturn, false);
  assert.match(documentPickerText(first), /Choose document \(1\/2\)\n  Librarian\n  Even Terminal sessions\n> A/);
  assert.doesNotMatch(documentPickerText(first), /Back to reading/);
  const terminal = moveDocumentPicker(first, -1);
  assert.equal(terminal.items[terminal.index].id, TERMINAL_SESSIONS_ID);
  const librarian = moveDocumentPicker(terminal, -1);
  assert.equal(librarian.items[librarian.index].id, LIBRARIAN_ID);
  assert.match(documentPickerText(librarian), /Ask the librarian/);
  const wrapped = moveDocumentPicker(librarian, -1);
  assert.equal(wrapped.items[wrapped.index].id, 'b.pdf');
  const back = openDocumentPicker(docs, null, 'b.pdf');
  assert.match(documentPickerText(back), /Choose document \(2\/2\)/);
  assert.equal(back.items[back.index].id, 'b.pdf');
});

test('Back is routed to app navigation; only an explicit root close opens the system exit confirmation', async () => {
  const priorWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const actions = []; const shutdowns = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction: action => actions.push(action), diagnostics: { log() {} } });
    display.ready = true; display.queue = { pending: {}, stop() {} };
    display.bridge = { async shutDownPageContainer(mode) { shutdowns.push(mode); return true; } };
    display.handleEvent({ textEvent: { eventType: 3 } });
    assert.deepEqual(actions, ['back']); assert.deepEqual(shutdowns, []);
    assert.equal(display.suspended, false); assert.equal(display.ready, true);
    display.close(); display.close(); await display.closing;
    assert.deepEqual(shutdowns, [1]); assert.equal(display.suspended, true);
    assert.equal(display.queue.pending, null); assert.deepEqual(actions, ['back', 'close']);
    display.handleEvent({ sysEvent: { eventType: 5 } });
    assert.equal(display.suspended, false, 'cancelling exit resumes the library');
  } finally { globalThis.window = priorWindow; }
});

test('both modes use stationary native text; speed changes never rewrite the body or rebuild', async () => {
  const priorWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  try {
    const calls = []; const actions = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction: a => actions.push(a), diagnostics: { log() {} } });
    display.ready = true; display.displayMode = 'page';
    display.bridge = {
      async textContainerUpgrade(data) { calls.push(data); return true; },
      async rebuildPageContainer() { throw new Error('Unexpected rebuild'); }
    };
    const layout = nativeLayout(parseDocument('```\n' + Array.from({ length: 120 }, (_, i) => `Row ${i}`).join('\n') + '\n```'));
    const frame = { layout, y: 0, mode: 'page', title: 'Reading', speed: 30 };
    await display.send(frame);
    await display.send({ ...frame, mode: 'auto', speed: 36 });
    assert.equal(calls.filter(c => c.containerName === 'body').length, 1);
    await display.send({ ...frame, mode: 'auto', y: LINE_HEIGHT });
    const bodies = calls.filter(c => c.containerName === 'body');
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].content.split('\n').slice(1), bodies[1].content.split('\n').slice(0, -1));
    assert.equal(display.lastAccepted.positionKnown, true);
    assert.equal(calls.some(c => c.containerName === 'title'), false);
    assert.equal(bodies[0].content.split('\n').length, 9);
    for (const mode of ['page', 'auto']) {
      const page = pageDefinition(mode);
      assert.deepEqual(page.menuObject.menuItems.map(item => item.itemName), ['Change mode', 'Go to position', 'Start of doc', 'Choose document', 'Footnotes', 'Ask about this']);
      assert.equal(page.textObject.find(c => c.containerName === 'body').isEventCapture, 0);
      assert.equal(page.textObject.find(c => c.containerName === 'body').yPosition, 0);
      assert.equal(page.textObject.some(c => c.containerName === 'title'), false);
      assert.equal(page.textObject.filter(c => c.isEventCapture === 1).length, 1);
      assert.equal(page.textObject.find(c => c.isEventCapture === 1).content, ' ');
      display.handleEvent({ textEvent: { eventType: 1 } });
      display.handleEvent({ textEvent: { eventType: 2 } });
    }
    assert.deepEqual(actions, ['previous', 'next', 'previous', 'next']);
  } finally {
    if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow;
  }
});

test('startup queues display setup behind cache storage without ignoring a pending display call', async () => {
  const priorWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, flutter_inappwebview: { callHandler() {} } };
  try {
    const diagnostics = { log() {}, active: { name: 'storage-read' } }; const calls = [];
    const display = new GlassesDisplay({ onStatus: text => calls.push(text), onAction() {}, diagnostics });
    let setups = 0; display.setup = async () => { setups++; }; display.lane.busy = true;
    await display.connect(); assert.equal(setups, 1, 'saved PDF reads do not prevent initial connection');
    diagnostics.active.name = 'image-frame';
    await display.connect(); assert.equal(setups, 1); assert.match(calls.at(-1), /Display call still pending/);
  } finally { if (priorWindow === undefined) delete globalThis.window; else globalThis.window = priorWindow; }
});

test('live dictation and review share a bottom overlay without erasing the reading text', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pages = [], updates = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(p) { pages.push(p); return true; }, async textContainerUpgrade(b) { updates.push(b); return true; } };
    const layout = nativeLayout(parseDocument('A reading passage. '.repeat(50)));
    const frame = { layout, y: 0, mode: 'page', dialog: { text: 'Provisional words', hint: TRANSCRIPTION_HINT, status: 'Listening…' } };
    await display.send(frame);
    const page = pages[0], panel = page.textObject.find(b => b.containerName === 'review-panel'), hint = page.textObject.find(b => b.containerName === 'review-hint');
    assert.equal(panel.yPosition + panel.height, 288); assert.equal(panel.yPosition, 181);
    assert.equal(page.textObject.find(b => b.containerName === 'review-text').height, 27);
    assert.equal(hint.textColor, 1); assert.equal(hint.content.trim(), TRANSCRIPTION_HINT); assert.equal(hint.yPosition, 253); assert(!page.textObject.some(b => b.containerName === 'review-actions'));
    assert.match(page.textObject.find(b => b.containerName === 'body').content, /A reading passage/);
    frame.dialog = { ...frame.dialog, text: 'Final words', hint: TRANSCRIPTION_HINT, status: '' };
    await display.send(frame); assert.equal(pages.length, 2, 'finished capture removes the listening status row');
    assert(pages[1].textObject.some(b => b.containerName === 'review-text' && b.content === 'Final words'));
    assert(pages[1].textObject.some(b => b.containerName === 'review-hint' && b.content.trim() === TRANSCRIPTION_HINT));
  } finally { globalThis.window = priorWindow; }
});

test('voice overlay crops figures at their original position and restores the full image after review', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pages = [], regions = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(p) { pages.push(p); return true; }, async textContainerUpgrade() { return true; }, async updateImageRawData() { return 'success'; } };
    const bitmap = { getContext: () => ({ getImageData(x, y, w, h) { regions.push({ x, y, w, h }); return { data: new Uint8Array(w * h * 4) }; } }) };
    const frame = { layout: nativeLayout(parseDocument('Figure')), bitmap, y: 0, mode: 'page', dialog: { text: 'About this figure', hint: TRANSCRIPTION_HINT, status: '' } };
    await display.send(frame);
    assert(pages[0].textObject.length <= 8); assert(pages[0].containerTotalNum <= 12);
    assert.equal(new Set([...pages[0].textObject, ...pages[0].imageObject].map(b => b.containerID)).size, pages[0].containerTotalNum);
    assert.equal(Math.max(...regions.map(r => r.y + r.h)), 208);
    assert(pages[0].imageObject.every(b => b.yPosition + b.height <= 208));
    regions.length = 0; frame.dialog = { ...frame.dialog, text: 'One\nTwo\nThree' }; await display.send(frame);
    assert.equal(pages.length, 2); assert.equal(Math.max(...regions.map(r => r.y + r.h)), 154);
    assert.equal(pages[1].textObject.find(b => b.containerName === 'review-text').height, 81);
    regions.length = 0; frame.dialog = { ...frame.dialog, text: 'Short again' }; await display.send(frame);
    assert.equal(pages.length, 3); assert.equal(Math.max(...regions.map(r => r.y + r.h)), 208);
    regions.length = 0; delete frame.dialog; await display.send(frame);
    assert.equal(pages.length, 4); assert.equal(Math.max(...regions.map(r => r.y + r.h)), 258);
  } finally { globalThis.window = priorWindow; }
});

test('streaming text resizes the overlay only when its line count changes', async () => {
  const priorWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pages = [], updates = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(p) { pages.push(p); return true; }, async textContainerUpgrade(b) { updates.push(b); return true; } };
    const frame = { layout: nativeLayout(parseDocument('A reading passage. '.repeat(50))), y: 0, mode: 'page' };
    for (const [text, count, top] of [['One', 1, 181], ['One more word', 1, 181], ['One\nTwo', 2, 154], ['One\nTwo\nThree', 3, 127], ['Corrected', 4, 181]]) {
      frame.dialog = { text, hint: TRANSCRIPTION_HINT, status: 'Listening' };
      await display.send(frame); assert.equal(pages.length, count);
      const page = pages.at(-1), panel = page.textObject.find(b => b.containerName === 'review-panel');
      assert.equal(panel.yPosition, top); assert.equal(panel.yPosition + panel.height, 288);
      assert.equal(page.textObject.find(b => b.containerName === 'body').content.split('\n').length, Math.floor(top / LINE_HEIGHT));
      assert.equal(page.textObject.find(b => b.containerName === 'review-text').height, text.split('\n').length * LINE_HEIGHT);
    }
    assert(updates.some(b => b.containerName === 'review-text' && b.content === 'One more word'));
  } finally { globalThis.window = priorWindow; }
});


test('refinement shares the bottom row with right-aligned hints without overlap', () => {
  const dialog = { text: 'Uncertain words', hint: TRANSCRIPTION_HINT, dimmed: true, status: 'Refining...', statusInline: true };
  const page = reviewPageDefinition({ body: 'Reading', status: dialog.status }, dialog);
  const get = name => page.textObject.find(box => box.containerName === name);
  assert.equal(get('review-divider'), undefined);
  assert.equal(get('review-actions'), undefined);
  const hint = get('review-hint');
  assert.equal(hint.content.trim(), TRANSCRIPTION_HINT); assert.equal(hint.textColor, 1);
  assert.equal(hint.yPosition, 253); assert(getTextWidth(hint.content) <= hint.width);
  assert(hint.width - getTextWidth(hint.content) < getTextWidth(' '));
  assert.equal(get('status').content, 'Refining...'); assert.equal(get('status').xPosition, 24);
  assert(get('status').xPosition + get('status').width < hint.xPosition);
  assert(getTextWidth(get('status').content) <= get('status').width);
  assert.equal(get('status').textColor, 4); assert.equal(get('review-text').textColor, 1);
  assert.equal(get('status').yPosition, get('review-hint').yPosition);
  const finished = reviewPageDefinition({ body: 'Reading', status: '' }, { ...dialog, status: '' });
  assert.equal(get('review-panel').height, finished.textObject.find(box => box.containerName === 'review-panel').height);
});


test('release retains gesture hints and makes room for more conversation', async () => {
  const prior = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pages = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(page) { pages.push(page); return true; }, async textContainerUpgrade() { return true; } };
    const frame = { layout: nativeLayout(parseDocument('Reading')), y: 0, mode: 'page', dialog: { text: 'First\nSecond', hint: TRANSCRIPTION_HINT, status: 'Listening...' } };
    await display.send(frame); const top = display.reviewTop;
    frame.dialog = { text: 'Question', hint: TRANSCRIPTION_HINT, status: '', statusRight: true };
    await display.send(frame);
    assert(display.reviewTop > top); assert.equal(pages.length, 2);
    assert(pages[1].textObject.some(box => box.containerName === 'review-hint'));
  } finally { globalThis.window = prior; }
});


test('same-height review still rebuilds when text expands into the finished listening row', async () => {
  const prior = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const pages = [];
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } }); display.ready = true;
    display.bridge = { async rebuildPageContainer(page) { pages.push(page); return true; }, async textContainerUpgrade() { return true; } };
    const frame = { layout: nativeLayout(parseDocument('Reading')), y: 0, mode: 'page', dialog: { text: 'First', hint: TRANSCRIPTION_HINT, status: 'Listening...' } };
    await display.send(frame); const top = display.reviewTop;
    frame.dialog = { text: 'First\nSecond', hint: TRANSCRIPTION_HINT, status: '' };
    await display.send(frame); assert.equal(display.reviewTop, top); assert.equal(pages.length, 2);
    const get = name => pages[1].textObject.find(box => box.containerName === name);
    assert.equal(get('review-text').height, 54); assert.equal(get('status').yPosition, 253);
  } finally { globalThis.window = prior; }
});


test('document footer maps source PDF pages in raster, reflow, speed and partial layouts', () => {
  const blocks = [{ y: 0, drawHeight: 200, page: 1 }, { y: 212, drawHeight: 400, page: 3 },
    { y: 624, drawHeight: 100, page: 2, annotation: { kind: 'caption' } }];
  const layout = { format: 'pdf', blocks, rows: [], headings: Array(8), maxY: 624, pages: [0, 100, 212, 430, 624] };
  const frame = { layout, mode: 'page', y: 0 };
  assert.equal(documentPageText(frame), 'pg. 1');
  assert.equal(documentPageText({ ...frame, y: 205 }), 'pg. 3', 'skip whitespace before the next visible block');
  assert.equal(documentPageText({ ...frame, y: 212 }), 'pg. 3', 'reflow screens do not replace source page numbers');
  assert.equal(documentPageText({ ...frame, y: 624 }), 'pg. 2', 'deferred captions retain their original source');
  for (const wordFrame of [{ y: 212 }, { y: 212, heading: true }, { y: 212, image: true, page: 3 }]) {
    assert.equal(documentPageText({ ...frame, mode: 'speed', wordFrame }), 'pg. 3');
  }
  const partial = { ...layout, headings: Array(3), preparation: { complete: false, readyPages: 3, totalPages: 8 } };
  assert.match(statusText({ ...frame, layout: partial }), /^Preparing.*pg\. 1/);
  assert.equal(documentPageText({ ...frame, layout: { ...layout, sourcePages: Array(8), headings: undefined } }), 'pg. 1');
  assert.equal(documentPageText({ ...frame, layout: { ...layout, headings: undefined } }), 'pg. 1');
});

test('Markdown page number follows page boundaries and source position in every reading mode', () => {
  const layout = nativeLayout(parseDocument('```\n' + Array.from({ length: 100 }, (_, i) => `Line ${i}`).join('\n') + '\n```'));
  for (const [index, y] of layout.pages.entries()) {
    for (const mode of ['page', 'auto', 'speed']) assert.equal(documentPageText({ layout, mode, y }), `pg. ${index + 1}`);
  }
  assert.equal(documentPageText({ layout, y: layout.pages[1] - 1 }), 'pg. 1');
  assert.equal(documentPageText({ layout, mode: 'speed', y: 0, wordFrame: { y: layout.height } }), `pg. ${layout.pages.length}`);
  assert.equal(documentPageText({}), '');
});

test('source page stays visible alongside rate and right-aligned Ask notifications', () => {
  const layout = { format: 'pdf', rows: [], blocks: [{ y: 0, drawHeight: 1000, page: 299 }], headings: Array(300), maxY: 900 };
  for (const mode of ['page', 'auto', 'speed']) for (const askStatus of ['', ...Object.keys(ASK_STATUS_SYMBOLS)]) {
    const frame = { layout, y: 0, mode, speed: 200, wordRate: 1000, playing: false, pageRemainingSeconds: 36000, remainingSeconds: 36000, askStatus };
    const footer = statusText(frame);
    assert.match(footer, / +pg\. 299 +/);
    const prefix = footer.slice(0, footer.indexOf('pg. 299'));
    assert(Math.abs(12 + getTextWidth(prefix) + getTextWidth('pg. 299') / 2 - 288) <= getTextWidth(' ')); assert.match(footer, mode === 'page' ? /Tap(?:: Ask)?$/ : /(Double tap|2× tap|2×)(?:: Ask)?$/);
    assert(getTextWidth(footer) <= 552); assert(byteLength(footer) < 900);
    if (mode !== 'page') assert.match(footer, /Ⅱ (200|1000)/);
    assert.equal(statusText({ ...frame, message: { status: 'Conversation' } }), 'Conversation');
    assert.match(statusText({ ...frame, footnotes: true }), /^Footnotes/);
    assert.equal(statusText({ ...frame, dialog: { text: 'Speech', status: 'Listening...' } }), 'Listening...');
  }
});

test('playback rate and complete time estimate fit beside centered page and Ask in both reading modes', () => {
  for (const seconds of [18, 120, 6000, 86400]) {
    const rows = Array.from({ length: seconds * 200 / 60 }, (_, i) => ({ y: i * LINE_HEIGHT }));
    for (const format of ['markdown', 'pdf']) for (const mode of ['auto', 'speed']) for (const playing of [false, true]) for (const page of [1, 299, 9999]) {
      const layout = { format, rows, blocks: [{ y: 0, drawHeight: 200000, page }], maxY: 200000, pages: [0] };
      const frame = { layout, y: 0, mode, speed: 200, wordRate: 1000, playing, percent: 99, remainingSeconds: seconds, askStatus: 'Reply in progress' };
      const footer = statusText(frame), center = documentPageText(frame);
      assert(footer.includes(`${playing ? '▶' : 'Ⅱ'} ${mode === 'auto' ? 200 : 1000}`), footer);
      const time = readingTimeText(frame); assert(time); assert(footer.includes(time), footer);
      assert.doesNotMatch(footer, /…|Auto|Paused|Speed/);
      const prefix = footer.slice(0, footer.indexOf(center));
      assert(Math.abs(12 + getTextWidth(prefix) + getTextWidth(center) / 2 - 288) <= getTextWidth(' '), footer);
      assert(footer.endsWith('◐ Hold: speak · 2×: Ask')); assert(getTextWidth(footer) <= 552, footer);
    }
  }
});

test('Ask status symbols exist in the native font and retain full mode guidance at maximum rate', () => {
  for (const symbol of Object.values(ASK_STATUS_SYMBOLS)) assert(getAdvW(symbol.codePointAt(0)) > 0, symbol);
  const layout = { format: 'pdf', rows: [], blocks: [{ y: 0, drawHeight: 1000, page: 9999 }], maxY: 900 };
  for (const mode of ['page', 'auto', 'speed']) for (const [askStatus, symbol] of Object.entries(ASK_STATUS_SYMBOLS)) {
    const text = statusText({ layout, mode, y: 0, wordRate: 6000, speed: 200, playing: true, remainingSeconds: 7200, askStatus });
    assert(text.includes(`${symbol} Hold:`), text); assert.match(text, /Hold: ?speak · (Tap|2×): Ask$/);
    assert(getTextWidth(text) <= 552, text);
  }
});

test('PDF processing replaces Ask gestures with a fitting dim unavailable hint', () => {
  const layout = { format: 'pdf', rows: [], blocks: [{ y: 0, drawHeight: 1000, page: 9999 }], maxY: 900 };
  const frames = ['page', 'auto', 'speed'].flatMap(mode => [false, true].map(playing => ({
    layout, mode, playing, y: 0, wordRate: 6000, speed: 200, remainingSeconds: 7200,
    askStatus: 'PDF processing', askUnavailable: true,
  })));
  frames.push({ askUnavailable: true, message: { body: 'Opening PDF…', status: 'Loading PDF', kind: 'loading' } });
  for (const frame of frames) {
    const footer = statusText(frame), [status, commands] = footerTextObjects(frame);
    assert.match(footer, /Ask after loading$/);
    assert.doesNotMatch(footer, /Hold|Tap|2×/);
    assert.equal(status.textColor, 4); assert.equal(commands.textColor, 1);
    assert.equal(commands.content.trim(), 'Ask after loading');
    assert.doesNotMatch(status.content, /Ask after loading/);
    assert.match(status.content, frame.layout ? /pg\. 9999/ : /Loading PDF/);
    for (const box of [status, commands]) assert(getTextWidth(box.content) <= box.width);
    assert(getTextWidth(footer) <= 552, footer);
  }
});

test('only commands dim while footer status, icons, time and page numbers stay bright', () => {
  const layout = nativeLayout(parseDocument('A reading passage. '.repeat(100)));
  for (const mode of ['page', 'auto', 'speed']) for (const askStatus of ['', ...Object.keys(ASK_STATUS_SYMBOLS)]) {
    const frame = { layout, mode, playing: true, speed: 200, wordRate: 6000, y: 0, remainingSeconds: 7200, askStatus };
    const [status, commands] = footerTextObjects(frame);
    assert.equal(status.textColor, 4); assert.equal(commands.textColor, 1);
    assert.match(status.content, /pg\. 1/); assert.doesNotMatch(status.content, /[Tt]ap/);
    assert.match(commands.content.trim(), mode === 'page' ? /^Hold: speak · Tap: Ask$/ : /^Hold: speak · 2×(?: tap)?: Ask$/);
    if (askStatus) assert(status.content.endsWith(ASK_STATUS_SYMBOLS[askStatus]));
    if (mode !== 'page') assert.match(status.content, /▶ .*~2h|▶ 200 l\/min/);
    for (const box of [status, commands]) {
      assert(getTextWidth(box.content) <= box.width); assert(byteLength(box.content) < 900);
      const text = box.content.trimStart(), at = statusText(frame).indexOf(text);
      const x = getTextWidth(box.content.slice(0, box.content.length - text.length));
      assert(Math.abs(x - getTextWidth(statusText(frame).slice(0, at))) <= getTextWidth(' ') / 2);
    }
  }
  for (const frame of [
    { layout, mode: 'speed', finished: true },
    { layout, mode: 'speed', wordFrame: { image: true }, remainingSeconds: 120 },
    { positionPicker: { step: 1 } },
    { picker: openDocumentPicker([{ id: 'test.md', title: 'Test' }]) },
    { footnotes: true },
    { message: { kind: 'ask', statusLeft: 'Ask', statusCenter: '2 / 3', statusRight: 'Hold: speak · Tap: back' } },
  ]) {
    const [status, commands] = footerTextObjects(frame);
    assert.doesNotMatch(status.content, /Tap|Hold|Swipe/);
    assert.match(commands.content, /Tap|Hold|Swipe/);
    assert.doesNotMatch(commands.content, /Finished|Image|Footnotes|2 \/ 3|~2m/);
    assert(getTextWidth(commands.content) <= commands.width);
  }
});
