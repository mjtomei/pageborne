import { pdfTextRows } from './pdf-reflow.js';

const right = box => box.x + box.width;
const bottom = box => box.y + box.height;
const union = boxes => {
  const x = Math.min(...boxes.map(box => box.x)), y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y };
};
const quantile = (values, p) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];

// Restrict component work to a small crop or the outside margins. Do not build
// another full-page pixel/label array beside the OCR and PDF canvases.
function components(data, pageWidth, pageHeight, bounds) {
  const x0 = Math.max(0, Math.floor(bounds.x)), y0 = Math.max(0, Math.floor(bounds.y));
  const width = Math.max(0, Math.min(pageWidth, Math.ceil(right(bounds))) - x0);
  const height = Math.max(0, Math.min(pageHeight, Math.ceil(bottom(bounds))) - y0);
  const ink = new Uint8Array(width * height), stack = new Int32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = ((y0 + y) * pageWidth + x0 + x) * 4;
    ink[y * width + x] = Number(data[p + 3] > 20 && data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722 < 190);
  }
  const result = [];
  for (let at = 0; at < ink.length; at++) {
    if (!ink[at]) continue;
    let size = 1, count = 0, left = width, top = height, end = 0, low = 0; stack[0] = at; ink[at] = 0;
    while (size) {
      const p = stack[--size], x = p % width, y = Math.floor(p / width);
      count++; left = Math.min(left, x); top = Math.min(top, y); end = Math.max(end, x + 1); low = Math.max(low, y + 1);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
        const next = yy * width + xx;
        if (ink[next]) { ink[next] = 0; stack[size++] = next; }
      }
    }
    if (count >= 8) result.push({ x: x0 + left, y: y0 + top, width: end - left, height: low - top, count });
  }
  return result;
}

