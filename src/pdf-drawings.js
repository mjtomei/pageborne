// PDF.js records bounds for clipping paths and pale paper fills too. Neither
// should become a "figure" that prevents the text beneath it forming columns.
export function paintedPdfPaths(operatorList, boxes, OPS, width, height, transform = [1, 0, 0, 1, 0, 0], background = null) {
  const paths = []; const stack = [];
  let state = { fill: '#000000', stroke: '#000000', fillAlpha: 1, strokeAlpha: 1, lineWidth: 1, transform };
  const applyTransform = b => {
    const a = state.transform;
    state.transform = [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  };
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.rawFillPath]);
  const strokes = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const visible = (color, alpha) => {
    if (color === 'transparent' || alpha <= 0) return false;
    if (!/^#[0-9a-f]{6}$/i.test(color || '')) return true; // Unknown patterns may contain ink.
    const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16));
    if (background) return Math.max(...rgb.map((value, c) => Math.abs(value - background[c]))) * alpha > 12;
    const luminance = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    return 255 - (255 - luminance) * alpha < 235;
  };
  for (let i = 0; boxes && i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i]; const args = operatorList.argsArray[i] || [];
    if ([OPS.save, OPS.paintFormXObjectBegin, OPS.beginGroup].includes(op)) {
      stack.push({ ...state });
      const matrix = op === OPS.paintFormXObjectBegin ? args[0] : op === OPS.beginGroup ? args[0]?.matrix : null;
      if (matrix) applyTransform(matrix);
    }
    else if ([OPS.restore, OPS.paintFormXObjectEnd, OPS.endGroup].includes(op)) state = stack.pop() || state;
    else if (op === OPS.transform) applyTransform(args);
    else if (op === OPS.setLineWidth) state.lineWidth = args[0];
    else if (op === OPS.setFillRGBColor) state.fill = args[0];
    else if (op === OPS.setStrokeRGBColor) state.stroke = args[0];
    else if (op === OPS.setFillColorN) state.fill = null;
    else if (op === OPS.setStrokeColorN) state.stroke = null;
    else if (op === OPS.setFillTransparent) state.fill = 'transparent';
    else if (op === OPS.setStrokeTransparent) state.stroke = 'transparent';
    else if (op === OPS.setGState) for (const [key, value] of args[0]) {
      if (key === 'ca') state.fillAlpha = value;
      if (key === 'CA') state.strokeAlpha = value;
      if (key === 'LW') state.lineWidth = value;
    }
    // In PDF.js 6, constructPath carries its final paint operation as args[0].
    // endPath only establishes a clip and paints nothing.
    const paint = op === OPS.constructPath ? args[0] : op;
    if (!(fills.has(paint) && visible(state.fill, state.fillAlpha))
      && !(strokes.has(paint) && visible(state.stroke, state.strokeAlpha))) continue;
    const minMax = op === OPS.constructPath ? args[2] : null;
    if (minMax?.length === 4) {
      // Recorded dependency bounds can union many uses of a reused path into
      // a page-sized box. Its actual path bounds and current transform locate
      // this occurrence precisely (including rotated/scaled PDF pages).
      const pad = strokes.has(paint) ? state.lineWidth / 2 : 0;
      const m = state.transform; const points = [];
      for (const x of [minMax[0] - pad, minMax[2] + pad]) for (const y of [minMax[1] - pad, minMax[3] + pad]) {
        points.push([m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      }
      const x = Math.max(0, Math.min(...points.map(p => p[0]))); const y = Math.max(0, Math.min(...points.map(p => p[1])));
      paths.push({ x, y, width: Math.min(width, Math.max(...points.map(p => p[0]))) - x,
        height: Math.min(height, Math.max(...points.map(p => p[1]))) - y });
    } else if (!boxes.isEmpty(i)) paths.push({ x: boxes.minX(i) * width, y: boxes.minY(i) * height,
      width: (boxes.maxX(i) - boxes.minX(i)) * width, height: (boxes.maxY(i) - boxes.minY(i)) * height });
  }
  return paths.filter(box => box.width > 0 && box.height > 0
    // Publisher rules along page edges or gutters can connect every panel
    // and paragraph into one enormous drawing. They remain in the raster.
    && !(box.width < 2 && box.height > height * .7)
    && !(box.height < 2 && box.width > width * .75 && (box.y < height * .08 || box.y > height * .92)));
}

// Three or more aligned horizontal rules usually bound a table or plot. Keep
// the values with their headers instead of interpreting its central whitespace
// as the gutter between prose columns. Ordinary prose separates nearby tables.
export function ruledPdfTables(paths, text, width, height) {
  const groups = [];
  for (const rule of paths.filter(b => b.height <= 3 && b.width >= width * .15).sort((a, b) => a.y - b.y)) {
    const group = groups.findLast(g => Math.abs(g.x - rule.x) <= 4 && Math.abs(g.width - rule.width) <= 8
      && rule.y - g.last <= height * .8 && rule.y - g.y <= height * .8
      && !text.some(t => t.y > g.last + 4 && t.y + t.height < rule.y - 4
        && t.x < g.x + g.width && t.x + t.width > g.x
        && (t.width > g.width * .65 && t.text.length > 35 || /^Table\s+\d+[.:\s]/i.test(t.text.trim()))));
    if (group) { if (rule.y > group.last + 4) group.count++; group.last = rule.y; group.height = rule.y + rule.height - group.y; }
    else groups.push({ ...rule, last: rule.y, count: 1 });
  }
  return groups.filter(g => g.count >= 3 && g.height >= 30).map(({ last, count, ...box }) => ({ ...box, kind: 'table' }));
}
