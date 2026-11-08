// Preserve source coordinates for both image crops and optional reflowed prose.
// A page may alternate full-width bands and left-then-right columns.
import { pdfMarginMasks, insidePdfMargin } from './pdf-margins.js';
import { pdfFigures } from './pdf-figures.js';
import { pdfColumnRegions } from './pdf-columns.js';
import { pdfSourcePoint } from './pdf-orientation.js';
import { preparePdfNative, pdfNativeWindow, pdfImageEnd } from './pdf-native.js';
export const PDF_WIDTH = 576;
export const PDF_SCREEN = 258;
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] || 12;

// Paths in a vector figure arrive separately (boxes, arrows, curves). Join
// touching bounds before deciding whether a drawing spans the column gutter.
export function groupPdfDrawings(drawings, width, height) {
  const groups = [];
  for (const box of drawings) {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)
      || box.width * box.height > width * height * .85) continue;
    let group = { ...box }; let merged;
    do {
      merged = false;
      for (let i = groups.length - 1; i >= 0; i--) {
        const other = groups[i]; const gap = 4;
        if (group.x > other.x + other.width + gap || other.x > group.x + group.width + gap
          || group.y > other.y + other.height + gap || other.y > group.y + group.height + gap) continue;
        const x = Math.min(group.x, other.x); const y = Math.min(group.y, other.y);
        group = { x, y, width: Math.max(group.x + group.width, other.x + other.width) - x,
          height: Math.max(group.y + group.height, other.y + other.height) - y };
        groups.splice(i, 1); merged = true;
      }
    } while (merged);
    groups.push(group);
  }
  return groups.filter(box => box.width > 24 && box.height > 24 && box.width * box.height < width * height * .85);
}

function mergeBands(bands, gap) {
  const result = [];
  for (const band of bands.filter(b => Number.isFinite(b[0]) && Number.isFinite(b[1]) && b[1] > b[0]).sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && band[0] <= last[1] + gap) last[1] = Math.max(last[1], band[1]);
    else result.push([...band]);
  }
  return result;
}

