import { getTextWidth } from '@evenrealities/pretext';
import { BODY_HEIGHT, WIDTH, MARGIN } from './document.js';
import { measureNativeText, byteLength, TEXT_BYTES, VISIBLE_LINES } from './native-text.js';
import { pdfBodySize, pdfSectionTitle } from './pdf-annotations.js';
import { pdfTextRows } from './pdf-reflow.js';

const clamp = (value, min, max, fallback) => Number.isFinite(Number(value)) && value != null
  ? Math.max(min, Math.min(max, Math.round(Number(value)))) : fallback;
export const MIN_WORD_RATE = 60, MAX_WORD_RATE = 6000;
export const wordsPerMinute = value => clamp(value, MIN_WORD_RATE, MAX_WORD_RATE, 250);
export const wordsPerGroup = value => clamp(value, 1, 10, 3);
export const wordSpeedFromSlider = value => wordsPerMinute(MIN_WORD_RATE * (MAX_WORD_RATE / MIN_WORD_RATE) ** (Math.max(0, Math.min(1000, Number(value) || 0)) / 1000));
export const wordSpeedToSlider = value => Math.round(Math.log(wordsPerMinute(value) / MIN_WORD_RATE) / Math.log(MAX_WORD_RATE / MIN_WORD_RATE) * 1000);
export const stepWordSpeed = (value, steps) => wordsPerMinute(wordsPerMinute(value) * 1.2 ** steps);
const width = WIDTH - 2 * MARGIN - 8;
const trailingPunctuation = /^[.,!?;:…。、，！？：；．｡､\p{Pe}\p{Pf}"']+$/u;
const leadingPunctuation = /^[\p{Ps}\p{Pi}¿¡"']+$/u;
const punctuation = /^[.,!?;:…。、，！？：；．｡､\p{Ps}\p{Pi}\p{Pe}\p{Pf}¿¡"']+$/u;

function attachPunctuation(entries) {
  const quotes = new Set();
  const roles = entries.map(entry => {
    if (!entry.text || entry.heading) { quotes.clear(); return null; }
    const text = entry.text;
    let role = null;
    if (punctuation.test(text)) {
      if (entry.wordContinuation) role = 'close';
      else if (/^["']+$/.test(text)) {
        role = quotes.has(text[0]) ? 'close' : 'open';
      } else role = leadingPunctuation.test(text.replace(/["']/g, '')[0]) ? 'open' : 'close';
    }
    // Include quotes attached to lexical tokens when resolving a later bare
    // straight quote. Apostrophes inside words are not quotation boundaries.
    const chars = Array.from(text);
    chars.forEach((char, j) => {
      if (!/["']/.test(char) || /[\p{L}\p{N}]/u.test(chars[j - 1] || '') && /[\p{L}\p{N}]/u.test(chars[j + 1] || '')) return;
      if (role === 'close' || !role && quotes.has(char)) quotes.delete(char);
      else quotes.add(char);
    });
    return role;
  });
  const joins = new Set();
  for (let start = 0; start < entries.length;) {
    if (!roles[start]) { start++; continue; }
    let end = start + 1;
    while (end < entries.length && roles[end]) end++;
    const before = entries[start - 1], after = entries[end];
    const hasBefore = !!before?.text && !before.heading, hasAfter = !!after?.text && !after.heading;
    // Closing marks belong to the preceding word; an opening mark and the
    // rest of its punctuation cluster travel with the following word. At a
    // heading/figure boundary, use whichever lexical neighbour exists.
    let split = end;
    if (hasAfter) {
      split = start;
      if (hasBefore) while (split < end && roles[split] !== 'open') split++;
    }
    if (hasBefore) for (let i = start; i < split; i++) joins.add(i);
    if (hasAfter && split < end) for (let i = split + 1; i <= end; i++) joins.add(i);
    start = end;
  }
  let joined = '';
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i], previous = entries[i - 1];
    // Keep original entries/keys for saved positions. Only presentation and
    // word timing change when extraction leaves a space before punctuation.
    if (joins.has(i) && measureNativeText(joined + entry.text) <= width * 2) {
      entry.joinPrevious = true;
      if (entry.punctuationToken) entry.words = 0;
      if (previous.punctuationToken) previous.words = 0;
      joined += entry.text;
    } else joined = entry.text || '';
  }
  for (const entry of entries) { delete entry.punctuationToken; delete entry.wordContinuation; }
  return entries;
}

function wordLines(text) {
  const lines = titleLines(text, measureNativeText, width);
  // A suffix that tips a long word over the width must share its final line
  // with letters, rather than leaving a period or closing quote on its own.
  if (lines.length > 1 && trailingPunctuation.test(lines.at(-1))) {
    const previous = Array.from(lines.at(-2));
    while (previous.length > 1 && trailingPunctuation.test(lines.at(-1))) {
      const char = previous.pop();
      if (measureNativeText(char + lines.at(-1)) > width) { previous.push(char); break; }
      lines[lines.length - 1] = char + lines.at(-1);
    }
    lines[lines.length - 2] = previous.join('');
  }
  return lines;
}

// Tokenize source text, not screen lines: a word wrapped across two rows must
// remain one word. Oversized tokens are split without discarding characters.
function addWords(entries, text, rows, baseY = 0, heading = false) {
  const start = entries.length;
  let rowIndex = 0;
  for (const match of text.matchAll(/\S+/gu)) {
    while (rowIndex + 1 < rows.length && rows[rowIndex + 1].offset <= match.index) rowIndex++;
    const parts = []; let part = '';
    for (const char of match[0]) {
      if (part && measureNativeText(part + char) > width) { parts.push(part); part = ''; }
      part += char;
    }
    if (part) parts.push(part);
    for (const [partIndex, text] of parts.entries()) entries.push({ text, y: baseY + (rows[rowIndex]?.y || 0), words: 1 / parts.length,
      punctuationToken: punctuation.test(match[0]), wordContinuation: partIndex > 0 });
  }
  if (heading && entries.length > start) {
    const lines = titleLines(text, measureNativeText, width);
    const content = lines.length <= VISIBLE_LINES ? centeredWords(lines) : null;
    const title = { heading: true, start, end: entries.length, y: entries[start].y,
      words: text.match(/\S+/gu).length, text: text.trim(),
      content: content && byteLength(content) <= TEXT_BYTES ? content : null };
    // Keep word indexes stable for existing positions/bookmarks. Each word in
    // a heading points at the same atomic frame, including legacy mid-title saves.
    for (let i = start; i < entries.length; i++) entries[i].heading = title;
  }
}

export function titleLines(text, measure, available) {
  const lines = []; let line = '';
  for (const word of text.match(/\S+/gu) || []) {
    if (line && measure(`${line} ${word}`) <= available) { line += ` ${word}`; continue; }
    if (line) { lines.push(line); line = ''; }
    for (const char of word) {
      if (line && measure(line + char) > available) { lines.push(line); line = ''; }
      line += char;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function isPdfTitle(block, bodySize) {
  if (!block.lines?.length || block.annotation || block.annotationLabel || block.kind !== 'text' || !block.reflow) return false;
  if (pdfSectionTitle(block, bodySize)) return true;
  // Also recognize short, enlarged headings such as an unnumbered Introduction.
  // Do not guess from capitalized prose, caption labels, or figure text.
  const rows = pdfTextRows(block.lines); const text = rows.map(row => row.text).join(' ').trim();
  return bodySize > 0 && rows.length <= 3 && text.length <= 200 && /\p{L}/u.test(text)
    && !/[.!?=∑∫]$/.test(text) && block.lines.filter(line => line.text.trim().length > 1)
      .every(line => line.height >= bodySize * 1.2);
}

export function speedEntries(layout) {
  const entries = [];
  if (!layout) return entries;
  if (layout.format !== 'pdf') {
    const rows = new Map();
    for (const row of layout.rows) { if (!rows.has(row.block)) rows.set(row.block, []); rows.get(row.block).push(row); }
    for (const block of layout.blocks) addWords(entries, block.text, rows.get(block.index) || [], 0, block.kind === 'heading');
  } else {
    const bodySize = pdfBodySize([{ blocks: layout.blocks.filter(block => block.lines) }]);
    for (const block of layout.blocks) {
      const start = entries.length;
      const source = `${block.page}:${block.x}:${block.sourceY}:${block.width}:${block.height}:${block.annotationLabel || ''}`;
      if (!block.reflow) {
        // Prepared images fit one manual screen; images are never timed or skipped.
        for (let y = block.y; y < block.y + block.drawHeight; y += BODY_HEIGHT) entries.push({ image: true, y, endAt: block.y + block.drawHeight, page: block.page,
          key: `${source}:image:${y - block.y}` });
        continue;
      }
      let text = ''; const rows = []; let previous;
      for (const row of block.reflow.rows) {
        if (text && (!previous || row.label || previous.label || row.start !== previous.end)) text += ' ';
        rows.push({ offset: text.length, y: row.y }); text += row.text; previous = row;
      }
      addWords(entries, text, rows, block.y, isPdfTitle(block, bodySize));
      for (let i = start; i < entries.length; i++) entries[i].key = `${source}:word:${i - start}`;
    }
  }
  return attachPunctuation(entries);
}

export function centeredWords(lines) {
  const top = Math.floor((VISIBLE_LINES - lines.length) / 2);
  // Firmware exposes text containers without text alignment. Fixed geometry
  // and measured spaces keep these updates in native text mode (no image tiles).
  return '\n'.repeat(top) + lines.map(line => ' '.repeat(Math.max(0,
    Math.floor((WIDTH - 2 * MARGIN - getTextWidth(line)) / (2 * getTextWidth(' '))))) + line).join('\n');
}

export class SpeedReading {
  constructor() { this.entries = []; this.cursor = 0; this.count = 3; this.rate = 250; this.finished = false; }
  load(layout, y = 0, saved, preparedEntries) {
    this.entries = preparedEntries || speedEntries(layout);
    // Count each original word once (even when split for display), with twice
    // the dwell for headings. Images/manual waits have no predictable duration.
    this.remainingWeights = new Float64Array(this.entries.length + 1);
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      this.remainingWeights[i] = this.remainingWeights[i + 1] + (entry.words || 0) * (entry.heading ? 2 : 1);
    }
    this.seekY(y);
    const sourceIndex = saved?.key ? this.entries.findIndex(entry => entry.key === saved.key && entry.text === saved.text) : -1;
    if (sourceIndex >= 0) { this.seek(sourceIndex); return true; }
    else if (saved?.total === this.entries.length && this.entries[saved.index]
      && this.entries[saved.index].text === saved.text) { this.seek(saved.index); return true; }
    return false;
  }
  get current() { return this.groupAt(this.cursor, this.limit); }
  groupAt(start, limit = this.entries.length) {
    while (start > 0 && this.entries[start]?.joinPrevious) start--;
    const first = this.entries[start];
    if (!first) return null;
    if (first.image) return { ...first, start, end: start + 1, words: 0 };
    if (first.heading) return first.heading;
    const lines = []; let line = ''; let end = start; let words = 0;
    while (end < Math.min(limit, this.entries.length)) {
      const next = this.entries[end];
      if (next.image || next.heading) break;
      let text = next.text, weight = next.words, nextEnd = end + 1;
      while (nextEnd < this.entries.length && this.entries[nextEnd].joinPrevious) {
        text += this.entries[nextEnd].text; weight += this.entries[nextEnd].words; nextEnd++;
      }
      if (words + weight > this.count + .0001) break;
      const candidate = line ? `${line} ${text}` : text;
      const addition = measureNativeText(candidate) <= width ? [candidate] : [...(line ? [line] : []), ...wordLines(text)];
      if (lines.length + addition.length > 3 || byteLength(centeredWords([...lines, ...addition])) > TEXT_BYTES) break;
      line = addition.pop(); lines.push(...addition); words += weight; end = nextEnd;
    }
    if (line) lines.push(line);
    return { start, end, y: first.y, words, content: centeredWords(lines), text: lines.join(' ') };
  }
  get percent() { return this.finished ? 100 : this.entries.length > 1 ? this.cursor / (this.entries.length - 1) * 100 : 0; }
  get remainingSeconds() { return this.finished ? 0 : (this.remainingWeights?.[this.cursor] || 0) * 60 / this.rate; }
  get saved() { return { index: this.cursor, text: this.entries[this.cursor]?.text, total: this.entries.length, key: this.entries[this.cursor]?.key }; }
  seek(index) {
    this.cursor = Math.max(0, Math.min(this.entries.length - 1, Math.round(index) || 0));
    while (this.cursor > 0 && this.entries[this.cursor]?.joinPrevious) this.cursor--;
    this.cursor = this.entries[this.cursor]?.heading?.start ?? this.cursor;
    this.finished = false; this.limit = undefined;
  }
  seekY(y) {
    let low = 0; let high = this.entries.length - 1;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.entries[mid].y <= y) low = mid; else high = mid - 1; }
    // Several words share a source row. A line jump starts at its first word.
    while (low > 0 && this.entries[low - 1].y === this.entries[low]?.y) low--;
    this.seek(low);
  }
  step(direction) {
    if (direction > 0) {
      const end = this.current?.end ?? 0;
      if (end >= this.entries.length) { this.finished = true; return false; }
      this.seek(end);
    } else {
      const end = this.cursor; let index = Math.max(0, end - 1);
      while (index > 0 && !this.entries[index].image && !this.entries[index - 1].image
        && !this.entries[index].heading && !this.entries[index - 1].heading
        && this.groupAt(index - 1, end).end === end) index--;
      this.seek(index);
      if (end > index) this.limit = end;
    }
    return true;
  }
}
