import { pdfTextRows } from './pdf-reflow.js';

// A contents page has a single aligned reference column, not a data table.
// Decide before column segmentation, which would otherwise detach the folios.
export function pdfContentsEntries(text, width) {
  const candidates = pdfTextRows(text.flatMap(line => line.words?.length ? line.words : [line])).flatMap(row => {
    const match = row.text.match(/\s(\d{1,4}|[ivxlcdm]{1,8})\s*$/i);
    if (!match) return [];
    const last = row.items.at(-1);
    if (last.x + last.width < width * .65) return [];
    const title = row.text.slice(0, match.index).replace(/(?:[.:·…_\-]\s*){3,}$/, '').trim();
    const leader = /(?:[.:·…_]\s*){3,}/.test(row.text);
    if (!leader && !row.gaps.some(gap => gap > last.height * 4)) return [];
    if ((title.match(/[A-Za-z]/g) || []).length < 3 || /[=∑∫]/.test(title)) return [];
    // Numerical data in several cells is a table even if its last cell is an integer.
    if ((title.replace(/^(?:[A-ZIVX]+\.?|\d+(?:\.\d+)*\.?)\s+/, '').match(/\b\d+(?:\.\d+)?\b/g) || []).length > 1) return [];
    return [{ ...row, title, reference: match[1], right: last.x + last.width, leader }];
  });
  const aligned = candidates.filter(row => candidates.filter(other => Math.abs(other.right - row.right) < width * .035).length >= 4);
  if (aligned.length < 4 || !aligned.some(row => row.leader)
    && !text.some(box => /\bcontents\b/i.test(box.text))) return [];
  return aligned;
}

export function markPdfContents(blocks, entries) {
  if (!entries.length) return blocks;
  return blocks.map(block => {
    const rows = pdfTextRows(block.lines);
    const matching = rows.map(row => entries.find(entry => Math.abs(entry.y - row.y) < 3));
    return rows.length && matching.every(Boolean) && block.kind !== 'figure'
      ? { ...block, contents: matching.map(entry => ({ y: entry.y, text: `${entry.title} — page ${entry.reference}` })) } : block;
  });
}
