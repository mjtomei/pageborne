const end = box => box.x + box.width;
const bottom = box => box.y + box.height;
const quantile = (values, fraction) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];

// Require repeated wide body lines before identifying a narrow outside lane.
// This deliberately leaves uncertain layouts (including textless scans) alone.
// OCR/PDF text is often split into words, so first join nearby, aligned pieces.
export function pdfMarginMasks({ width, height, text, images }) {
  const stamps = text.filter(t => /^\s*arxiv\s*:/i.test(t.text) && t.height > t.width * 4
    && (end(t) < width * .12 || t.x > width * .88));
  const masks = stamps.map(t => ({ x: Math.max(0, t.x - 3), y: Math.max(0, t.y - 3),
    width: t.width + 6, height: t.height + 6 }));
  // Short words and punctuation still connect a justified body line. Omitting
  // e.g. "in", "by" or "is" made real body rows look like disconnected cells.
  const horizontal = text.filter(t => !stamps.includes(t) && t.width > 0 && t.height > 4
    && t.height < Math.max(width * .08, t.width * 4));
  const rows = [];
  // Sort the filtered copy; phone WebViews may not provide Array.toSorted.
  for (const box of horizontal.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.findLast(r => Math.abs(r.cy - (box.y + box.height / 2)) < Math.min(r.height, box.height) * .3
      && Math.min(r.height, box.height) / Math.max(r.height, box.height) > .7);
    if (row) row.parts.push(box);
    else rows.push({ cy: box.y + box.height / 2, height: box.height, parts: [box] });
  }
  const lines = [];
  for (const row of rows) {
    let line;
    for (const box of row.parts.sort((a, b) => a.x - b.x)) {
      if (line && box.x - end(line) <= row.height * 1.2) {
        const right = Math.max(end(line), end(box)); const low = Math.max(bottom(line), bottom(box));
        line.y = Math.min(line.y, box.y); line.height = low - line.y; line.width = right - line.x;
      } else { line = { ...box }; lines.push(line); }
    }
  }
  const body = lines.filter(t => t.width >= width * .45 && t.height < t.width / 8);
  if (body.length < 6 || Math.max(...body.map(bottom)) - Math.min(...body.map(t => t.y)) < height * .25) return masks;
  const lineHeight = quantile(body.map(t => t.height), .5);
  const padding = Math.max(6, lineHeight * .35);
  // A few OCR rows accidentally join a note to the body. The middle of the
  // repeated edges resists those outliers; wider real rows are protected below.
  const left = quantile(body.map(t => t.x), .5) - padding;
  const right = quantile(body.map(end), .5) + padding;
  if (right - left < width * .48) return masks;
  // Only erase beside the column that established these edges. A wide abstract
  // can sit above two body columns; a short final line in the left body column
  // must not become a "margin note" just because it lies left of the abstract.
  const besideBody = new Uint8Array(height);
  for (const line of body) {
    if (Math.abs(line.x - (left + padding)) > lineHeight * 2
      || Math.abs(end(line) - (right - padding)) > width * .1) continue;
    besideBody.fill(1, Math.max(0, Math.floor(line.y - lineHeight * 2)),
      Math.min(height, Math.ceil(bottom(line) + lineHeight * 2)));
  }
  // Real graphics protect their labels. A page-sized scanned image is the
  // paper itself, so it must not prevent removal of the notes printed on it.
  const figures = images.filter(b => b.width * b.height < width * height * .85);
  const overlaps = (a, b) => a.x < end(b) + padding && end(a) > b.x - padding
    && a.y < bottom(b) + padding && bottom(a) > b.y - padding;
  const sides = ['left', 'right'].map(side => {
    // Compare with the actual body edge. A close note may begin inside the
    // extra crop padding without belonging to the body column.
    const outside = t => side === 'left' ? end(t) <= left + padding : t.x >= right - padding;
    const notes = horizontal.filter(t => outside(t) && t.width < width * .2
      && !figures.some(figure => overlaps(t, figure))
      && body.some(line => Math.abs(line.y - t.y) < lineHeight * 1.5));
    // Multiple lines distinguish marginalia from an isolated label/marker.
    let removeNotes = notes.length >= 2
      && Math.max(...notes.map(t => t.y)) - Math.min(...notes.map(t => t.y)) >= lineHeight * .7;
    // Magazine introductions can use larger type than the next body column.
    // Substantial parallel prose remains body text regardless of that font size.
    const column = lines.filter(t => outside(t) && t.width >= width * .22);
    if (column.length >= 6 && Math.max(...column.map(bottom))-Math.min(...column.map(t=>t.y)) >= height*.2) removeNotes = false;
    // A parallel column of comparable type running the length of the body is
    // substantive text, even if the columns have very different widths.
    if (Math.max(...notes.map(bottom)) - Math.min(...notes.map(t => t.y))
      > (Math.max(...body.map(bottom)) - Math.min(...body.map(t => t.y))) * .75
      && quantile(notes.map(t => t.height), .5) >= lineHeight * .9) removeNotes = false;
    const pageNumbers = horizontal.filter(t => outside(t) && /^\s*\d{1,4}\s*$/.test(t.text)
      && (t.y < Math.min(...body.map(t => t.y)) + lineHeight || t.y > Math.max(...body.map(bottom)) - lineHeight)
      && !body.some(line => Math.abs(line.y - t.y) < lineHeight * .5)
      && !figures.some(figure => overlaps(t, figure)));
    return { side, removeNotes, pageNumbers, notes };
  });
  if (!sides.some(side => side.removeNotes || side.pageNumbers.length)) return masks;
  for (const { side, removeNotes, pageNumbers, notes } of sides) {
    const edge = side === 'left' ? left : right;
    const discarded = [...pageNumbers, ...(removeNotes ? notes : [])];
    const clearEdge = side === 'left' ? Math.max(edge, ...discarded.map(t => end(t) + padding))
      : Math.min(edge, ...discarded.map(t => t.x - padding));
    const lane = { x: side === 'left' ? 0 : clearEdge, width: side === 'left' ? clearEdge : width - clearEdge };
    if (lane.width <= 0) continue;
    // Clear the lane, including scan specks and ornaments missed by OCR, but
    // reserve any bands containing a wider section or a figure reaching it.
    // On the opposite side, clear scan debris but reserve ALL detected text:
    // there is no evidence that text in that margin is disposable.
    const active = besideBody.slice();
    for (const box of discarded) active.fill(1,
      Math.max(0, Math.floor(box.y - padding)), Math.min(height, Math.ceil(bottom(box) + padding)));
    const limits = Float64Array.from(active, value => value ? edge : side === 'left' ? 0 : width);
    for (const box of discarded) {
      for (let y = Math.max(0, Math.floor(box.y - padding)); y < Math.min(height, Math.ceil(bottom(box) + padding)); y++) {
        limits[y] = side === 'left' ? Math.max(limits[y], Math.min(width, Math.ceil(end(box) + padding)))
          : Math.min(limits[y], Math.max(0, Math.floor(box.x - padding)));
      }
    }
    for (const box of [...figures, ...text.filter(t => !discarded.includes(t) && (!removeNotes || (t.x < clearEdge && end(t) > clearEdge)))]) {
      if (box.x >= lane.x + lane.width || end(box) <= lane.x) continue;
      const nearby = discarded.filter(t => t.y < bottom(box) + padding * 2 && bottom(t) > box.y - padding * 2);
      // Extra protection must not extend into a known neighboring note, but
      // the actual body/figure box always wins if the OCR bounds overlap.
      const limit = side === 'left' ? Math.min(box.x, Math.max(box.x - padding, ...nearby.map(end)))
        : Math.max(end(box), Math.min(end(box) + padding, ...nearby.map(t => t.x)));
      // A body/OCR box extending a pixel into the margin protects only that
      // box, not the entire outside lane and unrelated notes farther out.
      for (let y = Math.max(0, Math.floor(box.y - padding)); y < Math.min(height, Math.ceil(bottom(box) + padding)); y++) {
        limits[y] = side === 'left' ? Math.min(limits[y], Math.max(0, Math.floor(limit)))
          : Math.max(limits[y], Math.min(width, Math.ceil(limit)));
      }
    }
    for (let start = 0; start < height;) {
      let finish = start + 1; while (finish < height && limits[finish] === limits[start]) finish++;
      const x = side === 'left' ? 0 : limits[start]; const span = side === 'left' ? limits[start] : width - x;
      if (span > 0) masks.push({ x, y: start, width: span, height: finish - start });
      start = finish;
    }
  }
  return masks;
}

export function insidePdfMargin(box, masks) {
  return masks.some(mask => box.x + box.width / 2 >= mask.x && box.x + box.width / 2 <= end(mask)
    && box.y + box.height / 2 >= mask.y && box.y + box.height / 2 <= bottom(mask));
}
