import { pdfTextRows, reflowPdfBlock } from './pdf-reflow.js';
import { measureNativeText } from './native-text.js';

// These are semantic math glyphs, including the supplementary-plane italic
// alphabet missing from the glasses font. Keep their source typography rather
// than transliterating away distinctions, subscripts or superscripts.
export const hasPdfInlineMath = text => /[\u{1d400}-\u{1d7ff}\u2102\u210d\u2113\u2115\u2119-\u211d\u2124\u2200-\u22ff\u27c0-\u27ef\u2980-\u2aff]/u.test(text || '');

export function preservePdfInlineMath(block) {
  if (!block.reflow || block.contents || block.annotationLabel || !hasPdfInlineMath(block.reflow.text)) return [block];
  const rows = [];
  for (const row of pdfTextRows(block.lines)) {
    const top = Math.min(...row.items.map(item => item.y));
    const bottom = Math.max(...row.items.map(item => item.y + item.height));
    const previous = rows.at(-1);
    // A superscript/subscript can have a separate baseline. It must stay with
    // the adjoining formula, not become a tiny standalone image or prose row.
    if (previous && top < previous.bottom && (previous.math || hasPdfInlineMath(row.text))) {
      previous.items.push(...row.items); previous.bottom = Math.max(previous.bottom, bottom);
      previous.math ||= hasPdfInlineMath(row.text);
    } else rows.push({ top, bottom, items: [...row.items], math: hasPdfInlineMath(row.text) });
  }
  const groups = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (!row.math && last && !last.math) { last.items.push(...row.items); last.bottom = row.bottom; }
    else groups.push({ ...row, items: [...row.items] });
  }
  return groups.map((group, index) => {
    const lines = group.items;
    const x = Math.min(block.x, ...lines.map(item => item.x - 2));
    const right = Math.max(block.x + block.width, ...lines.map(item => item.x + item.width + 2));
    const y = Math.max(0, Math.min(block.y, group.top - 2));
    // Only the first/last group owns the paragraph's outer padding. Formula
    // bounds may extend past the old pixel crop (notably low subscripts).
    const top = index === 0 ? y : Math.max(0, group.top - 2, (groups[index - 1].bottom + group.top) / 2);
    const bottom = index === groups.length - 1 ? Math.max(block.y + block.height, group.bottom + 2)
      : Math.min(group.bottom + 2, (group.bottom + groups[index + 1].top) / 2);
    const piece = { ...block, x, y: top, width: right - x, height: bottom - top, lines,
      text: pdfTextRows(lines).map(row => row.text).join(' '), reflow: null };
    if (group.math) piece.inlineMath = true;
    else {
      const fontSize = block.reflow.fontSize;
      piece.reflow = reflowPdfBlock(piece, { fontSize,
        measure: text => Math.max(measureNativeText(text) * 552 / 544, [...text].length * fontSize * .52),
        allowSparseUncertainty: true });
      if (piece.reflow) piece.reflow.nativeWrap = block.reflow.nativeWrap;
    }
    return piece;
  });
}
