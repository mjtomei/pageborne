import { waitForEvenAppBridge, ImageRawDataUpdateResult } from '@evenrealities/even_hub_sdk';
import { WIDTH, HEIGHT, BODY_TOP, BODY_HEIGHT, MARGIN, rowAt } from './document.js';
import { textWindow, titleText, LINE_HEIGHT, byteLength } from './native-text.js';
import { documentPickerText } from './document-picker.js';
import { positionPickerText } from './position-picker.js';
import { documentContents } from './document-contents.js';
import { LatestFrameQueue, autoSpeed } from './reader.js';
import { BridgeLane } from './diagnostics.js';
import { actionForEvent, appMenu, READING_MODES } from './controls.js';
import { PDF_WIDTH } from './pdf-layout.js';
import { getTextWidth } from '@evenrealities/pretext';
import { MESSAGE_WIDTH } from './ask-conversation.js';

import { transcriptionGeometry } from './transcription-review.js';
import { nativeTranscriptRuns } from './transcription-confidence.js';
import { ASK_STATUS_SYMBOLS } from './ask-status.js';
const frameDialog = frame => frame.dialog || frame.message?.dialog;
// Level 2 was barely distinguishable on glasses; level 1 was visibly dimmer.
const SECONDARY_TEXT_COLOR = 1;
// Center on the reading area's line grid so surrounding rows keep their places.
export const MODE_POPUP = Object.freeze({ x: MARGIN, y: Math.round((BODY_HEIGHT - 5 * LINE_HEIGHT) / 2 / LINE_HEIGHT) * LINE_HEIGHT,
  width: 228, height: 5 * LINE_HEIGHT, padding: 14, rowHeight: 40 });
const modePopupText = index => READING_MODES.map((mode, i) => `${i === index ? '> ' : '  '}${mode.label}`).join('\n');