export function pdfScanMarks({ width, height, data, text }) {
  const rows = pdfTextRows(text).map(row => ({ ...union(row.items), text: row.text,
    confidence: row.items.reduce((sum, item) => sum + (item.confidence ?? 100), 0) / row.items.length }));
  const prose = rows.filter(row => row.confidence >= 70 && row.text.length >= 35 && row.width >= width * .35 && row.height >= 6 && row.height <= 45);
  if (prose.length < 6) return { text, annotations: [], masks: [] };
  const size = quantile(prose.map(row => row.height), .5);
  const body = { x: quantile(prose.map(row => row.x), .1), y: Math.min(...prose.map(row => row.y)),
    right: quantile(prose.map(right), .9), bottom: Math.max(...prose.map(bottom)) };
  const annotations = [];
  // Hanging indents, reference labels and speaker names can extend beyond
  // the main prose lane. Their recognized glyphs are not margin handwriting.
  const printedWords = text.flatMap(line => line.words?.length ? line.words : [line])
    .filter(word => word.confidence >= 80 && /\p{L}/u.test(word.text) && word.height >= size * .6);
  const printedComponent = box => printedWords.some(word => {
    const overlap = Math.max(0, Math.min(right(box), right(word)) - Math.max(box.x, word.x))
      * Math.max(0, Math.min(bottom(box), bottom(word)) - Math.max(box.y, word.y));
    return overlap >= box.width * box.height * .8;
  });
  // A note can start above the first reliable prose row (OCR may merge it
  // with that row). Extend vertically so its ascenders are not clipped.
  const top = Math.max(8, body.y - size * 2), end = Math.min(height - 8, body.bottom + size * 2);
  const lanes = [{ x: 20, y: top, width: body.x - size * .45 - 20, height: end - top },
    { x: body.right + size * .45, y: top, width: width - body.right - size * .45 - 20, height: end - top }];
  for (const lane of lanes.filter(lane => lane.width > 8 && lane.width < width * .3)) {
    // Keep thin/disconnected pencil strokes within a group; filtering each
    // glyph by width clipped the tops of handwritten letters and final C's.
    const pieces = components(data, width, height, lane).filter(box => box.count >= 8 && !printedComponent(box)
      && !((box.x < 20 || right(box) > width - 20) && box.height > lane.height * .4));
    const groups = [];
    for (const piece of pieces.sort((a, b) => a.y - b.y)) {
      const group = groups.find(group => piece.y <= bottom(group) + size * 1.6);
      if (group) Object.assign(group, union([group, piece]), { count: group.count + piece.count }); else groups.push({ ...piece });
    }
    for (const group of groups) if (group.count >= 45 && (group.width >= size || group.height >= size * 2)) {
      const x = Math.max(0, group.x - 5), y = Math.max(0, group.y - 5);
      annotations.push({ x, y, width: Math.min(width, right(group) + 5) - x, height: Math.min(height, bottom(group) + 5) - y,
        kind: 'figure', annotation: { kind: 'handwriting' }, lines: [], text: '' });
    }
  }
  const inside = (box, region) => box.x + box.width / 2 >= region.x && box.x + box.width / 2 < right(region)
    && box.y + box.height / 2 >= region.y && box.y + box.height / 2 < bottom(region);
  const clean = [];
  const printed = text.flatMap(line => line.words?.length ? line.words : [line])
    .filter(word => word.confidence >= 70 && /\p{L}{3}/u.test(word.text) && word.height >= size * .6);
  for (const line of text) {
    // A detached speck or horizontal pen stroke sometimes becomes a tiny
    // alphabetic word. Printed superscripts and note markers are protected;
    // only marks below a neighboring baseline can qualify.
    const tinyMark = word => word.confidence < 55 && /^[A-HJ-UW-Za-z]{1,2}$/.test(word.text)
      && !line.noteMarker && !word.references?.length && word.height < size * .45 && word.width < size
      && printed.some(row => word.y >= bottom(row) && word.y - bottom(row) < size * .65
        && word.x >= row.x && right(word) <= right(row) + size * 2);
    const words = line.words?.filter(word => !annotations.some(region => inside(word, region)) && !tinyMark(word));
    if (words && !words.length || !words && annotations.some(region => inside(line, region))) continue;
    if (!words && tinyMark(line)) continue;
    const current = words && words.length !== line.words.length ? { ...line, ...union(words), words, text: words.map(word => word.text).join(' '),
      confidence: words.reduce((sum, word) => sum + (word.confidence ?? 100), 0) / words.length } : line;
    // Underlines can be hallucinated as a low-confidence row such as “— eer 5
    // =”. Require a long thin stroke and a neighboring printed line before
    // removing that row; short real words and note references are preserved.
    const letters = (current.text.match(/\p{L}/gu) || []).length;
    const nearProse = rows.some(row => row !== current && row.confidence >= 65 && row.height >= size * .6
      && (row.text.match(/\p{L}/gu) || []).length >= 4 && Math.abs(bottom(row) - current.y) < size * 1.2
      && Math.min(right(row), right(current)) - Math.max(row.x, current.x) > current.width * .7);
    const stroke = current.confidence < 55 && (letters <= 4
      && (/(?:^|\s)[—–_=\-]+(?:\s|$)/u.test(current.text) || letters <= 1 && /[—–_=\-]+/u.test(current.text))
        || current.desktopUnmatched && current.confidence < 25 && letters <= 12)
      && !current.noteMarker && !current.words?.some(word => word.references?.length) && nearProse
      && components(data, width, height, current).some(box => box.width >= Math.max(20, size * .8, current.width * .7)
        // A wavy underline may touch a page number or descend several pixels;
        // its average ink thickness still distinguishes it from printed text.
        && box.height <= size && box.count / box.width <= size * .25);
    if (!stroke) clean.push(current);
  }
  return { text: clean, annotations, masks: annotations.map(({ x, y, width, height }) => ({ x, y, width, height })) };
}

// A separated footnote rule or the tail of an underline can share a crop
// with a binding shadow. Discard it only if every interior component is a
// thin horizontal stroke beside recognized text. Diagrams/letters survive.
export function pdfScanRuleFragment(block, { width, height, data, text }) {
  if (block.kind !== 'scan' || block.fullPage || block.text.trim() || block.lines.length) return false;
  const pieces = components(data, width, height, block).filter(box => box.x >= 20 && right(box) <= width - 20
    && !(box.width <= 5 && bottom(box) >= height - 2 && (box.x < 30 || right(box) > width - 30)));
  if (!pieces.length) return false;
  if (!pieces.some(box => box.width >= 40)) return false;
  return pieces.every(box => text.some(line => line.confidence >= 70 && line.text.length >= 20
    && line.height < 45
    && box.height <= line.height * .9 && box.count / box.width <= line.height * .22
    && Math.min(right(line), right(box)) - Math.max(line.x, box.x) >= box.width * .7
    && (Math.abs(box.y - bottom(line)) < line.height * 1.5 || Math.abs(bottom(box) - line.y) < line.height * 2)));
}

export function pdfUnderlineBlock(block, text) {
  if (block.kind !== 'scan' || block.lines.length || block.width < 40 || block.height > 12) return false;
  return text.some(line => line.confidence >= 70 && line.text.length >= 20 && block.height <= line.height * .45
    && Math.abs(block.y - bottom(line)) <= line.height * .65
    && Math.min(right(line), right(block)) - Math.max(line.x, block.x) >= block.width * .7);
}