export function analyzePdfPage({ width, height, data, text = [], figureText = text, images = [], mode = 'auto', keepMarginNotes = false, pageMasks = [] }) {
  const stride = width + 1;
  const sums = new Uint32Array(stride * height);
  text = text.filter(t => !insidePdfMargin(t, pageMasks));
  const scanPage = images.some(image => image.width*image.height >= width*height*.85);
  images = pdfFigures({ width, height, data, text: figureText.filter(t => !insidePdfMargin(t, pageMasks)), images, pageMasks });
  const marginMasks = [...pageMasks, ...(keepMarginNotes ? [] : pdfMarginMasks({ width, height, text, images }))];
  text = text.filter(t => !insidePdfMargin(t, marginMasks));
  const inkAt = p => data[p + 3] > 20 && (data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722) < 235;
  const spine = new Set();
  // A narrow, nearly page-height binding shadow is not a column of text.
  // Only remove it in textless landscape scans, where two facing pages occur.
  if (!text.length && width > height * 1.2) {
    const runs = []; const density = new Map(); let start = null;
    for (let x = Math.floor(width * .4); x <= Math.ceil(width * .6); x++) {
      let ink = 0; for (let y = 0; y < height; y++) ink += Number(inkAt((y * width + x) * 4));
      density.set(x, ink);
      if (ink > height * .75) { if (start == null) start = x; }
      else if (start != null) { runs.push([start, x]); start = null; }
    }
    for (let [left, right] of runs) if (right - left < width * .025) {
      while (density.get(left - 1) > height * .02 && right - left < width * .04) left--;
      while (density.get(right) > height * .02 && right - left < width * .04) right++;
      for (let x = left - 3; x < right + 3; x++) spine.add(x);
    }
  }
  for (let y = 0; y < height; y++) {
    const base = y * stride;
    const masks = marginMasks.filter(t => y >= t.y && y < t.y + t.height);
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const ink = !spine.has(x) && !masks.some(t => x >= t.x && x < t.x + t.width) && inkAt(p);
      sums[base + x + 1] = sums[base + x] + Number(ink);
    }
  }
  const rowInk = (x0, x1, y) => sums[y * stride + Math.ceil(x1)] - sums[y * stride + Math.floor(x0)];
  const crop = (x0, y0, x1, y1) => {
    let left = x1; let top = y1; let right = x0; let bottom = y0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      if (!rowInk(x0, x1, y)) continue;
      top = Math.min(top, y); bottom = y + 1;
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        if (rowInk(x, x + 1, y)) { left = Math.min(left, x); right = Math.max(right, x + 1); }
      }
    }
    return right > left ? { x: Math.max(x0, left - 1), y: Math.max(y0, top - 2),
      width: Math.min(x1, right + 1) - Math.max(x0, left - 1), height: Math.min(y1, bottom + 2) - Math.max(y0, top - 2) } : null;
  };
  const bounds = crop(0, 0, width, height);
  if (!bounds) return { blocks: [], columns: false, bounds: null, marginMasks };
  // Embedded charts often contain white padding wider than every visible
  // mark on the page. Intersect their bounds with the page's visible extent
  // before testing region containment, or each chart band becomes a crop.
  // Full-page scans retain their original bounds for scan classification.
  images = images.map(image => {
    if (image.width * image.height >= width * height * .85) return image;
    const x = Math.max(bounds.x, image.x), y = Math.max(bounds.y, image.y);
    return { ...image, x, y, width: Math.min(bounds.x + bounds.width, image.x + image.width) - x,
      height: Math.min(bounds.y + bounds.height, image.y + image.height) - y };
  }).filter(image => image.width > 0 && image.height > 0);
  const x0 = bounds.x; const x1 = x0 + bounds.width;
  const y0 = bounds.y; const y1 = y0 + bounds.height;
  // Some PDFs outline their body glyphs, leaving only toolbar text in the text
  // layer. Raster line heights keep those paragraphs together instead of
  // enlarging each short last line independently.
  const inkBands = []; let inkStart = null;
  for (let y = y0; y <= y1; y++) {
    if (y < y1 && rowInk(x0, x1, y)) { if (inkStart == null) inkStart = y; }
    else if (inkStart != null) { inkBands.push(y - inkStart); inkStart = null; }
  }
  const rasterHeights = inkBands.filter(h => h >= 6 && h <= 32);
  const lineHeight = Math.max(8, Math.min(32, Math.max(median(text.map(t => t.height).filter(h => h > 4)),
    rasterHeights.length >= 8 ? median(rasterHeights) : 0)));
  const gutter = Math.max(4, Math.min(12, lineHeight * .4));
  let split = null; let best = 0;
  if (mode !== 'single') for (let x = x0 + bounds.width * .32; x <= x0 + bounds.width * .68; x += 3) {
    const spanning = new Uint8Array(height);
    const middle = (x0 + x1) / 2;
    for (const box of [...text.filter(t => t.width > bounds.width * .6
      || (t.x < middle - bounds.width * .1 && t.x + t.width > middle + bounds.width * .1)),
      ...images.filter(image => image.width * image.height < width * height * .85)]) {
      if (box.x < x - gutter && box.x + box.width > x + gutter) {
        spanning.fill(1, Math.max(0, Math.floor(box.y)), Math.min(height, Math.ceil(box.y + box.height)));
      }
    }
    let paired = 0; let clear = 0;
    for (let y = y0; y < y1; y++) {
      if (spanning[y]) continue;
      // Compare candidates using the same outer-column evidence. Otherwise a
      // short centered heading can reward a "gutter" that clips a body line
      // merely because it changes which rows enter the denominator.
      const pairedInk = text.length
        ? rowInk(x0, x0 + bounds.width * .3, y) > 2 && rowInk(x1 - bounds.width * .3, x1, y) > 2
        : rowInk(x0, x - gutter, y) > 2 && rowInk(x + gutter, x1, y) > 2;
      if (pairedInk) {
        paired++; if (rowInk(x - gutter, x + gutter, y) <= (text.length ? 0 : 2)) clear++;
      }
    }
    const score = paired >= 24 ? clear / paired - Math.abs(x - (x0 + x1) / 2) / bounds.width * .15 : 0;
    if (score > best) { best = score; split = x; }
  }
  if (mode === 'double' && split == null) split = (x0 + x1) / 2;
  if (mode === 'auto' && best < .55) split = null;
  const magazine = mode === 'auto' && pdfColumnRegions(text, images.filter(image => image.width*image.height < width*height*.85), bounds, lineHeight);
  const regions = magazine || [];
  if (magazine) {
    // A thin publisher rule at a detected gutter must not connect a short
    // pull quote to the bottom of an otherwise empty column. Keep its pixels
    // in the original PDF, but exclude the rule from paragraph segmentation.
    const candidates = new Set(regions.flatMap(r => [r[0],r[2]]).filter(x=>x>x0 && x<x1)
      .flatMap(x=>Array.from({length:5},(_,i)=>Math.floor(x)+i-2)));
    const rules = [...candidates].filter(x=>x>=0 && x<width && !text.some(t=>t.x<x && t.x+t.width>x)
      && Array.from({length:height},(_,y)=>rowInk(x,x+1,y)>0).filter(Boolean).length > height*.7);
    for (let y=0;y<height && rules.length;y++) {
      const ink=rules.filter(x=>rowInk(x,x+1,y)>0).sort((a,b)=>a-b); let count=0;
      for (let x=0;x<width;x++) { if (x===ink[count]) count++; sums[y*stride+x+1]-=count; }
    }
  }
  // The single pixel split is not a valid OCR correction boundary in a
  // three-column layout. These regions already preserve the text geometry.
  if (magazine) split = null;
  else if (split == null) regions.push([x0, y0, x1, y1]);
  else {
    const spans = [];
    // A scanned column edge may drift into the wider gutter used to score
    // candidate splits. Only ink at the split itself connects the columns;
    // otherwise a few skewed letters reorder the remaining left-column text.
    const spanGutter = scanPage ? Math.min(gutter,1.5) : gutter;
    // Pixel evidence protects full-width figures as well as text. Text boxes
    // fill the spaces between words in a line that crosses the gutter.
    for (let y = y0; y < y1; y++) if (rowInk(split - spanGutter, split + spanGutter, y) > (text.length ? 0 : 2)) spans.push([y, y + 1]);
    for (const box of [...text, ...images.filter(image => image.width * image.height < width * height * .85)]) {
      if (box.x < split && box.x + box.width > split) {
        const padding = scanPage && box.text != null ? 1 : Math.max(3, Math.min(12, box.height * .35));
        spans.push([Math.max(y0, Math.floor(box.y - padding)), Math.min(y1, Math.ceil(box.y + box.height + padding))]);
      }
    }
    // Pixel spans may stop at a letter's baseline. Expand them to whole text
    // boxes so descenders and adjacent words do not become separate crops.
    const marked = new Uint8Array(height);
    for (const [start, end] of spans) marked.fill(1, Math.max(0, Math.floor(start)), Math.min(height, Math.ceil(end)));
    for (const box of text) {
      const padding = scanPage ? 0 : 3;
      const start = Math.max(y0, Math.floor(box.y - padding)); const end = Math.min(y1, Math.ceil(box.y + box.height + padding));
      if (marked.subarray(start, end).some(Boolean)) spans.push([start, end]);
    }
    const full = mergeBands(spans, lineHeight * .8);
    const columns = (top, bottom, checkCaption = true) => {
      if (bottom <= top) return;
      // A full-width figure may have a two-column caption followed by body
      // columns. Finish BOTH caption columns before starting the body. Only
      // consider a pronounced text gap just below a figure, not paragraph
      // gaps throughout an ordinary continuous two-column article.
      if (checkCaption && images.some(b => Math.abs(b.y + b.height - top) < lineHeight * 3
        && b.x < split && b.x + b.width > split)) {
        const occupied = new Uint8Array(height);
        for (const b of [...text, ...images]) occupied.fill(1, Math.max(0, Math.floor(b.y)), Math.min(height, Math.ceil(b.y + b.height)));
        let start = null;
        const limit = Math.min(bottom, top + lineHeight * 18);
        for (let y = Math.ceil(top); y < limit; y++) {
          if (!occupied[y]) { if (start == null) start = y; }
          else if (start != null) {
            const count = (from, to, left) => text.filter(t => t.y >= from && t.y + t.height <= to
              && (t.x + t.width / 2 < split) === left).length;
            if (y - start >= lineHeight * 2 && [true, false].every(left => count(top, start, left) >= 3 && count(y, bottom, left) >= 3)) {
              columns(top, start, false); columns(y, bottom, false); return;
            }
            start = null;
          }
        }
      }
      const left = crop(x0, top, split, bottom); const right = crop(split, top, x1, bottom);
      if (left && right && Math.min(left.height, right.height) >= lineHeight * 3) regions.push([x0, top, split, bottom], [split, top, x1, bottom]);
      else regions.push([x0, top, x1, bottom]);
    };
    let top = y0;
    for (const [start, end] of full) { columns(top, start); regions.push([x0, start, x1, end]); top = end; }
    columns(top, y1);
  }
  const blocks = [];
  const widthBands = (left, start, right, end) => {
    const rows = []; let first = null;
    for (let y = start; y <= end; y++) {
      if (y < end && rowInk(left, right, y)) { if (first == null) first = y; }
      else if (first != null) { rows.push([first, y]); first = null; }
    }
    const bands = mergeBands(rows, 2).map(([a, b]) => ({ start: a, end: b, box: crop(left, a, right, b) })).filter(b => b.box);
    const body = bands.filter(b => b.box.width > (right - left) * .4 && b.box.height >= lineHeight * .3);
    if (body.length < 4) return [[start, end]];
    const typicalLeft = median(body.map(b => b.box.x));
    const typicalRight = median(body.map(b => b.box.x + b.box.width));
    const bodyLeft = Math.min(...body.map(b => b.box.x).filter(x => x >= typicalLeft - lineHeight * 1.5));
    const bodyRight = Math.max(...body.map(b => b.box.x + b.box.width).filter(x => x <= typicalRight + lineHeight * 1.5));
    const tolerance = Math.max(lineHeight * .8, (right - left) * .04);
    // Short paragraph endings stay at the body scale. Only actual extensions
    // into an outside lane change the group; ordinary ragged lines do not.
    const groups = []; let previous;
    for (const band of bands) {
      const outside = band.box.x < bodyLeft - tolerance || band.box.x + band.box.width > bodyRight + tolerance;
      if (previous == null) groups.push([start, end]);
      else if (outside !== previous.outside) {
        const cut = Math.floor((previous.end + band.start) / 2);
        groups.at(-1)[1] = cut; groups.push([cut, end]);
      }
      previous = { ...band, outside };
    }
    return groups.length ? groups : [[start, end]];
  };
  // Short glyphs (asterisks, punctuation and superscripts) can occupy only
  // the top of a font box. Assign each transcript once by greatest overlap,
  // rather than requiring its center to fall inside the printed ink band.
  const assignText = (items, bounds) => {
    const assigned = bounds.map(() => []);
    for (const item of items) {
      let best = -1, overlap = 0;
      for (const [i, [left, top, right, bottom]] of bounds.entries()) {
        if (item.x + item.width / 2 < left || item.x + item.width / 2 >= right) continue;
        const score = Math.min(bottom, item.y + item.height) - Math.max(top, item.y);
        if (score > overlap) { best = i; overlap = score; }
      }
      if (best >= 0) assigned[best].push(item);
    }
    return assigned;
  };
  const assignedRegions = assignText(text, regions);
  for (const [regionIndex, [left, top, right, bottom]] of regions.entries()) {
    const bands = [];
    for (let y = Math.floor(top); y < Math.ceil(bottom); y++) if (rowInk(left, right, y)) bands.push([y, y + 1]);
    // Paragraph gaps become preferred screen starts. An embedded image stays
    // one block even when it contains large white areas inside its bounds.
    for (const image of images) {
      if (image.width * image.height < width * height * .85 && image.x >= left - 2 && image.x + image.width <= right + 2) {
        const start = Math.max(top, image.y); const end = Math.min(bottom, image.y + image.height);
        if (end > start) bands.push([start, end]);
      }
    }
    const paragraphs = mergeBands(bands, Math.max(5, lineHeight * .65)).flatMap(([a, b]) => {
      const hasFigure = images.some(image => image.width * image.height < width * height * .85
        && image.x >= left - 2 && image.x + image.width <= right + 2
        && image.y < b && image.y + image.height > a && image.height > lineHeight * 1.5);
      if (hasFigure) return [[a, b]];
      const split = widthBands(left, Math.floor(a), right, Math.ceil(b));
      return split.map(([start, end]) => [start, end, split.length > 1]);
    });
    const assignedParagraphs = assignText(assignedRegions[regionIndex], paragraphs.map(([start, end]) => [left, start, right, end]));
    for (const [paragraphIndex, [start, end, splitParagraph]] of paragraphs.entries()) {
      const box = crop(left, Math.floor(start), right, Math.ceil(end));
      if (!box) continue;
      let ink = 0;
      for (let row = Math.floor(box.y); row < Math.min(height, Math.ceil(box.y + box.height)); row++) ink += rowInk(box.x, box.x + box.width, row);
      const lines = assignedParagraphs[paragraphIndex];
      // A few scan specks or a thin binding/edge mark must not become a whole
      // screen. Keep uncertain small content at a bounded scale below.
      if (!lines.length && (ink < 16 || box.width < 5 || box.height < 3
        || ink / (box.width * box.height) < .006)) continue;
      const figureBounds = images.filter(image => image.width * image.height < width * height * .85
        && image.x >= left - 2 && image.x + image.width <= right + 2
        && image.y < end && image.y + image.height > start && image.height > lineHeight * 1.5);
      const figure = figureBounds.length > 0;
      const meaningful = figure || lines.length >= 2 || box.width >= (right - left) * .4;
      blocks.push({ ...box, text: lines.map(t => t.text).join(' '), lines,
        kind: figure ? 'figure' : lines.length ? 'text' : 'scan',
        ...(figure ? { figureBounds } : {}),
        maxScale: meaningful ? 4 : 2,
        fillWidth: meaningful && (figure || splitParagraph || box.height >= lineHeight * 1.5) });
    }
  }
  return { blocks, columns: regions.some(r => r[2] - r[0] < bounds.width * .8), bounds, split, marginMasks };
}