// Prose uses native text; PDF figures and unrecognized scans carry a raster.
export function paintFrame(ctx, frame) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const dialog = frameDialog(frame);
  const geometry = dialog && transcriptionGeometry(dialog);
  ctx.fillStyle = '#aaa'; ctx.font = '20px sans-serif'; ctx.textBaseline = 'top';
  ctx.save(); ctx.beginPath(); ctx.rect(0, BODY_TOP, WIDTH, geometry?.top ?? BODY_HEIGHT); ctx.clip();
  ctx.fillStyle = '#fff'; ctx.font = '22px sans-serif';
  if (frame.bitmap && !frame.picker && !frame.positionPicker) ctx.drawImage(frame.bitmap, 0, BODY_TOP);
  else bodyText(frame).split('\n').slice(0, geometry?.bodyLines).forEach((line, index) => {
    const role = frame.message?.alignments?.[index], right = role === 'user';
    ctx.fillStyle = role === 'activity' ? '#aaa' : '#fff';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(right ? line.trimStart() : line, right ? WIDTH - MARGIN - 8 : MARGIN, BODY_TOP + index * LINE_HEIGHT, role ? MESSAGE_WIDTH : WIDTH - 2 * MARGIN - 8);
  });
  ctx.restore();
  if (frame.modePicker) {
    const p = MODE_POPUP;
    // Solid pixel edges stay visible when iOS scales down the phone preview.
    ctx.fillStyle = '#aaa'; ctx.fillRect(p.x, p.y, p.width, p.height);
    ctx.fillStyle = '#000'; ctx.fillRect(p.x + 1, p.y + 1, p.width - 2, p.height - 2);
    ctx.fillStyle = '#fff'; ctx.font = '22px sans-serif';
    modePopupText(frame.modePicker.index).split('\n').forEach((line, i) => ctx.fillText(line, p.x + p.padding, p.y + p.padding + i * p.rowHeight));
  }
  if (dialog) {
    ctx.fillStyle = '#000'; ctx.fillRect(0, geometry.top, WIDTH, geometry.height);
    for (const box of reviewTextObjects(dialog)) {
      if (box.borderWidth) { ctx.strokeStyle = '#aaa'; ctx.lineWidth = 1; ctx.strokeRect(box.xPosition, box.yPosition, box.width, box.height); }
      ctx.fillStyle = box.textColor === SECONDARY_TEXT_COLOR ? '#aaa' : '#fff'; ctx.font = '22px sans-serif';
      box.content.split('\n').forEach((line, i) => ctx.fillText(line, box.xPosition + box.paddingLength, box.yPosition + box.paddingLength + i * LINE_HEIGHT, box.width - 2 * box.paddingLength));
    }
  }
  ctx.font = '20px sans-serif'; ctx.fillStyle = '#fff';
  const notification = footerColumns(frame);
  if (notification) {
    ctx.save(); ctx.textAlign = 'left'; paintFooterText(ctx, notification.left, notification.leftCommands, MARGIN, 260, notification.leftWidth);
    if (notification.center) { ctx.textAlign = 'center'; ctx.fillText(notification.center, WIDTH / 2, 260); }
    ctx.textAlign = 'right'; paintFooterText(ctx, notification.right, [notification.right.slice(notification.rightStatus?.length || 0).trimStart()], WIDTH - MARGIN - 8, 260); ctx.restore();
  } else {
    ctx.save(); ctx.textAlign = dialog?.statusRight ? 'right' : 'left';
    if (!dialog && footerCommandSpans(frame).length) ctx.fillStyle = '#aaa';
    ctx.fillText(statusText(frame), dialog?.statusRight ? 552 : dialog ? 24 : MARGIN, dialog ? geometry.controlsTop : 260, dialog ? geometry.statusWidth : 552); ctx.restore();
  }
}
export function readingTimeText(frame) {
  if (frame.mode !== 'speed' && frame.mode !== 'page' && !frame.layout?.rows.length) return '';
  const seconds = frame.mode === 'page' ? frame.pageRemainingSeconds : frame.mode === 'speed' ? frame.remainingSeconds
    : (frame.layout.rows.length - rowAt(frame.layout, frame.y || 0)) * 60 / autoSpeed(frame.speed);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds > 0 && seconds < 60) return '<1m';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `~${minutes}m` : `~${Math.round(seconds / 3600)}h`;
}
export function bodyText(frame) {
  if (frame.positionPicker) return positionPickerText(frame.positionPicker, frame.layout);
  return frame.picker ? documentPickerText(frame.picker) : frame.message?.body ?? frame.wordFrame?.content ?? frame.nativePdf?.content ?? textWindow(frame.layout, frame.y).content;
}
function askNotification(frame) {
  if (frameDialog(frame) || frame.positionPicker || frame.picker || frame.message || frame.footnotes || !frame.layout) return null;
  const center = documentPageText(frame);
  const centerWidth = (WIDTH - 2 * MARGIN - getTextWidth(center)) / 2 - 20;
  const rightWidth = center ? centerWidth - 8 : 352;
  const taps = frame.mode === 'page' ? ['Tap'] : ['Double tap', '2× tap', '2×'];
  const symbol = ASK_STATUS_SYMBOLS[frame.askStatus];
  // Preserve both commands beside the centered page and status symbol.
  // Compact double-tap wording before removing spaces around the colons.
  const prefix = !frame.askUnavailable && symbol ? `${symbol} ` : '';
  const candidates = frame.askUnavailable ? ['Ask after loading', 'Ask unavailable']
    : frame.voiceUnavailable ? taps.map(tap => `Voice paused · ${tap}: Ask`)
    : [...taps.map(tap => `${prefix}Hold: speak · ${tap}: Ask`),
      `${prefix}Hold:speak · ${taps.at(-1)}: Ask`, `${prefix}Hold:speak · ${taps.at(-1)}:Ask`];
  const right = candidates.find(text => getTextWidth(text) <= rightWidth) || '';
  const leftWidth = center ? centerWidth : WIDTH - 2 * MARGIN - 8 - getTextWidth(right) - 20;
  let left = readingStateText(frame);
  // Keep the rate and estimate together even on PDF steps or long page labels.
  if (frame.mode !== 'page' && getTextWidth(left) > leftWidth) left = readingStateText(frame, false);
  return { left: titleText(left, leftWidth), center, right, leftWidth, rightStatus: prefix,
    leftCommands: ['Tap: restart', 'Tap: next'] };
}
function footerColumns(frame) {
  if (frameDialog(frame)) return null;
  if (frame.positionPicker?.kind === 'contents') return actionFooter('Swipe: section', 'Tap: read · Double tap: back', ['Swipe: section']);
  if (frame.positionPicker) return actionFooter(`Swipe ${frame.positionPicker.step || 5}%`, `Hold: ${frame.positionPicker.step === 1 ? 5 : 1}% · Tap to read`, [`Swipe ${frame.positionPicker.step || 5}%`]);
  if (frame.picker?.kind === 'terminal-sessions') return actionFooter('Swipe: session', 'Tap: open · Hold: refresh', ['Swipe: session']);
  if (frame.picker) {
    const { items, syncEnabled, syncing, syncStatus } = frame.picker;
    const actions = [items.length && 'Tap to open', syncEnabled && !syncing && 'Hold to sync'].filter(Boolean).join(' · ');
    return actionFooter(syncStatus || (syncing ? 'Syncing…' : items.length ? 'Swipe to choose' : 'Add files on your phone'), actions,
      !syncStatus && !syncing ? ['Swipe to choose', 'Add files on your phone'] : []);
  }
  if (frame.askUnavailable && frame.message?.kind === 'loading') return actionFooter(frame.message.status || 'Loading PDF', 'Ask after loading');
  if (frame.message?.statusRight) {
    const right = titleText(frame.message.statusRight, 352);
    const center = frame.message.statusCenter || '';
    const leftWidth = center ? (WIDTH - 2 * MARGIN - getTextWidth(center)) / 2 - 20
      : WIDTH - 2 * MARGIN - 8 - getTextWidth(right) - 20;
    return { left: titleText(frame.message.statusLeft || 'Ask', leftWidth), center, right, leftWidth };
  }
  if (frame.footnotes) return actionFooter(frame.message ? 'Footnotes' : 'Footnotes · Swipe to read', 'Tap to return', ['Swipe to read']);
  return askNotification(frame);
}
function actionFooter(left, right, leftCommands = []) {
  const leftWidth = WIDTH - 2 * MARGIN - 8 - getTextWidth(right) - 20;
  return { left: left ? titleText(left, leftWidth) : '', right, leftWidth, leftCommands };
}

