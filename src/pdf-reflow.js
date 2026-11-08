// Reflow prose only. Diagrams, tables and displayed mathematics retain their
// original pixels; PDF/OCR coordinates stay attached for search and bookmarks.
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 12;

export function pdfTextRows(lines) {
  const rows = []; const height = median(lines.map(t => t.height));
  for (const item of [...lines].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.findLast(r => Math.abs(r.y - item.y) < height * .55
      // Embedded OCR often shifts italic words downward. Join complementary
      // word boxes on that line, but never overlap the words of another line.
      || Math.abs(r.y - item.y) < height * .85 && r.items.every(other =>
        Math.min(other.x + other.width, item.x + item.width) - Math.max(other.x, item.x) < Math.min(other.width, item.width) * .15));
    if (row) row.items.push(item);
    else rows.push({ y: item.y, items: [item] });
  }
  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
    row.text = ''; row.gaps = []; row.parts = [];
    for (const [i, item] of row.items.entries()) {
      const last = row.items[i - 1]; const gap = last ? item.x - last.x - last.width : 0;
      if (last) row.gaps.push(gap);
      if (last && gap > height * .12 && !/\s$/.test(row.text) && !/^\s/.test(item.text)) row.text += ' ';
      const start = row.text.length; row.text += item.text;
      row.parts.push({ item, start, end: row.text.length });
    }
  }
  return rows;
}

// Unlike a page-wide baseline, a text run stops at a column gutter. Use these
// runs when testing prose/caption barriers before the columns are partitioned.
export function pdfTextRuns(lines) {
  return pdfTextRows(lines).flatMap(row => {
    const runs=[]; let items=[];
    for (const item of row.items) {
      const previous=items.at(-1);
      if (previous && item.x-previous.x-previous.width > Math.max(item.height,previous.height)*.9) {
        runs.push(items); items=[];
      }
      items.push(item);
    }
    if (items.length) runs.push(items);
    return runs.map(items => {
      const x=items[0].x,y=Math.min(...items.map(t=>t.y));
      return { x,y,width:Math.max(...items.map(t=>t.x+t.width))-x,height:Math.max(...items.map(t=>t.y+t.height))-y,
        text:pdfTextRows(items).map(r=>r.text).join(' '),items };
    });
  });
}

// Approximate transcript boxes can cut through a printed ascender/descender. Reunite
// a shallow, unrecognized strip only when its ink actually connects across
// the cut to a text block. Isolated symbols, rules and figures stay intact.
export function joinPdfTextFragments(blocks, pixels, pageWidth) {
  if (!pixels) return blocks;
  const joined = [];
  const ink = (x, y) => {
    const at = (y * pageWidth + x) * 4;
    return x >= 0 && x < pageWidth && at >= 0 && at + 3 < pixels.length && pixels[at + 3] > 20
      && pixels[at] * .2126 + pixels[at + 1] * .7152 + pixels[at + 2] * .0722 < 190;
  };
  for (const block of blocks) {
    const previous = joined.at(-1);
    const size = median(previous?.lines?.map(line => line.height) || []);
    const cut = Math.floor(block.y);
    const connects = previous?.kind === 'text' && block.kind === 'scan' && !block.lines.length
      && block.height <= size * .65 && Math.abs(previous.y + previous.height - cut) <= 1
      && block.x >= previous.x && block.x + block.width <= previous.x + previous.width
      && Array.from({ length: Math.ceil(block.width) }, (_, i) => Math.floor(block.x) + i)
        .some(x => ink(x, cut) && [x - 1, x, x + 1].some(xx => ink(xx, cut - 1)));
    const headCut = Math.floor(block.y);
    const head = previous?.kind === 'scan' && !previous.lines.length && block.kind === 'text'
      && previous.height <= median(block.lines.map(line => line.height)) * .65
      && Math.abs(previous.y + previous.height - headCut) <= 1
      && previous.x >= block.x && previous.x + previous.width <= block.x + block.width
      && Array.from({ length: Math.ceil(previous.width) }, (_, i) => Math.floor(previous.x) + i)
        .some(x => ink(x, headCut) && [x - 1, x, x + 1].some(xx => ink(xx, headCut - 1)));
    if (connects) previous.height = block.y + block.height - previous.y;
    else if (head) joined[joined.length - 1] = { ...block, y: previous.y, height: block.y + block.height - previous.y };
    else joined.push({ ...block });
  }
  return joined;
}