export function pdfPageTurn(layout, y, direction) {
  if (direction < 0) return layout.pages.findLast(value => value < y - .5) ?? Math.max(0, y - PDF_SCREEN + 27);
  const current = layout.blocks.findLastIndex(block => block.y <= y + .5);
  if (layout.blocks[current] && !layout.blocks[current].reflow) return Math.min(layout.maxY, layout.blocks[current + 1]?.y ?? layout.maxY);
  const native = pdfNativeWindow(layout, y);
  if (native) return native.nextY;
  const textStart = pdfImageEnd(layout, y);
  if (textStart <= y + PDF_SCREEN) return Math.min(layout.maxY, textStart);
  const end = Math.min(layout.maxY, y + PDF_SCREEN);
  const nextFigure = layout.blocks.find(b => b.keepTogether && b.y > y + .5 && b.y < y + PDF_SCREEN && b.y + b.drawHeight > y + PDF_SCREEN);
  if (nextFigure) return nextFigure.y;
  if (end >= layout.maxY) return layout.maxY;
  const start = layout.blocks.findLast(block => block.y > y + 27 && block.y <= end - 12)?.y;
  if (start != null) return start;
  const target = Math.min(layout.maxY, y + PDF_SCREEN - 27);
  // Prefer a text line's top when an unaligned position is close to a boundary.
  return layout.lineStarts.findLast(value => value > y + 27 && value <= target && value >= target - 35) ?? target;
}