function commandSpans(text, commands = []) {
  return commands.filter(Boolean).flatMap(command => {
    const start = text.indexOf(command);
    return start < 0 ? [] : [{ start, end: start + command.length }];
  }).sort((a, b) => a.start - b.start);
}
function footerCommandSpans(frame, text = statusText(frame)) {
  const columns = footerColumns(frame);
  if (!columns) return !frameDialog(frame) && /^(Open phone|Add files|Tap|Hold|Swipe)\b/.test(text) ? [{ start: 0, end: text.length }] : [];
  const spans = commandSpans(columns.left, columns.leftCommands);
  const command = columns.right.slice(columns.rightStatus?.length || 0).trimStart();
  if (command) { const start = text.lastIndexOf(command); if (start >= 0) spans.push({ start, end: start + command.length }); }
  return spans;
}
function coloredFooterRuns(text, spans) {
  const runs = []; let start = 0;
  for (const span of spans) {
    if (span.start > start) runs.push({ start, text: text.slice(start, span.start), color: 4 });
    runs.push({ start: span.start, text: text.slice(span.start, span.end), color: SECONDARY_TEXT_COLOR }); start = span.end;
  }
  if (start < text.length) runs.push({ start, text: text.slice(start), color: 4 });
  return runs;
}
function paintFooterText(ctx, text, commands, x, y, width = Infinity) {
  const measured = ctx.measureText(text).width, scale = Math.min(1, width / (measured || 1));
  ctx.save(); ctx.translate(x - (ctx.textAlign === 'right' ? measured * scale : 0), y); ctx.scale(scale, 1); ctx.textAlign = 'left';
  for (const run of coloredFooterRuns(text, commandSpans(text, commands))) {
    ctx.fillStyle = run.color === SECONDARY_TEXT_COLOR ? '#aaa' : '#fff';
    ctx.fillText(run.text, ctx.measureText(text.slice(0, run.start)).width, 0);
  }
  ctx.restore();
}
export function footerTextObjects(frame) {
  const text = statusText(frame) || ' ', runs = coloredFooterRuns(text, footerCommandSpans(frame, text));
  // Two transparent native text layers preserve the full footer within the
  // container budget. Spaces have no pixels; measured gaps retain alignment.
  return [4, SECONDARY_TEXT_COLOR].map((color, index) => {
    let content = '';
    for (const run of runs.filter(run => run.color === color)) {
      const x = getTextWidth(text.slice(0, run.start));
      content += ' '.repeat(Math.max(0, Math.round((x - getTextWidth(content)) / getTextWidth(' ')))) + run.text;
    }
    return { containerID: index ? 9 : 3, containerName: index ? 'commands' : 'status', xPosition: MARGIN, yPosition: 260,
      width: WIDTH - 2 * MARGIN, height: 28, content: content.trimEnd() || ' ', textColor: color, isEventCapture: 0, paddingLength: 0, borderWidth: 0 };
  });
}
export function statusText(frame) {
  if (frameDialog(frame)) return frameDialog(frame).status ? titleText(frameDialog(frame).status, 528) : ' ';
  const notification = footerColumns(frame);
  if (notification) {
    let { left, right, center } = notification;
    if (center) {
      const centerStart = (WIDTH - 2 * MARGIN - getTextWidth(center)) / 2;
      left += ' '.repeat(Math.max(1, Math.floor((centerStart - getTextWidth(left)) / getTextWidth(' ')))) + center;
    }
    if (!right) return left;
    const gap = Math.max(1, Math.floor((WIDTH - 2 * MARGIN - 8 - getTextWidth(left + right)) / getTextWidth(' ')));
    return left + ' '.repeat(gap) + right;
  }
  if (frame.message) return frame.message.status;
  return readingStatusText(frame);
}
// PDF source pages survive reflow and figure extraction. Markdown has no
// source pagination, so use its prepared glasses-page boundaries instead.
export function documentPageText(frame) {
  const layout = frame.layout;
  if (!layout) return '';
  const y = frame.mode === 'speed' ? frame.wordFrame?.y ?? frame.y ?? 0 : frame.y ?? 0;
  const items = layout.format === 'pdf' ? layout.blocks : layout.pages;
  if (!items?.length) return '';
  let low = 0, high = items.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((layout.format === 'pdf' ? items[mid].y : items[mid]) <= y + .5) low = mid + 1;
    else high = mid;
  }
  const index = Math.max(0, low - 1);
  if (layout.format !== 'pdf') return `pg. ${index + 1}`;
  const block = items[index];
  // In inter-block whitespace, the next block supplies the first visible text.
  const visible = y >= block.y + block.drawHeight && items[index + 1] ? items[index + 1] : block;
  const page = visible.page;
  return page ? `pg. ${page}` : '';
}
function readingStatusText(frame) {
  return [documentPageText(frame), readingStateText(frame)].filter(Boolean).join('  ');
}
function readingStateText(frame, includePercent = true) {
  const preparing = frame.layout?.preparation;
  if (preparing?.complete === false) {
    const atEnd = frame.mode === 'speed' ? frame.finished : frame.y >= frame.layout.maxY;
    const state = preparing.failed ? 'Preparation stopped' : atEnd ? 'Preparing more' : 'Preparing';
    return `${state} · ${preparing.readyPages}/${preparing.totalPages}`;
  }
  // These play/pause glyphs are present in the native glasses font (⏸ is not).
  const playback = frame.playing ? '▶' : 'Ⅱ';
  if (frame.mode === 'speed') return `${frame.finished || !includePercent ? '' : `${Math.round(frame.percent || 0)}% `}${frame.finished ? 'Finished · Tap: restart' : frame.wordFrame?.image
    ? 'Image · Tap: next' : frame.wordFrame?.heading
      ? frame.pauseAtTitles ? 'Title · Tap: next' : `Title · ${playback} ${frame.wordRate / 2} wpm`
      : `${playback} ${frame.wordRate} wpm`}${!frame.finished && readingTimeText(frame) ? ` ${readingTimeText(frame)}` : ''}`;
  const percent = frame.layout?.maxY ? Math.round(frame.y / frame.layout.maxY * 100) : 0;
  if (frame.mode === 'auto') return `${includePercent ? `${percent}% ` : ''}${playback} ${autoSpeed(frame.speed)} ${frame.layout?.format === 'pdf' ? 'steps/min' : 'l/min'} ${readingTimeText(frame)}`.trimEnd();
  return `${percent}%  Pages${readingTimeText(frame) ? `  ${readingTimeText(frame)}` : ''}`;
}
export const PDF_TILES = Array.from({ length: 4 }, (_, i) => ({ x: i % 2 * (PDF_WIDTH / 2), y: Math.floor(i / 2) * 129,
  width: PDF_WIDTH / 2, height: 129, id: 10 + i, name: `pdf-${i}` }));
