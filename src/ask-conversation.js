import { getTextWidth } from '@evenrealities/pretext';
import { nativeLayout, LINE_HEIGHT, VISIBLE_LINES, byteLength, TEXT_BYTES, measureNativeText } from './native-text.js';
import { parseDocument, rowAt, WIDTH, MARGIN } from './document.js';
import { chatMessages } from './ask-activity.js';
import { readingWords, readingUnitKey } from './reading-activity.js';

const RIGHT_EDGE = WIDTH - 2 * MARGIN - 8;
export const MESSAGE_WIDTH = RIGHT_EDGE - 64;
const alignQuestion = text => text.trim() ? ' '.repeat(Math.max(0,
  Math.floor((RIGHT_EDGE - getTextWidth(text)) / getTextWidth(' ')))) + text : '';

function activityRows(text, lines = 1) {
  const line = text.replace(/\s+/g, ' ').trim();
  // Tool summaries are literal text. Parsing shell syntax as Markdown can
  // strip filenames, angle brackets or underscores from a command.
  const rows = nativeLayout({ blocks: [{ index: 0, text: line, kind: 'activity', sourceLine: 1 }] }, 0, { width: MESSAGE_WIDTH }).rows;
  if (rows.length <= lines) return rows;
  const kept = rows.slice(0, lines), last = kept.at(-1);
  const chars = Array.from(line.slice(last.offset).replace(/(?:…|\.{3})$/, ''));
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureNativeText(chars.slice(0, mid).join('') + '…') <= MESSAGE_WIDTH) low = mid;
    else high = mid - 1;
  }
  last.text = chars.slice(0, low).join('').trimEnd() + '…';
  return kept;
}