export function createPdfLayout(pages, { textSize = 20, readingOrder = null } = {}) {
  const blocks = []; const headings = []; const blockY = []; const lineStarts = []; let y = 0;
  for (const page of pages) {
    const heading = { index: headings.length, text: `PDF page ${page.number}`, level: 1 };
    headings.push(heading);
  }
  const sourcePages = new Map(pages.map(page => [page.number, page]));
  for (const { page: number, block: crop } of readingOrder || pages.flatMap(page => page.blocks.map(block => ({ page: page.number, block })))) {
    const page = sourcePages.get(number);
    // A standalone scan of a thin divider must not become an image-only
    // page between native paragraphs. Keep actual figures and text/equations,
    // and preserve all original crops when reflow is disabled.
    if (page.blocks.some(block => block.reflow) && crop.kind === 'scan' && !crop.lines.length
      && crop.height <= 8 && crop.width >= Math.max(80, crop.height * 40)) continue;
    let scale = Math.min(crop.fillWidth ? (crop.maxScale ?? 4) : 2, PDF_WIDTH / crop.width);
    // Every raster block occupies one glasses pane. Source geometry stays
    // intact so the phone gallery can render it at a larger resolution.
    if (!crop.reflow) {
      scale = Math.min(scale, PDF_SCREEN / crop.height);
    }
    const block = { ...crop, sourceY: crop.y, y, page: page.number, scale, drawHeight: Math.ceil(crop.height * scale - 1e-8) };
    if (crop.reflow) {
      block.drawHeight = crop.reflow.height;
      block.text = crop.reflow.text;
      block.lines = crop.lines.map(line => ({ ...line, displayY: crop.reflow.rows.find(row => row.items.includes(line))?.y ?? 0 }));
      lineStarts.push(...crop.reflow.rows.map(row => y + row.y));
    }
    block.keepTogether = !crop.reflow;
    blocks.push(block);
    if (!crop.reflow && crop.kind !== 'figure') for (const line of crop.lines) lineStarts.push(y + Math.max(0, line.y - crop.y) * scale);
    y += block.drawHeight + 12;
  }
  for (const page of pages) blockY.push(blocks.find(block => block.page === page.number && !block.annotation)?.y
    ?? blocks.find(block => block.page === page.number)?.y ?? y);
  const height = Math.max(1, y - 12);
  const layout = { format: 'pdf', blocks, headings, blockY, lineStarts: lineStarts.sort((a, b) => a - b), height,
    maxY: Math.max(0, height - PDF_SCREEN, blocks.at(-1)?.y || 0), pages: [0], rows: [], size: textSize };
  layout.annotations = pages.flatMap(page => (page.annotations || []).map(crop => {
    const scale = Math.min(2, PDF_WIDTH / crop.width);
    return { ...crop, page: page.number, sourceY: crop.y, y: 0, scale, drawHeight: Math.ceil(crop.height * scale) };
  }));
  for (let position = 0; position < height; position += 27) layout.rows.push({ y: position, height: 27 });
  preparePdfNative(layout);
  while (layout.pages.at(-1) < layout.maxY) layout.pages.push(pdfPageTurn(layout, layout.pages.at(-1), 1));
  return layout;
}