function pdfTiles(height = BODY_HEIGHT) {
  return PDF_TILES.map(tile => ({ ...tile, height: Math.max(0, Math.min(tile.height, height - tile.y)) })).filter(tile => tile.height);
}
function menuDefinition(content) {
  return { menuItems: appMenu(content.askMenu ?? content.kind === 'ask', content.contentsMenu).map(({ itemName, itemID }) => ({ itemName, itemID })) };
}
export function pdfPageDefinition(height = BODY_HEIGHT, content = {}) {
  const tiles = pdfTiles(height);
  const textObject = [
    { xPosition: 0, yPosition: 0, width: PDF_WIDTH, height: BODY_HEIGHT, containerID: 4,
      containerName: 'page-input', content: ' ', isEventCapture: 1, paddingLength: 0, borderWidth: 0, zOrderIndex: 0 },
    ...(content.footer || footerTextObjects({ message: { status: content.status || 'PDF' } })),
  ];
  textObject.forEach((box, i) => { box.zOrderIndex = i ? tiles.length + i : 0; });
  return { containerTotalNum: textObject.length + tiles.length, textObject, imageObject: tiles.map((tile, i) => ({ xPosition: tile.x, yPosition: tile.y,
    width: tile.width, height: tile.height, containerID: tile.id, containerName: tile.name, zOrderIndex: i + 1 })), menuObject: menuDefinition(content) };
}
export function gray4(data) {
  const result = new Uint8Array(data.length / 8);
  for (let i = 0; i < result.length; i++) result[i] = (Math.round(data[i * 8] / 17) << 4) | Math.round(data[i * 8 + 4] / 17);
  return result;
}
export function bodyTextObjects(content) {
  const body = content.body ?? 'Opening your saved library…';
  const lines = body.split('\n'), roles = content.alignments || [];
  const dimmed = lines.some((line, i) => line.trim() && roles[i] === 'activity');
  const box = (containerID, containerName, text, textColor) => ({
    xPosition: MARGIN, yPosition: BODY_TOP, width: WIDTH - 2 * MARGIN, height: BODY_HEIGHT,
    containerID, containerName, content: text || ' ', textColor, isEventCapture: 0, paddingLength: 0, borderWidth: 0,
  });
  // Whole blank lines preserve vertical positions without variable-width
  // space masks. Two layers suffice regardless of the number of activities.
  return [box(1, 'body', dimmed ? lines.map((line, i) => roles[i] === 'activity' ? '' : line).join('\n') : body, 4),
    ...(dimmed ? [box(23, 'activity', lines.map((line, i) => roles[i] === 'activity' ? line : '').join('\n'), SECONDARY_TEXT_COLOR)] : [])];
}

