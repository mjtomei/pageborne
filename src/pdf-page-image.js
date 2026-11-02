import { pdfTextRows } from './pdf-reflow.js';
import { pdfContentsEntries } from './pdf-contents.js';

// Inspect the original scan before contrast normalization turns paper shading
// and bleed-through into "ink". Blank leaves may have a few isolated specks,
// but no recognized text, substantial dark/gray area, or coherent detail.
export function pdfBlankScan({ width, height, data, text, bounds }) {
  if (text.some(line => /[\p{L}\d]/u.test(line.text))) return false;
  const edge = Math.max(4, Math.min(bounds ? 40 : 24, Math.ceil(Math.min(width, height) * (bounds ? .04 : .025))));
  // Layout crops can include the tail of an underline at their boundary.
  const left = Math.max(edge, bounds ? Math.ceil(bounds.x) + 8 : 0);
  const top = Math.max(edge, bounds ? Math.ceil(bounds.y) + 8 : 0);
  const right = Math.min(width - edge, bounds ? Math.floor(bounds.x + bounds.width) - 8 : width);
  const bottom = Math.min(height - edge, bounds ? Math.floor(bounds.y + bounds.height) - 8 : height);
  if (bounds && (right <= left || bottom <= top)) return bounds.x + bounds.width <= edge + 8
    || bounds.y + bounds.height <= edge + 8 || bounds.x >= width - edge - 8 || bounds.y >= height - edge - 8;
  const area = Math.max(1, (right - left) * (bottom - top)), scale = area / (860 * 1310);
  const gray = p => data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722;
  const details = bounds ? new Set() : null;
  let dark = 0, shade = 0, detail = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const p = (y * width + x) * 4;
    if (data[p + 3] <= 20) continue;
    const value = gray(p);
    if (value < 170 && ++dark > Math.max(8, 64 * scale)) return false;
    if (value < (bounds ? 200 : 220) && ++shade > area * .025) return false;
    if (Math.max(gray(p - 12), gray(p + 12), gray(p - width * 12), gray(p + width * 12)) - value >= 8) {
      detail++;
      if (!bounds && detail > Math.max(24, 200 * scale) || bounds && detail > 400) return false;
      details?.add(y * width + x);
    }
  }
  // A few small, pale stains are paper noise. Even a faint continuous stroke
  // longer than 16 analysis pixels protects an otherwise textless crop.
  if (details && detail > Math.max(24, 200 * scale)) while (details.size) {
    const first = details.values().next().value, pending = [first]; details.delete(first);
    let minX = first % width, maxX = minX, minY = Math.floor(first / width), maxY = minY;
    while (pending.length) {
      const point = pending.pop(), x = point % width, y = Math.floor(point / width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (maxX - minX >= 16 || maxY - minY >= 16) return false;
      for (const next of [point - 1, point + 1, point - width, point + width]) if (details.delete(next)) pending.push(next);
    }
  }
  return true;
}

// A cover, title page or plate is one image, even when OCR finds a few labels.
// Dense scanned prose still goes through the normal text/column reflow path.
export function pdfWholePageImage({ width, height, data, images, text, blank = false, reflow = false }) {
  if (!images.some(image => image.kind !== 'drawing' && image.width * image.height >= width * height * .85)) return null;
  if (blank) return { blocks: [], bounds: null, columns: false, marginMasks: [] };
  // A digitizer's watermark is not book artwork. Keep its short credit readable
  // without magnifying the pale logo, and expose the original in the gallery.
  const credit = line => /^(?:digitized|digitised|scanned) by\b/i.test(line.text);
  if (reflow && text.length >= 2 && text.length <= 4 && text.some(credit)
    && text.every(line => line.confidence >= (/^https?:/i.test(line.text) ? 70 : 80) && (credit(line) || /^(?:in\s+)?(?:18|19|20)\d{2}\.?$/i.test(line.text)
      || /^https?:\/\/\S+$/i.test(line.text)))) {
    const bounds = { x: 0, y: 0, width, height };
    return { blocks: [{ ...bounds, kind: 'text', lines: text, text: text.map(line => line.text).join('\n'),
      digitizationCredit: true, originalPage: { width, height } }], bounds, columns: false, marginMasks: [] };
  }
  const prose = pdfTextRows(text).filter(row => row.text.length >= 35 && row.text.trim().split(/\s+/).length >= 5);
  if (prose.length >= 5 && prose.reduce((sum, row) => sum + row.text.length, 0) >= 240) return null;
  // A paragraph continued onto an otherwise empty leaf is not a title page.
  // This only admits it to analysis: unexplained pixels still trigger the
  // whole-page fallback after reflow, protecting illustrations and plates.
  if (reflow && (pdfContentsEntries(text, width).length || prose.length >= 2
    && prose.reduce((sum, row) => sum + row.text.length, 0) >= 160
    && prose.some(row => /^[a-z]/.test(row.text.trim()) || /[.!?][”’"']?$/.test(row.text.trim())))) return null;
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 20 && data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722 < 235 && ++ink >= 20) {
      const bounds = { x: 0, y: 0, width, height };
      return { blocks: [{ ...bounds, kind: 'figure', fullPage: true, lines: [], text: '' }],
        bounds, columns: false, marginMasks: [] };
    }
  }
  return null;
}

// Once a scan has readable prose, a textless fragment containing only ink in
// the outer paper edge is binding/shadow noise, not another reading pane.
// Check pixels, not just the bounding box: two disconnected edge marks can
// produce a page-wide crop. Preserve every fragment with any interior ink,
// recognized text, or figure classification, and leave whole-page scans alone.
export function removePdfScanBorderFragments({ blocks, width, height, data, originalData }) {
  if (blocks.filter(block => block.kind === 'text').reduce((sum, block) => sum + block.text.length, 0) < 240) return blocks;
  const edge = Math.max(2, Math.min(20, Math.min(width, height) * .025));
  return blocks.filter(block => {
    if (block.kind !== 'scan' || block.fullPage || block.lines.length || block.text.trim()) return true;
    // Contrast normalization exaggerates paper gradients and bleed-through.
    // Only inspect textless scan crops; classified art and recognized text stay.
    if (originalData && pdfBlankScan({ width, height, data: originalData, text: [], bounds: block })) return false;
    if (block.x > 2 && block.y > 2 && block.x + block.width < width - 2 && block.y + block.height < height - 2) return true;
    const left = Math.max(Math.ceil(edge), Math.floor(block.x)), top = Math.max(Math.ceil(edge), Math.floor(block.y));
    const right = Math.min(Math.floor(width - edge), Math.ceil(block.x + block.width));
    const bottom = Math.min(Math.floor(height - edge), Math.ceil(block.y + block.height));
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const p = (y * width + x) * 4;
      if (data[p + 3] > 20 && data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722 < 235) return true;
    }
    return false;
  });
}

// Unresolved scanned content stays in its full source page. Mixing readable
// paragraphs with cropped OCR failures makes an underline look like artwork
// and loses the context needed to inspect a genuinely illegible passage.
// Native PDF figures are unaffected; separate handwriting annotations stay.
export function pdfScanPageFallback(analysis, { width, height, images }) {
  if (!images.some(image => image.kind !== 'drawing' && image.width * image.height >= width * height * .85)
    || analysis.blocks.some(block => block.fullPage)
    || !analysis.blocks.some(block => !block.reflow)) return analysis;
  const bounds = { x: 0, y: 0, width, height };
  return { ...analysis, bounds, columns: false, marginMasks: [],
    blocks: [{ ...bounds, kind: 'figure', fullPage: true, lines: [], text: '' }] };
}