// Pixel paragraph splitting can isolate a short final line. Reattach aligned
// continuations before wrapping so they keep both the font size and word joins.
export function joinPdfTextTails(blocks) {
  const joined = [];
  for (const block of blocks) {
    const previous = joined.at(-1);
    const previousText = previous ? pdfTextRows(previous.lines).map(row => row.text).join(' ') : '';
    const rows = pdfTextRows(block.lines || []);
    const titleContinuation = /[-\u2010\u00ad]\s*$/.test(previousText) && previousText === previousText.toUpperCase()
      && rows.length === 1 && rows[0].text === rows[0].text.toUpperCase();
    const height = median(block.lines?.map(t => t.height) || []);
    const previousHeight = median(previous?.lines?.map(t => t.height) || []);
    const gap = previous && block.y - previous.y - previous.height;
    if (previous?.kind === 'text' && block.kind === 'text' && rows.length === 1
      && rows[0].text.length <= 160 && (previousText.length > 60
        || previousText.length > 20 && /[-\u2010\u00ad]\s*$/.test(previousText) && previousText === previousText.toUpperCase())
      && (/^\p{Ll}/u.test(rows[0].text.trim()) || /\p{L}[-\u2010\u00ad]\s*$/u.test(previousText))
      && gap >= -1 && gap <= height * 1.5
      && Math.abs(Math.max(block.x, Math.min(...block.lines.map(line => line.x)))
        - Math.max(previous.x, Math.min(...previous.lines.map(line => line.x)))) <= height * .75
      && height / previousHeight > .75 && height / previousHeight < 1.25) {
      const right = Math.max(previous.x + previous.width, block.x + block.width);
      previous.x = Math.min(previous.x, block.x); previous.width = right - previous.x;
      previous.height = Math.max(previous.y + previous.height, block.y + block.height) - previous.y;
      // Double-spaced manuscripts are often cut into one block per source
      // line. A confirmed continuation must not acquire a paragraph break.
      previous.lines.push(...block.lines.map(item => ({ ...item, continuation: true }))); previous.text += ' ' + block.text;
    } else joined.push({ ...block, lines: [...block.lines] });
  }
  return joined;
}

function mostlyTextInk(block, pixels, pageWidth, scan = false) {
  // In scans OCR can identify a few labels inside a much larger figure. Only
  // replace a block when recognized words account for almost all of its ink.
  if (!pixels) return true;
  const x0 = Math.floor(block.x); const y0 = Math.floor(block.y);
  const width = Math.ceil(block.width); const height = Math.ceil(block.height);
  const covered = new Uint8Array(width * height);
  for (const line of block.lines) for (const box of line.words || [line]) {
    // Embedded OCR text often underestimates ascenders in the underlying scan.
    // Allow a bounded vertical tolerance while still requiring the text to
    // explain the ink; unexplained diagrams must continue to stay as images.
    const paddingY = Math.max(2, Math.min(8, box.height * .6));
    const paddingX = Math.max(2, Math.min(8, box.height * .5));
    const left = Math.max(0, Math.floor(box.x - x0 - paddingX)); const right = Math.min(width, Math.ceil(box.x + box.width - x0 + paddingX));
    for (let y = Math.max(0, Math.floor(box.y - y0 - paddingY)); y < Math.min(height, Math.ceil(box.y + box.height - y0 + paddingY)); y++) covered.fill(1, y * width + left, y * width + right);
  }
  // A thin footnote separator just above/below the text is not a diagram.
  // Count every other unexplained stroke, including rules within a table.
  const rules = new Set();
  const footnote = block.annotation?.kind === 'footnote';
  const heading = block.lines.length <= 3 && /^[A-Z\s]+$/.test(block.lines.map(t => t.text).join(' '));
  if (footnote || heading || block.lines.length >= 1 && block.lines.some(t => t.width >= width * .65)) {
    const top = Math.min(...block.lines.map(t => t.y)) - y0;
    const low = Math.max(...block.lines.map(t => t.y + t.height)) - y0;
    const size = median(block.lines.map(t => t.height));
    let run = [];
    for (let y = 0; y <= height; y++) {
      let count = 0; let consecutive = 0; let longest = 0;
      if (y < height && ((y < top - 2 && y >= top - size) || (y > low + 2 && y <= low + size))) {
        for (let x = 0; x < width; x++) {
          const i = ((y + y0) * pageWidth + x + x0) * 4;
          if (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722 < 200) {
            count++; consecutive++; longest = Math.max(longest, consecutive);
          } else consecutive = 0;
        }
      }
      if (count > width * .8 || footnote && longest > width * .25) run.push(y);
      else { if (run.length <= Math.max(2, size * .2)) for (const row of run) rules.add(row); run = []; }
    }
  }
  let ink = 0; let explained = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (rules.has(y)) continue;
    // A scan crop may span a centered label and disconnected binding shadow.
    // Ignore only the outer paper edge, never unexplained interior artwork.
    if (scan && (x + x0 < 20 || x + x0 >= pageWidth - 20)) continue;
    const i = ((y + y0) * pageWidth + x + x0) * 4;
    if (pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722 < 200) {
      ink++; explained += covered[y * width + x];
    }
  }
  return !ink || explained / ink >= .85;
}