export function pageDefinition(mode = 'page', content = {}) {
  const textObject = [
    // A blank capture surface receives gestures in both modes. The visible
    // body never rubberbands or scrolls independently of the reading position.
    { xPosition: MARGIN, yPosition: BODY_TOP, width: WIDTH - 2 * MARGIN, height: BODY_HEIGHT,
      containerID: 4, containerName: 'page-input', content: ' ', isEventCapture: 1, paddingLength: 0, borderWidth: 0 },
    ...bodyTextObjects(content),
    ...(content.footer || footerTextObjects({ message: { status: content.status ?? 'Native text' } })),
  ];
  textObject.forEach((box, i) => { box.zOrderIndex = i; });
  return { containerTotalNum: textObject.length, textObject, menuObject: menuDefinition(content) };
}

export function modePageDefinition(content, index, pdf = false) {
  const page = pdf ? pdfPageDefinition(BODY_HEIGHT, content) : pageDefinition('page', content), p = MODE_POPUP;
  for (const body of page.textObject.filter(box => ['body', 'activity'].includes(box.containerName))) {
    // Blank only the popup's columns in the existing body. This preserves
    // three individually positioned menu items plus both footer colors.
    const lines = body.content.split('\n'), firstRow = p.y / LINE_HEIGHT, coveredRows = p.height / LINE_HEIGHT;
    const x = p.x + p.width + 8;
    for (let i = 0; i < coveredRows; i++) {
      const row = firstRow + i;
      const chars = [...(lines[row] || '')]; let start = 0;
      while (start < chars.length && MARGIN + getTextWidth(chars.slice(0, start).join('')) < x) start++;
      const offset = getTextWidth(chars.slice(0, start).join(''));
      lines[row] = ' '.repeat(Math.max(0, Math.round(offset / getTextWidth(' ')))) + chars.slice(start).join('');
    }
    body.content = lines.join('\n') || ' ';
  }
  page.textObject.push({ containerID: 19, containerName: 'mode-picker', xPosition: p.x, yPosition: p.y, width: p.width, height: p.height,
    content: ' ', isEventCapture: 0, borderWidth: 1, borderColor: 10, borderRadius: 4, paddingLength: 0 });
  if (page.textObject.some(box => box.containerName === 'activity')) {
    page.textObject = page.textObject.filter(box => box.containerName !== 'page-input');
    page.textObject.find(box => box.containerName === 'mode-picker').isEventCapture = 1;
  }
  modePopupText(index).split('\n').forEach((line, i) => page.textObject.push({ containerID: 20 + i, containerName: `mode-option-${i}`,
    xPosition: p.x + p.padding, yPosition: p.y + p.padding + i * p.rowHeight, width: p.width - 2 * p.padding, height: LINE_HEIGHT,
    content: line, isEventCapture: 0, paddingLength: 0, borderWidth: 0 }));
  page.textObject.forEach((box, i) => { box.zOrderIndex = i ? (page.imageObject?.length || 0) + i : 0; });
  page.containerTotalNum = page.textObject.length + (page.imageObject?.length || 0);
  return page;
}

function reviewTextObjects(dialog, limit = 4) {
  const geometry = transcriptionGeometry(dialog);
  const box = (id, name, x, y, width, height, content, borderWidth = 0, paddingLength = 0) => ({
    containerID: id, containerName: name, xPosition: x, yPosition: y, width, height,
    content, borderWidth, borderColor: 10, borderRadius: 4, paddingLength, isEventCapture: 0,
  });
  const hint = dialog.hint;
  const { runs } = nativeTranscriptRuns(dialog.text, dialog.dimmed ? [] : dialog.uncertain, limit);
  return [{ ...box(5, 'review-panel', 12, geometry.top, 552, geometry.height, ' ', 1), isEventCapture: 1 },
    ...runs.map((run, index) => ({ ...box(index ? 15 + index : 7, index ? `review-run-${index}` : 'review-text',
      24 + run.x, geometry.top + 8 + run.y, run.width, run.height, run.content),
      textColor: dialog.dimmed ? SECONDARY_TEXT_COLOR : run.color })),
    ...(hint ? [{ ...box(8, 'review-hint', 552 - geometry.hintWidth, 253, geometry.hintWidth, LINE_HEIGHT,
      ' '.repeat(Math.max(0, Math.floor((geometry.hintWidth - getTextWidth(hint)) / getTextWidth(' ')))) + hint), textColor: SECONDARY_TEXT_COLOR }] : [])];
}
export function reviewPageDefinition(content, dialog, pdf = false) {
  const geometry = transcriptionGeometry(dialog);
  const page = pdf ? pdfPageDefinition(geometry.top, content) : pageDefinition('page', content);
  // The blank panel also captures input, freeing a container for word colors.
  page.textObject = page.textObject.filter(box => !['page-input', 'commands'].includes(box.containerName));
  for (const body of page.textObject.filter(box => ['body', 'activity'].includes(box.containerName))) {
    body.height = geometry.top; body.content = body.content.split('\n').slice(0, geometry.bodyLines).join('\n') || ' ';
  }
  Object.assign(page.textObject.find(box => box.containerName === 'status'), { content: dialog.statusRight
    ? ' '.repeat(Math.max(0, Math.floor((528 - getTextWidth(content.status)) / getTextWidth(' ')))) + content.status
    : content.status, xPosition: 24, yPosition: geometry.controlsTop, width: geometry.statusWidth, textColor: 4 });
  page.textObject.push(...reviewTextObjects(dialog, page.textObject.some(box => box.containerName === 'activity') ? 3 : 4));
  page.textObject.forEach((box, i) => { box.zOrderIndex = i ? (page.imageObject?.length || 0) + i : 0; });
  page.containerTotalNum = page.textObject.length + (page.imageObject?.length || 0);
  return page;
}

