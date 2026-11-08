import { BODY_HEIGHT, rowAt } from './document.js';
import { LINE_HEIGHT } from './native-text.js';
import { SpeedReading, wordsPerMinute, wordsPerGroup, stepWordSpeed } from './speed-reading.js';

export function autoSpeed(value = 30) {
  const speed = Number(value);
  return Number.isFinite(speed) ? Math.max(6, Math.min(200, Math.round(speed))) : 30;
}

// The range uses logarithmic travel; saved preferences remain real lines/min.
const SPEED_LOG_RANGE = Math.log(200 / 6);
export function speedFromSlider(value) {
  const position = Number(value);
  return Number.isFinite(position) ? autoSpeed(6 * Math.exp(Math.max(0, Math.min(1000, position)) / 1000 * SPEED_LOG_RANGE)) : 30;
}
export function speedToSlider(value) { return Math.round(Math.log(autoSpeed(value) / 6) / SPEED_LOG_RANGE * 1000); }
export function stepAutoSpeed(value, steps) { return autoSpeed(autoSpeed(value) * 1.2 ** steps); }

export class Reader {
  constructor({ onChange = () => {} } = {}) {
    this.y = 0; this.positionY = 0; this.target = 0; this.maxY = 0; this.mode = 'page'; this.playing = false; this.speed = 30; this.elapsed = 0;
    this.onChange = onChange;
    this.speedReading = new SpeedReading();
    this.resetPageSession();
  }
  resetPageSession() { this.pagesRead = 0; this.pageReadWords = 0; this.pageReadSeconds = 0; this.pageDwellSeconds = 0; }
  pageWordsFrom(y) {
    const layout = this.pageLayout, entries = this.speedReading.entries;
    // Match the first visible row after an arbitrary position jump. A word
    // wrapped or split for display still contributes only its original weight.
    let start = y;
    if (layout?.format === 'pdf') {
      const run = layout.nativeRuns?.find(run => y >= run.start && y < run.end);
      start = run?.rows[Math.max(0, run.rows.findLastIndex(row => row.y <= y))]?.y ?? y;
    } else if (layout?.rows?.length) start = layout.rows[rowAt(layout, y)].y;
    let low = 0, high = entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (entries[mid].y < start - .5) low = mid + 1; else high = mid;
    }
    return this.pageRemainingWords?.[low] || 0;
  }
  get pageRemainingSeconds() {
    if (this.mode !== 'page' || this.pagesRead < 5 || !this.pageReadWords) return undefined;
    // Include the current pane's text, but no invented duration for figures.
    return this.pageWordsFrom(this.y) * this.pageReadSeconds / this.pageReadWords;
  }
  clamp(y) { return Math.min(this.maxY, Math.max(0, Number.isFinite(y) ? y : 0)); }
  setDocument(maxY, position = 0, pages = null, pagePosition = null, autoPosition = null, { preserveSession = false } = {}) {
    if (!preserveSession) this.resetPageSession();
    this.maxY = Math.max(0, maxY); this.playing = false; this.elapsed = 0;
    this.pages = pages;
    this.pagePosition = pagePosition;
    this.autoPosition = autoPosition;
    this.autoPosition?.reset?.();
    this.speedReading.load(null);
    this.pageLayout = null; this.pageRemainingWords = null;
    this.positionY = this.y = this.target = this.clamp(position); this.onChange();
  }
  setMode(mode) {
    if (!['page', 'auto', 'speed'].includes(mode)) return;
    if (mode !== this.mode) {
      this.pageDwellSeconds = 0;
      this.autoPosition?.reset?.();
      if (mode === 'speed') {
        this.positionY = this.speedReading.current?.y ?? this.positionY;
        this.y = this.positionY;
      }
      else this.y = this.clamp(this.positionY);
    }
    this.mode = mode; this.playing = false; this.elapsed = 0; this.target = this.y; this.onChange();
  }
  setSpeedDocument(layout, saved, preparedEntries) {
    const restored = this.speedReading.load(layout, this.positionY, saved, preparedEntries);
    this.pageLayout = layout;
    const entries = this.speedReading.entries;
    this.pageRemainingWords = new Float64Array(entries.length + 1);
    for (let i = entries.length - 1; i >= 0; i--) {
      // Manual pace counts actual words, without speed mode's title multiplier.
      this.pageRemainingWords[i] = this.pageRemainingWords[i + 1] + (entries[i].words || 0);
    }
    if (this.mode === 'speed') this.syncWords();
    // Full-page modes clamp the viewport near the end of a document. Keep
    // the exact source row/word even when it sits below that viewport's top.
    else if (restored && this.speedReading.current?.y > this.maxY) this.positionY = this.speedReading.current.y;
  }
  syncWords() {
    this.positionY = this.speedReading.current?.y ?? 0;
    this.y = this.target = this.mode === 'speed' ? this.positionY : this.clamp(this.positionY);
    this.elapsed = 0; this.onChange();
  }
  jump(position) {
    this.pageDwellSeconds = 0;
    this.playing = false; this.elapsed = 0;
    this.autoPosition?.reset?.();
    if (this.mode === 'speed') { this.speedReading.seekY(position); this.syncWords(); }
    else { this.positionY = this.y = this.target = this.clamp(position); this.speedReading.seekY(this.positionY); this.onChange(); }
  }
  seekWords(percent) { this.playing = false; this.speedReading.seek((this.speedReading.entries.length - 1) * percent / 100); this.syncWords(); }
  restoreWords(saved) {
    if (saved?.total === this.speedReading.entries.length && this.speedReading.entries[saved.index]?.text === saved.text) {
      this.speedReading.seek(saved.index); this.syncWords();
    }
  }
  pageStep(direction) {
    if (this.mode === 'speed') { this.playing = false; this.speedReading.step(direction); this.syncWords(); return; }
    const next = this.pagePosition ? this.pagePosition(this.y, direction)
      : direction > 0 ? this.pages?.find(y => y > this.y + .5) : this.pages?.findLast(y => y < this.y - .5);
    const position = this.clamp(next ?? this.y + direction * (BODY_HEIGHT - 29));
    if (this.mode === 'page' && position > this.y && this.pageDwellSeconds > 0) {
      const words = this.pageWordsFrom(this.y) - this.pageWordsFrom(position);
      // Image-only panes contribute neither time nor a warm-up sample. Count
      // text progress once even when successive panes have overlapping rows.
      if (words > 0) {
        this.pagesRead++; this.pageReadWords += words; this.pageReadSeconds += this.pageDwellSeconds;
      }
    }
    this.jump(position);
  }
  scroll(direction) {
    if (this.mode === 'speed') this.setWordSpeed(stepWordSpeed(this.speedReading.rate, -Math.sign(direction)));
    else if (this.mode === 'auto') this.setSpeed(stepAutoSpeed(this.speed, -Math.sign(direction)));
    else this.pageStep(direction);
  }
  setSpeed(value) { this.speed = autoSpeed(value); this.elapsed = 0; this.onChange(); }
  setWordSpeed(value) { this.speedReading.rate = wordsPerMinute(value); this.elapsed = 0; this.onChange(); }
  setWordGroup(value) { this.speedReading.count = wordsPerGroup(value); this.speedReading.limit = undefined; this.elapsed = 0; this.onChange(); }
  setPauseAtTitles(value) {
    this.pauseAtTitles = value === true;
    if (this.mode === 'speed' && this.speedReading.current?.heading && this.pauseAtTitles) this.playing = false;
    this.elapsed = 0; this.onChange();
  }
  get wordStop() { const group = this.speedReading.current; return !!(group?.image || group?.heading && this.pauseAtTitles); }
  get canAutoAdvance() { return this.autoPosition?.canAdvance?.(this.y) ?? this.y < this.maxY; }
  togglePlay() {
    if (this.mode === 'speed') {
      if (!this.speedReading.current) return;
      if (this.speedReading.finished) this.speedReading.seek(0);
      else if (this.wordStop) this.speedReading.step(1);
      this.playing = !this.playing && !this.wordStop && !this.speedReading.finished;
      this.syncWords(); return;
    }
    if (this.mode !== 'auto' || !this.canAutoAdvance) return;
    this.target = this.y; this.elapsed = 0; this.playing = !this.playing; this.onChange();
  }
  pause() { this.playing = false; this.elapsed = 0; this.target = this.y; this.onChange(); }
  tick(seconds, blocked = false, canAdvance = true) {
    if (blocked || !Number.isFinite(seconds)) return;
    // A manually read page stays visible even if the phone's timer is delayed.
    if (this.mode === 'page') { this.pageDwellSeconds += Math.max(0, seconds); return; }
    // Automatic modes must never catch up through several unread lines.
    if (!this.playing || seconds > 1.5) return;
    this.elapsed += Math.max(0, seconds);
    // Already-visible words keep their dwell while footer/storage work finishes.
    // Hold at the deadline until the display can take exactly one next group.
    if (!canAdvance) return;
    if (this.mode === 'speed') {
      const group = this.speedReading.current;
      if (!group || this.wordStop) { this.pause(); return; }
      if (this.elapsed >= group.words * (group.heading ? 120 : 60) / this.speedReading.rate) {
        if (!this.speedReading.step(1) || this.wordStop) this.playing = false;
        this.syncWords();
      }
      return;
    }
    if (this.elapsed >= 60 / this.speed) {
      this.elapsed = 0;
      this.positionY = this.y = this.target = this.clamp(this.autoPosition?.step ? this.autoPosition.step(this.y)
        : this.autoPosition ? this.autoPosition(this.y) : (Math.floor(this.y / LINE_HEIGHT) + 1) * LINE_HEIGHT);
      this.speedReading.seekY(this.positionY);
      if (!this.canAutoAdvance) this.playing = false;
      this.onChange();
    }
  }
}

// Backwards-compatible export; all input bindings live in controls.js.
export { actionForEvent } from './controls.js';

// Keep one frame in flight and at most one pending frame. Slow BLE must never
// build a backlog of obsolete positions. Each frame's text changes are sent serially.
export class LatestFrameQueue {
  constructor(send, onError = () => {}) { this.send = send; this.onError = onError; this.pending = null; this.running = false; this.stopped = false; }
  submit(frame) {
    if (this.stopped) return;
    this.pending = frame;
    if (!this.running) this.drain();
  }
  whenIdle() {
    if (!this.running) return Promise.resolve();
    return new Promise(resolve => (this.waiters ||= []).push(resolve));
  }
  async drain() {
    this.running = true;
    try {
      while (this.pending && !this.stopped) {
        const frame = this.pending; this.pending = null;
        try { await this.send(frame); }
        catch (error) { this.pending = null; this.stopped = true; this.onError(error); }
      }
    } finally {
      this.running = false;
      for (const resolve of this.waiters || []) resolve();
      this.waiters = [];
    }
  }
  stop() { this.stopped = true; this.pending = null; }
}