export function pdfAnchor(layout, y) {
  let block = layout.blocks.findLast(b => b.y <= y) || layout.blocks[0];
  if (block?.annotationLabel) { block = layout.blocks[layout.blocks.indexOf(block) + 1] || block; y = block.y; }
  const row = block?.reflow?.rows.findLast(row => block.y + row.y <= y) || block?.reflow?.rows[0];
  const point = block && pdfSourcePoint(block, { x: block.x + block.width / 2, y: row?.sourceY ?? block.sourceY + (y - block.y) / block.scale });
  return { text: block?.text.slice(0, 60) || 'PDF image', heading: `PDF page ${block?.page || 1}`,
    percent: layout.maxY ? y / layout.maxY * 100 : 0,
    pdf: block ? { page: block.page, ...point, turn: block.turn || 0,
      textOffset: row?.start, textSize: block.reflow?.fontSize, nativeWrap: block.reflow?.nativeWrap,
      region: [block.x, block.sourceY, block.width, block.height], offset: y - block.y, scale: block.scale } : { page: 1, x: 0, y: 0 } };
}
export function restorePdfAnchor(layout, anchor) {
  const point = anchor?.pdf;
  const exact = point?.region && layout.blocks.find(b => !b.annotationLabel && b.page === point.page
    && (b.turn || 0) === (point.turn || 0) && [b.x, b.sourceY, b.width, b.height].every((value, i) => Math.abs(value - point.region[i]) < .01));
  if (exact?.reflow) {
    const row = Number.isFinite(point.textOffset)
      ? exact.reflow.rows.findLast(row => row.start <= point.textOffset)
      : exact.reflow.rows.findLast(row => row.sourceY <= pdfSourcePoint(exact, point, true).y);
    return Math.max(0, Math.min(layout.maxY, exact.y + (point.textSize === exact.reflow.fontSize && point.nativeWrap === exact.reflow.nativeWrap ? point.offset : row?.y || 0)));
  }
  if (exact && Number.isFinite(point.offset)) return Math.max(0, Math.min(layout.maxY, exact.y
    + (point.textSize == null && point.scale === exact.scale ? point.offset : (pdfSourcePoint(exact, point, true).y - exact.sourceY) * exact.scale)));
  const candidates = point ? layout.blocks.filter(b => !b.annotationLabel && b.page === point.page
    && pdfSourcePoint(b, point, true).x >= b.x - 2 && pdfSourcePoint(b, point, true).x <= b.x + b.width + 2) : [];
  // Prefer the actual source crop: tolerance around the preceding note must
  // not steal a bookmark after an old combined note crop has been split.
  const block = candidates.find(b => pdfSourcePoint(b, point, true).y >= b.sourceY && pdfSourcePoint(b, point, true).y < b.sourceY + b.height)
    || candidates.find(b => pdfSourcePoint(b, point, true).y >= b.sourceY - 2 && pdfSourcePoint(b, point, true).y <= b.sourceY + b.height + 12 / b.scale);
  const sourceY = block ? pdfSourcePoint(block, point, true).y : 0;
  return Math.max(0, Math.min(layout.maxY, block ? block.y + (block.reflow
    ? block.reflow.rows.findLast(row => row.sourceY <= sourceY)?.y || 0
    : (sourceY - block.sourceY) * block.scale) : layout.maxY * (anchor?.percent || 0) / 100));
}