export class GlassesDisplay {
  constructor({ onStatus, onAction, onAudio = () => {}, onAccepted = () => {}, onReadingAccepted = () => {}, diagnostics }) {
    this.onAccepted = onAccepted; this.onReadingAccepted = onReadingAccepted;
    this.onStatus = onStatus; this.onAction = onAction; this.onAudio = onAudio; this.diagnostics = diagnostics;
    this.lane = new BridgeLane(diagnostics);
    this.ready = false; this.suspended = false; this.created = false; this.lastFrame = null; this.sent = {}; this.surface = 'text'; this.askMenu = false; this.contentsMenu = false;
    this.recoveryAttempts = 0;
    window.addEventListener('flutterInAppWebViewPlatformReady', () => this.connect());
  }
  async connect(automatic = false) {
    if (this.connecting) return this.connecting;
    if (!automatic) this.recoveryAttempts = 0;
    if (!window.flutter_inappwebview?.callHandler) { this.onStatus('Phone preview · Open in the Even app for glasses'); return; }
    // Cached PDFs read their layout while startup connects. Storage calls use
    // this same lane; setup can safely queue behind them. Only an outstanding
    // display operation should block a manual reconnect.
    if (this.lane.busy && !this.diagnostics.active?.name.startsWith('storage-')) {
      this.recover();
      this.onStatus('Display call still pending. Close and reopen the reader to reconnect.'); return;
    }
    this.recovery = null;
    this.connecting = this.setup().catch(error => this.fail(error)).finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async setup() {
    this.ready = false; this.queue?.stop(); this.onStatus('Connecting native text…');
    this.bridge = await waitForEvenAppBridge();
    const mode = this.lastFrame?.mode || 'page';
    const content = this.lastFrame && !this.lastFrame.bitmap ? { body: bodyText(this.lastFrame), alignments: this.lastFrame.message?.alignments, status: statusText(this.lastFrame), footer: footerTextObjects(this.lastFrame) }
      : { body: this.lastFrame?.bitmap ? 'Opening PDF…' : 'Opening your saved library…', status: 'Loading' };
    content.askMenu = this.lastFrame?.askMenu ?? this.lastFrame?.message?.kind === 'ask';
    content.contentsMenu = documentContents(this.lastFrame?.layout).length > 0;
    await this.lane.run('setup', async () => {
      if (this.created) {
        if (!await this.bridge.rebuildPageContainer(pageDefinition(mode, content))) throw new Error('Could not rebuild the text page.');
      } else {
        const result = await this.bridge.createStartUpPageContainer(pageDefinition(mode, content));
        if (result !== 0) throw new Error(`Could not create the text page (${result}). Close and reopen the reader.`);
        this.created = true;
      }
    });
    this.unsubscribe?.();
    this.unsubscribe = this.bridge.onEvenHubEvent(event => this.handleEvent(event));
    // Serialize frames, but give each native call its own timeout. A complete
    // four-tile image can take longer than eight seconds while making progress.
    this.queue = new LatestFrameQueue(frame => this.send(frame), error => this.fail(error));
    this.sent = {}; this.surface = 'text'; this.askMenu = content.askMenu; this.contentsMenu = content.contentsMenu; this.displayMode = mode; this.acceptedFrame = null; this.readingFrame = null; this.suspended = false; this.ready = true;
    this.onStatus('Native text connected'); this.diagnostics.log('ready');
    if (this.lastFrame) this.submit(this.lastFrame);
  }
  handleEvent(event, source = 'glasses') {
    if (event.audioEvent?.audioPcm) this.onAudio(event.audioEvent.audioPcm);
    const action = actionForEvent(event);
    if (!action) return;
    this.diagnostics.log('gesture', { action, source });
    if (action === 'exit') { this.recovery = null; this.ready = false; this.created = false; this.queue.stop(); this.onStatus('Glasses app closed'); }
    if (action === 'suspend') { this.suspended = true; this.queue.pending = null; }
    if (action === 'resume') { this.suspended = false; if (!this.ready) this.recover(); else if (this.lastFrame) this.submit(this.lastFrame); }
    this.onAction(action, source);
  }
  close() {
    // A close request also cancels recovery while a timed-out call is pending.
    this.recovery = null;
    if (!this.ready) { this.suspended = true; return; }
    if (this.closing) return;
    this.suspended = true; this.queue.pending = null; this.onAction('close');
    this.closing = this.lane.run('exit', async () => {
      if (!await this.bridge.shutDownPageContainer(1)) throw new Error('Exit request failed.');
    }).catch(error => this.fail(error)).finally(() => { this.closing = null; });
  }
  fail(error) {
    this.ready = false; this.queue?.stop();
    this.failure = error;
    this.diagnostics.error?.('display-error', error, { operation: error.operation, ...error.context, surface: this.surface });
    this.diagnostics.log('display-paused', { message: String(error.message).slice(0, 300) });
    this.onStatus(`Display paused: ${error.message}`); this.onAction('suspend');
    this.recover();
  }
  recover() {
    if (this.failure?.code !== 'bridge-timeout' || this.recovery || !this.created || this.recoveryAttempts >= 2) return;
    const ticket = this.recovery = {};
    // A timeout does not cancel the native operation. Rebuild only after it
    // settles, never overlap BLE calls, and resume at the latest requested view.
    this.lane.tail.catch(() => {}).then(async () => {
      if (this.recovery !== ticket) return;
      this.recovery = null;
      if (this.suspended || !this.created || this.ready) return;
      this.diagnostics.log('display-recovery', { attempt: ++this.recoveryAttempts });
      await this.connect(true);
    });
  }
  interrupted(frame) {
    if (this.suspended || !this.ready) return true;
    const next = this.queue?.pending;
    // Abandon obsolete tiles between calls, but let footer-only updates wait
    // for the image to finish instead of continually restarting its transfer.
    return !!next && (next.layout !== frame.layout || next.y !== frame.y || next.mode !== frame.mode
      || next.selection !== frame.selection || next.bitmap !== frame.bitmap || next.wordFrame?.start !== frame.wordFrame?.start
      || next.message?.body !== frame.message?.body || next.dialog !== frame.dialog
      || !!next.picker !== !!frame.picker || !!next.positionPicker !== !!frame.positionPicker || !!next.modePicker !== !!frame.modePicker);
  }
  submit(frame) {
    this.lastFrame = frame;
    if (this.ready && !this.suspended) this.queue.submit(frame);
  }
  async send(frame) {
    const start = performance.now();
    const pdf = !!frame.bitmap && !frame.picker && !frame.positionPicker;
    const window = frame.nativePdf || (pdf ? { start: rowAt(frame.layout, frame.y), end: rowAt(frame.layout, frame.y + BODY_HEIGHT) } : textWindow(frame.layout, frame.y));
    const askMenu = frame.askMenu ?? frame.message?.kind === 'ask';
    const contentsMenu = documentContents(frame.layout).length > 0;
    const content = { body: pdf ? '' : bodyText(frame), alignments: frame.message?.alignments, status: statusText(frame), footer: footerTextObjects(frame), askMenu, contentsMenu };
    if (this.interrupted(frame)) return;
    const dialog = frameDialog(frame);
    const reading = !!frame.layout && !dialog && !frame.message && !frame.picker && !frame.positionPicker && !frame.modePicker && !frame.footnotes;
    if (!reading) this.readingFrame = null;
    const reviewTop = dialog ? transcriptionGeometry(dialog).top : null;
    const activity = !pdf && bodyTextObjects(content).length > 1;
    const surface = (dialog ? `review-${pdf ? 'pdf' : 'text'}` : frame.modePicker ? `mode-${pdf ? 'pdf' : 'text'}` : pdf ? 'pdf' : 'text') + (activity ? '-activity' : '');
    const reviewPage = dialog && reviewPageDefinition(content, dialog, pdf);
    const reviewControls = reviewPage ? JSON.stringify(reviewPage.textObject.map(box =>
      [box.containerName, box.xPosition, box.yPosition, box.width, box.height])) : null;
    const overlayPage = reviewPage || (frame.modePicker && modePageDefinition(content, frame.modePicker.index, pdf));
    const rebuild = surface !== this.surface || askMenu !== this.askMenu || contentsMenu !== this.contentsMenu || !!dialog && (reviewTop !== this.reviewTop || reviewControls !== this.reviewControls);
    const updates = overlayPage ? overlayPage.textObject.filter(box => !['page-input', 'review-panel'].includes(box.containerName))
      : [...(pdf ? [] : bodyTextObjects(content)), ...content.footer];
    if (this.diagnostics.enabled) {
      this.diagnostics.display = { screen: frame.message?.kind || 'reader', surface, accepted: false,
        rebuild,
        containers: updates.map(box => ({ name: box.containerName, bytes: byteLength(box.content) })) };
      this.diagnostics.log('display-frame', this.diagnostics.display);
    }
    // Content changes use native text updates. Line count or controls changes
    // rebuild geometry, including the clipped PDF tiles underneath.
    if (rebuild) {
      if (!await this.lane.run('display-rebuild', () => this.bridge.rebuildPageContainer(overlayPage || (pdf ? pdfPageDefinition(BODY_HEIGHT, content) : pageDefinition(frame.mode, content))), { context: { surface } })) throw new Error('Could not switch the display format.');
      this.surface = surface; this.askMenu = askMenu; this.contentsMenu = contentsMenu; this.reviewTop = reviewTop; this.reviewControls = reviewControls; this.sent = pdf ? {} : Object.fromEntries(updates.map(box => [box.containerName, box.content]));
      this.sentColors = Object.fromEntries(updates.map(box => [box.containerName, box.textColor ?? 4])); this.imageFrame = null; this.imageTiles = new Map();
      this.onStatus(pdf ? 'Images connected' : 'Native text connected');
    }
    if (pdf && (this.imageFrame?.layout !== frame.layout || this.imageFrame?.y !== frame.y || this.imageFrame?.mode !== frame.mode
      || this.imageFrame?.wordFrame?.start !== frame.wordFrame?.start)) {
      const ctx = frame.bitmap.getContext('2d');
      for (const tile of pdfTiles(reviewTop ?? BODY_HEIGHT)) {
        if (this.interrupted(frame)) return;
        const pixels = ctx.getImageData(tile.x, tile.y, tile.width, tile.height).data;
        if (frame.modePicker) {
          // Text containers do not expose an opaque background. Blank only the
          // popup rectangle in this transfer, leaving the cached figure intact.
          const p = MODE_POPUP;
          for (let y = Math.max(tile.y, p.y); y < Math.min(tile.y + tile.height, p.y + p.height); y++) {
            const from = ((y - tile.y) * tile.width + Math.max(0, p.x - tile.x)) * 4;
            const to = ((y - tile.y) * tile.width + Math.max(0, Math.min(tile.width, p.x + p.width - tile.x))) * 4;
            pixels.fill(0, from, to);
          }
        }
        const imageData = gray4(pixels);
        const previous = this.imageTiles?.get(tile.id);
        if (previous?.length === imageData.length && imageData.every((value, index) => value === previous[index])) continue;
        const result = await this.lane.run('image-tile', () => this.bridge.updateImageRawData({ containerID: tile.id, containerName: tile.name, imageData: Array.from(imageData) }),
          { context: { container: tile.name, tile: tile.id - 9, bytes: imageData.length } });
        if (!ImageRawDataUpdateResult.isSuccess(result)) throw new Error(`PDF image update failed (${result}).`);
        (this.imageTiles ||= new Map()).set(tile.id, imageData);
      }
      this.imageFrame = frame;
    }
    if (this.interrupted(frame)) return;
    if (reading && pdf) this.acceptReading(frame);
    for (const box of updates) {
      const { containerName: name, containerID: id, content: value, textColor } = box;
      if (this.interrupted(frame)) return;
      if (value !== this.sent[name] || (textColor ?? 4) !== (this.sentColors?.[name] ?? 4)) {
        const ok = await this.lane.run('text-frame', () => this.bridge.textContainerUpgrade({ containerID: id, containerName: name,
          content: value, ...(textColor == null ? {} : { textColor }) }), { context: { container: name } });
        if (!ok) throw new Error(`Text update failed (${name}).`);
        this.sent[name] = value; (this.sentColors ||= {})[name] = textColor ?? 4;
      }
      if (reading && name === 'body') this.acceptReading(frame);
    }
    if (this.interrupted(frame)) return;
    this.failure = null; this.recoveryAttempts = 0;
    this.acceptedFrame = frame;
    if (this.diagnostics.enabled) this.diagnostics.display.accepted = true;
    this.acceptedAt = performance.now();
    this.onAccepted(frame);
    if (frame.layout?.format === 'pdf' && !frame.picker && !frame.positionPicker) {
      this.diagnostics.renderer = pdf ? 'pdf-image' : 'pdf-native';
      this.diagnostics.log('pdf-frame', { selection: frame.selection, renderer: this.diagnostics.renderer, y: frame.y,
        firstRow: frame.nativePdf?.start, endRow: frame.nativePdf?.end, padding: frame.nativePdf?.padding,
        position: Math.round(frame.y / (frame.layout.maxY || 1) * 1000) });
    }
    this.displayMode = frame.mode;
    this.lastAccepted = { renderer: pdf ? frame.wordFrame?.heading ? 'title-image' : 'pdf-image' : 'native-text', y: frame.y, title: titleText(frame.title), mode: frame.mode,
      screen: frame.positionPicker ? 'position' : frame.picker ? 'documents' : frame.message?.kind || 'reader', pickerIndex: frame.picker?.index ?? null,
      selectedPercent: frame.positionPicker?.percent ?? null, status: content.status,
      firstRow: window.start, endRow: window.end, positionKnown: true, speed: frame.speed,
      padding: frame.nativePdf?.padding,
      wordStart: frame.wordFrame?.start, wordEnd: frame.wordFrame?.end, wordsPerMinute: frame.wordRate,
      sectionTitle: !!frame.wordFrame?.heading, pauseAtTitles: frame.pauseAtTitles,
      at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start) };
  }
  acceptReading(frame) {
    const old = this.readingFrame;
    // Footer-only updates must not restart the visible line/group's clock.
    const changed = !old || old.layout !== frame.layout || old.y !== frame.y || old.mode !== frame.mode || old.playing !== frame.playing
      || old.speed !== frame.speed || old.wordRate !== frame.wordRate || old.nativePdf?.reveal !== frame.nativePdf?.reveal
      || old.wordFrame?.start !== frame.wordFrame?.start || old.wordFrame?.end !== frame.wordFrame?.end;
    this.readingFrame = frame;
    if (changed) { this.readingAcceptedAt = performance.now(); this.onReadingAccepted?.(frame); }
  }
}
