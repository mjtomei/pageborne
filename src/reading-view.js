import { textWindow } from './native-text.js';
import { speedEntries } from './speed-reading.js';

const cache = new WeakMap();
export function glassesReadingUnits(frame, preparedEntries) {
  const { layout, y, mode, wordFrame, nativePdf } = frame || {};
  if (!layout || frame.message || frame.dialog || frame.picker || frame.positionPicker || frame.modePicker || frame.footnotes) return [];
  if (!cache.has(layout) || preparedEntries && cache.get(layout).entries !== preparedEntries) {
    const entries = preparedEntries || speedEntries(layout); let block = 0;
    if (layout.format === 'pdf') for (const e of entries) {
      while (block + 1 < layout.blocks.length && layout.blocks[block + 1].y <= e.y) block++;
      e.page = layout.blocks[block]?.page;
    }
    cache.set(layout, { entries });
  }
  const saved = cache.get(layout), { entries } = saved;
  const key = `${y}:${mode}:${wordFrame?.start}:${wordFrame?.end}:${nativePdf?.start}:${nativePdf?.end}`;
  if (saved.key === key) return saved.units;
  let startY, endY;
  if (mode !== 'speed') {
    if (layout.format === 'pdf') {
      if (!nativePdf) return [];
      const run = layout.nativeRuns?.find(r => y >= r.start && y < r.end);
      if (!run) return [];
      startY = run.rows[nativePdf.start]?.y;
      endY = run.rows[nativePdf.end]?.y ?? run.end;
    } else {
      const window = textWindow(layout, y);
      startY = layout.rows[window.start]?.y;
      endY = layout.rows[window.end]?.y ?? Infinity;
    }
  }
  const result = [];
  // Binary search the first visible source word, keeping very large books cheap.
  let low = 0, high = entries.length;
  if (mode !== 'speed') while (low < high) { const mid = (low + high) >>> 1; if (entries[mid].y < startY) low = mid + 1; else high = mid; }
  const start = mode === 'speed' ? wordFrame?.start ?? 0 : low;
  const end = mode === 'speed' ? wordFrame?.end ?? 0 : entries.length;
  for (let i = start; i < end; i++) {
    const e = entries[i]; if (mode !== 'speed' && e.y >= endY) break;
    if (!e.words || e.image) continue;
    const page = e.page;
    result.push({ key: e.key || String(i), words: e.words, text: e.text, ...(page ? { page } : {}) });
  }
  saved.key = key; saved.units = result; return result;
}