// Display history is independent of the shorter context sent to providers.
// Measured spaces use the same native-text alignment as speed reading: the
// firmware has no text-align property, and this does not require image tiles.
export class AskConversation {
  constructor() { this.messages = []; this.cache = new Map(); this.layout = null; this.lines = VISIBLE_LINES; this.following = true; }
  update(turns, y, focus, lines = this.lines) {
    const anchor = this.anchor(y);
    const messages = [];
    for (const turn of turns) for (const entry of chatMessages(turn)) {
      const { role, text } = entry;
      if (!text) continue;
      const key = `${turn.id}:${entry.key}`;
      const previous = this.cache.get(key);
      const message = previous?.text === text && previous.lines === entry.lines ? previous : {
        key, role, text, lines: entry.lines, rows: (role === 'activity' ? activityRows(text, entry.lines) : nativeLayout(parseDocument(text), 0, { width: MESSAGE_WIDTH }).rows)
          .map(row => ({ ...row, text: role === 'user' ? alignQuestion(row.text) : row.text })),
      };
      if (message !== previous) {
        // Whitespace-independent offsets survive line wrapping and a partial
        // last line growing during streaming. These are display offsets, not
        // offsets into the Markdown sent to the provider.
        let plain = '';
        for (const row of message.rows) {
          row.readStart = plain.length; plain += row.text.replace(/\s/g, ''); row.readEnd = plain.length;
          let offset = row.readStart;
          row.readingUnits = role === 'activity' ? [] : [...row.text.matchAll(/\S+/g)].flatMap(match => {
            const start = offset; offset += match[0].length;
            return readingWords(match[0]) ? [{ key: readingUnitKey(key, start, match[0]), words: 1, text: match[0] }] : [];
          });
        }
        message.plain = plain; message.turnId = turn.id;
        if (role === 'assistant' && previous && Number.isFinite(turn.readThrough)) {
          let same = 0; while (same < previous.plain.length && same < plain.length && previous.plain[same] === plain[same]) same++;
          turn.readThrough = Math.min(turn.readThrough, same);
        }
      }
      messages.push(message);
    }
    // Follow the submitted question only until its reply arrives. A short
    // reply can retain earlier messages above it, but streaming must never
    // move past the beginning of that reply. Explicit navigation wins.
    // History backfill and delayed earlier answers are new to the cache too.
    // Only the newest turn's reply can stop following the submitted question.
    const reply = !focus && this.following && messages.findLast(message => message.role === 'assistant'
      && message.turnId === turns.at(-1)?.id && !this.cache.has(message.key));
    if (focus || this.following) this.replyStart = null;
    if (reply) { this.replyStart = reply.key; this.following = false; }
    if (messages.length !== this.messages.length || messages.some((m, i) => m !== this.messages[i])) {
      this.messages = messages; this.cache = new Map(messages.map(m => [m.key, m]));
      const rows = [];
      for (const message of messages) {
        message.start = rows.length;
        for (const row of message.rows) rows.push({ ...row, y: rows.length * LINE_HEIGHT, message: message.key });
      }
      this.layout = rows.length ? { rows, size: 22, pageOverlap: 0, height: rows.length * LINE_HEIGHT, maxY: 0 } : null;
    }
    if (focus === 'latest') this.following = true;
    const unread = focus === 'unread' ? this.firstUnread(turns) : null;
    const target = focus && this.cache.get(focus);
    if (target || unread !== null) this.following = false;
    let position = unread !== null ? unread : target ? target.start * LINE_HEIGHT : this.restore(anchor, y);
    this.lines = Math.max(1, Math.min(VISIBLE_LINES, lines));
    // A conversation that fits on one screen can keep its question visible.
    if (unread !== null && this.pageBoundary(0, 1) >= this.layout.rows.length) position = 0;
    return this.resize(position, lines, focus === 'latest' || !!target || unread !== null);
  }
  firstUnread(turns) {
    const through = new Map(turns.map(turn => [turn.id, turn.unreadDismissed ? Infinity : turn.readThrough ?? Infinity]));
    for (const message of this.messages) {
      if (message.role !== 'assistant') continue;
      const row = message.rows.findIndex(row => row.readEnd > through.get(message.turnId));
      if (row >= 0) return (message.start + row) * LINE_HEIGHT;
    }
    return null;
  }
  markRead(turns, receipts = []) {
    let changed = false;
    for (const receipt of receipts) {
      const turn = turns.find(turn => turn.id === receipt.id);
      const message = this.cache.get(`${receipt.id}:assistant`);
      // Only advance a contiguous read prefix. A skipped frame or a jump to
      // the tail must not mark intervening unseen screens as read.
      if (!turn || !Number.isFinite(turn.readThrough) || receipt.start > turn.readThrough || receipt.end <= turn.readThrough
        || !message?.plain.startsWith(receipt.prefix)) continue;
      turn.readThrough = receipt.end; changed = true;
    }
    return changed;
  }
  resize(y, lines, resetPages = false) {
    this.lines = Math.max(1, Math.min(VISIBLE_LINES, lines));
    const reply = this.replyStart && this.cache.get(this.replyStart);
    if (reply) {
      const start = Math.min(reply.start, this.pageBoundary(this.layout.rows.length, -1));
      y = start * LINE_HEIGHT;
      // Once the reply fills the screen, retain its ordinary message anchor.
      if (start === reply.start) this.replyStart = null;
    }
    if (this.layout && (resetPages || this.pageLayout !== this.layout || this.pageLines !== this.lines)) {
      // Keep a scrolled-back or unread row at the top when streaming, retained
      // history or the recording overlay changes the layout.
      this.paginate(this.following ? this.pageBoundary(this.layout.rows.length, -1) : rowAt(this.layout, y));
    }
    return { layout: this.layout, y: this.following ? this.layout?.maxY || 0 : Math.min(y, this.layout?.maxY || 0) };
  }
  pageBoundary(start, direction) {
    let end = start, bytes = this.lines - 1, count = 0;
    // Reserve newlines, including bottom padding, and include question-alignment
    // spaces. Backward pages must satisfy their own byte budget too.
    while (count < this.lines && (direction > 0 ? end < this.layout.rows.length : end > 0)) {
      const cost = byteLength(this.layout.rows[direction > 0 ? end : end - 1].text);
      if (bytes + cost > TEXT_BYTES) break;
      bytes += cost; count++; end += direction;
    }
    return direction > 0 ? Math.max(start + 1, end) : Math.max(0, Math.min(start - 1, end));
  }
  paginate(anchor) {
    // Partition around the current top row, so both forward and backward turns
    // are contiguous even when first-unread starts in the middle of a page.
    const before = []; let row = anchor;
    while (row > 0) { row = this.pageBoundary(row, -1); before.push(row); }
    this.pageStarts = [...before.reverse(), anchor]; row = anchor;
    while ((row = this.pageBoundary(row, 1)) < this.layout.rows.length) this.pageStarts.push(row);
    this.layout.maxY = this.pageStarts.at(-1) * LINE_HEIGHT;
    this.pageLayout = this.layout; this.pageLines = this.lines;
  }
  window(y) {
    if (!this.layout) return { content: ' ', nextY: 0, previousY: 0 };
    const start = rowAt(this.layout, y);
    // A restored message anchor need not be a boundary in a newly opened view.
    if (!this.pageStarts.includes(start)) this.paginate(start);
    const page = this.pageStarts.indexOf(start), end = this.pageStarts[page + 1] ?? this.layout.rows.length;
    const lines = this.layout.rows.slice(start, end).map(row => row.text);
    const padding = this.following || y >= this.layout.maxY ? this.lines - lines.length : 0;
    const seen = new Map();
    for (const row of this.layout.rows.slice(start, end)) {
      const message = this.cache.get(row.message); if (message.role !== 'assistant') continue;
      const receipt = seen.get(message.turnId) || { id: message.turnId, start: row.readStart };
      receipt.end = row.readEnd; receipt.prefix = message.plain.slice(0, row.readEnd); seen.set(message.turnId, receipt);
    }
    return { start, end, content: '\n'.repeat(padding) + lines.join('\n') || ' ',
      readReceipts: [...seen.values()],
      readingUnits: this.layout.rows.slice(start, end).flatMap(row => row.readingUnits),
      page: page + 1, pages: this.pageStarts.length,
      alignments: [...Array(padding).fill(null), ...this.layout.rows.slice(start, end).map(row => this.cache.get(row.message).role)],
      nextY: (this.pageStarts[page + 1] ?? start) * LINE_HEIGHT,
      previousY: (this.pageStarts[page - 1] ?? start) * LINE_HEIGHT };
  }
  move(y, direction) {
    this.replyStart = null;
    const frame = this.window(y), next = direction > 0 ? frame.nextY : frame.previousY;
    this.following = next >= (this.layout?.maxY || 0);
    return next;
  }
  anchor(y) {
    if (!this.layout) return null;
    const row = rowAt(this.layout, y), key = this.layout.rows[row].message;
    return { key, row: row - this.cache.get(key).start };
  }
  restore(anchor, fallback = 0) {
    const message = anchor && this.cache.get(anchor.key);
    const y = message ? (message.start + Math.min(Math.max(0, anchor.row), message.rows.length - 1)) * LINE_HEIGHT : fallback;
    return Math.max(0, Math.min(y, ((this.layout?.rows.length || 1) - 1) * LINE_HEIGHT));
  }
}