export function reflowPdfBlock(block, { fontSize = 20, measure, pixels, pageWidth, allowSparseUncertainty = false } = {}) {
  if (block.kind === 'figure' || !block.lines?.length) return null;
  const rows = pdfTextRows(block.lines); const height = median(block.lines.map(t => t.height));
  if (block.contents) for (const row of rows) {
    const entry = block.contents.find(entry => Math.abs(entry.y - row.y) < 3);
    if (entry) { row.text = entry.text; row.parts = row.items.map(item => ({ item, start: 0, end: row.text.length })); }
  }
  const text = rows.map(r => r.text).join(' ');
  const letters = (text.match(/\p{L}/gu) || []).length;
  const words = text.match(/\p{L}{2,}/gu) || [];
  const math = (text.match(/[=∑∫√≤≥±∞∂∏∈∇{}^]/g) || []).length;
  const shortText = block.kind === 'text' && block.lines.every(t => t.confidence == null || t.confidence >= 80 || t.heading && t.confidence >= 55
    || t.noteMarker && block.annotation?.kind === 'footnote' && t.confidence >= 65)
    && (letters > 0 || /\d/.test(text) || /^[\s*⁂❦]+$/.test(text)) && math === 0;
  if ((!shortText && (letters < 12 || words.length < 4)) || math > Math.max(2, words.length / 12)) return null;
  if (block.lines.some(t => t.confidence != null && t.confidence < 55)) {
    // A single italic/quoted word must not turn an otherwise reliable scan
    // into an image. Bound uncertainty by characters, not by the OCR row count.
    // Short unreadable fragments and consistently poor recognition still fail.
    const tokens = block.lines.flatMap(line => line.words?.length ? line.words : [line]);
    const count = tokens.reduce((sum, token) => sum + token.text.length, 0);
    const weak = tokens.reduce((sum, token) => sum + ((token.confidence ?? 100) < 55 ? token.text.length : 0), 0);
    const confidence = tokens.reduce((sum, token) => sum + (token.confidence ?? 100) * token.text.length, 0) / count;
    if (!allowSparseUncertainty || count < 150 || weak / count > .03 || confidence < 85) return null;
  }
  // A table has a repeated vertical gutter. Justified scans can have wide
  // spaces on many lines without sharing a column boundary.
  const gaps = rows.map(row => row.items.slice(1).flatMap((item, i) => {
    const left = row.items[i].x + row.items[i].width;
    return item.x - left > height * 2.5 ? [[left, item.x]] : [];
  }));
  const tableRows = Math.max(2, rows.length * .4);
  if (!block.contents && gaps.flat().some(([left, right]) => gaps.filter(row => row.some(([a, b]) =>
    Math.min(right, b) - Math.max(left, a) > height * 1.5)).length >= tableRows)) return null;
  if (!block.contents && !block.digitizationCredit && !mostlyTextInk(block, pixels, pageWidth, allowSparseUncertainty)) return null;
  const paragraphs = []; let paragraph;
  for (const [i, row] of rows.entries()) {
    const last = rows[i - 1];
    const newParagraph = !last || block.contents || row.y - last.y > height * 1.8 && !row.items.some(item => item.continuation)
      || row.items[0].paragraph != null && row.items[0].paragraph !== last.items[0].paragraph
      || row.items[0].x - block.x > height && last.items[0].x - block.x < height * .5;
    if (newParagraph) { paragraph = { text: '', parts: [] }; paragraphs.push(paragraph); }
    if (paragraph.text) {
      paragraph.text = paragraph.text.trimEnd();
      if (/\p{L}[-\u2010\u00ad]$/u.test(paragraph.text) && (/^\p{Ll}/u.test(row.text)
        || paragraph.text === paragraph.text.toUpperCase() && row.text === row.text.toUpperCase())) {
        // Preserve an existing compound ending in a linking word, such as
        // stipulated-to- / be-sound or state-of-the- / art.
        if (!/\p{L}-(?:to|of|the|in|on|by|for|and)-$/u.test(paragraph.text)) paragraph.text = paragraph.text.slice(0, -1);
      }
      else paragraph.text += ' ';
    }
    const offset = paragraph.text.length; paragraph.text += row.text;
    paragraph.parts.push(...row.parts.map(p => ({ ...p, start: p.start + offset, end: p.end + offset })));
  }
  const wrapped = []; const lineHeight = Math.ceil(fontSize * 1.25); let y = 0; let offset = 0;
  const width = 552; const size = measure || (value => [...value].length * fontSize * .52);
  for (const p of paragraphs) {
    let start = 0;
    while (start < p.text.length) {
      let end = start; let space = -1;
      for (const char of p.text.slice(start)) {
        const next = end + char.length;
        if (size(p.text.slice(start, next)) > width && end > start) break;
        if (/\s/.test(char)) space = end;
        end = next;
      }
      if (end < p.text.length && space > start) end = space;
      const parts = p.parts.filter(part => part.end > start && part.start < end);
      wrapped.push({ text: p.text.slice(start, end).trimEnd(), y, start: offset + start, end: offset + end,
        sourceY: parts[0]?.item.y ?? block.y, items: parts.map(part => part.item) });
      y += lineHeight; start = end;
      while (/\s/.test(p.text[start] || '') && start < p.text.length) start++;
    }
    offset += p.text.length + 1; y += Math.ceil(lineHeight * .4);
  }
  return { rows: wrapped, fontSize, lineHeight, height: y - Math.ceil(lineHeight * .4),
    text: paragraphs.map(p => p.text).join('\n\n') };
}
