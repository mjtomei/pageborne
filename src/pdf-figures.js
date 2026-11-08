// A decorative frame can surround columns; several disconnected panels can
// form one figure. Use text and pixels to distinguish these two cases.
import { pdfTextRows, pdfTextRuns, reflowPdfBlock } from './pdf-reflow.js';
import { pdfCaptionReference } from './pdf-captions.js';

// Scanned axes/grids have no PDF drawing operators. Find connected ink larger
// than a glyph, then include nearby labels up to the next prose/caption band.
export function scannedPdfFigures({ width, height, data, text, pageMasks = [] }) {
  const ink = new Uint8Array(width * height); const stack = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    const masks = pageMasks.filter(mask => y >= mask.y && y < mask.y + mask.height);
    for (let x = 0; x < width; x++) {
      const at = y * width + x; const p = at * 4;
      ink[at] = data[p+3] > 20 && data[p]*.2126+data[p+1]*.7152+data[p+2]*.0722 < 190
        && !masks.some(mask => x >= mask.x && x < mask.x + mask.width) ? 1 : 0;
    }
  }
  const components = [];
  for (let at = 0; at < ink.length; at++) {
    if (ink[at] !== 1) continue;
    let size = 1; stack[0] = at; ink[at] = 2;
    let left = width; let right = 0; let top = height; let low = 0; let count = 0;
    while (size) {
      const p = stack[--size]; const x = p % width; const y = Math.floor(p / width);
      left = Math.min(left, x); right = Math.max(right, x+1); top = Math.min(top, y); low = Math.max(low, y+1); count++;
      for (let yy = Math.max(0,y-1); yy <= Math.min(height-1,y+1); yy++) for (let xx = Math.max(0,x-1); xx <= Math.min(width-1,x+1); xx++) {
        const next = yy*width+xx;
        if (ink[next] === 1) { ink[next] = 2; stack[size++] = next; }
      }
    }
    if (count >= 6) components.push({ x: left, y: top, width: right-left, height: low-top, count });
  }
  const rows = pdfTextRows(text);
  const sizes = text.filter(t => t.height >= 6 && t.height <= 35).map(t => t.height).sort((a,b)=>a-b);
  const size = sizes[Math.floor(sizes.length/2)] || 16;
  const union = boxes => { const x = Math.min(...boxes.map(b=>b.x)); const y = Math.min(...boxes.map(b=>b.y));
    return { x,y,width:Math.max(...boxes.map(b=>b.x+b.width))-x,height:Math.max(...boxes.map(b=>b.y+b.height))-y }; };
  const seeds = components.filter(b => b.width > width*.12 && b.height > size*4 && b.width*b.height < width*height*.8);
  // Open tables often have horizontal rules without connecting verticals.
  const rules = components.filter(b => b.width > width*.3 && b.height <= size*.5);
  const groups = [];
  for (const rule of rules) {
    let group = groups.find(g => Math.abs(g[0].x-rule.x) < size*2 && Math.abs(g[0].width-rule.width) < size*3);
    if (!group) { group=[]; groups.push(group); } group.push(rule);
  }
  for (const group of groups) if (group.length >= 3) {
    const box=union(group); if (box.height > size*4 && box.height < height*.85) seeds.push(box);
  }
  const prose = rows.filter(row => row.text.length >= 55 || /^(?:fig(?:ure|ue)?\.?|table)\s*\d/i.test(row.text))
    .map(row => ({ ...union(row.items), text: row.text }));
  return seeds.map(seed => {
    const overlaps = row => row.x < seed.x+seed.width && row.x+row.width > seed.x;
    const before = prose.filter(row=>overlaps(row) && row.y+row.height <= seed.y).sort((a,b)=>b.y+b.height-a.y-a.height)[0];
    const after = prose.filter(row=>overlaps(row) && row.y >= seed.y+seed.height).sort((a,b)=>a.y-b.y)[0];
    const top = Math.max(0,seed.y-size*3,before ? before.y+before.height+2 : 0);
    const low = Math.min(height,seed.y+seed.height+size*3,after ? after.y-2 : height);
    const neighbors=components.filter(b=>b.x >= seed.x-size*3 && b.x+b.width <= seed.x+seed.width+size*3
      && b.y >= top && b.y+b.height <= low);
    return { ...union([seed,...neighbors]), kind:'scan-figure' };
  }).filter(box => {
    // Hand-underlines and margin brackets can connect into a frame or mimic
    // table rules. Reliable prose explaining the actual ink is still text.
    // Sparse diagram labels, mathematical displays and column gutters fail
    // the same coverage/table checks used for normal reflow.
    const lines = text.filter(line => line.x + line.width / 2 >= box.x && line.x + line.width / 2 < box.x + box.width
      && line.y + line.height / 2 >= box.y && line.y + line.height / 2 < box.y + box.height);
    if (lines.length < 3 || lines.reduce((sum, line) => sum + line.text.length, 0) < 150) return true;
    return !reflowPdfBlock({ ...box, kind: 'text', lines }, { pixels: data, pageWidth: width, allowSparseUncertainty: true });
  });
}

export function pdfFigures({ width, height, data, text, images, pageMasks }) {
  if (images.some(box => box.width * box.height >= width * height * .85)) {
    images = [...images, ...scannedPdfFigures({ width, height, data, text, pageMasks })];
  }
  const ink = (x, y) => {
    const p = (y * width + x) * 4;
    return data[p + 3] > 20 && data[p] * .2126 + data[p + 1] * .7152 + data[p + 2] * .0722 < 235;
  };
  const runs = pdfTextRuns(text);
  const prose = runs.filter(t => t.width > width * .2 && t.text.trim().length >= 30);
  const framedText = box => {
    if (box.kind !== 'drawing' || box.width * box.height < width * height * .1) return false;
    const lines = prose.filter(t => t.x >= box.x - 4 && t.x + t.width <= box.x + box.width + 4
      && t.y >= box.y - 4 && t.y + t.height <= box.y + box.height + 4);
    if (lines.length < 4 || lines.reduce((sum, t) => sum + t.width, 0) < box.width * 2.5) return false;
    const mask = new Uint8Array(width * height);
    for (const t of text) for (let y = Math.max(0, Math.floor(t.y - 4)); y < Math.min(height, Math.ceil(t.y + t.height + 4)); y++) {
      mask.fill(1, y * width + Math.max(0, Math.floor(t.x - 4)), y * width + Math.min(width, Math.ceil(t.x + t.width + 4)));
    }
    let remaining = 0; const tolerance = Math.max(32, box.width * box.height * .001);
    for (let y = Math.max(0, Math.ceil(box.y + 4)); y < Math.min(height, box.y + box.height - 4); y++) {
      for (let x = Math.max(0, Math.ceil(box.x + 4)); x < Math.min(width, box.x + box.width - 4); x++) {
        if (!mask[y * width + x] && ink(x, y) && ++remaining > tolerance) return false;
      }
    }
    return true;
  };
  images = images.filter(box => !framedText(box));
  images = images.map(box => {
    // Small ornaments sometimes carry loose Bézier control-point bounds that
    // extend into the next column. Only visible non-text ink bounds the drawing.
    if (box.kind !== 'drawing' || box.width > width*.3 || box.height > height*.08) return box;
    const labels = text.filter(t => t.x < box.x+box.width && t.x+t.width > box.x
      && t.y < box.y+box.height && t.y+t.height > box.y);
    let left=Infinity, top=Infinity, right=0, bottom=0;
    for (let y=Math.max(0,Math.floor(box.y));y<Math.min(height,Math.ceil(box.y+box.height));y++) {
      const rows=labels.filter(t=>y>=t.y-2 && y<t.y+t.height+2);
      for (let x=Math.max(0,Math.floor(box.x));x<Math.min(width,Math.ceil(box.x+box.width));x++) {
        if (!ink(x,y) || rows.some(t=>x>=t.x-2 && x<t.x+t.width+2)) continue;
        left=Math.min(left,x);right=Math.max(right,x+1);top=Math.min(top,y);bottom=Math.max(bottom,y+1);
      }
    }
    if (!Number.isFinite(left)) return box;
    return {...box,x:left,y:top,width:right-left,height:bottom-top};
  });
  // PDF operators often describe the plot itself but omit its text labels.
  // Extend through nearby short label rows, stopping before any prose/caption.
  const labelRows = pdfTextRows(text).map(row => ({ ...row,
    x: Math.min(...row.items.map(t=>t.x)), width: Math.max(...row.items.map(t=>t.x+t.width))-Math.min(...row.items.map(t=>t.x)),
    height: Math.max(...row.items.map(t=>t.height)) }));
  images = images.map(box => {
    if (box.height < 50 || box.width < 80 || box.width*box.height >= width*height*.85) return box;
    let low = box.y+box.height;
    for (const row of labelRows.filter(row=>row.y >= low-2 && row.y < low+40).sort((a,b)=>a.y-b.y)) {
      if (row.x+row.width < box.x || row.x > box.x+box.width) continue;
      if (row.text.length > 60 || /^(?:fig(?:ure|ue)?\.?|table)\s*\d/i.test(row.text)) break;
      if (row.x < box.x-20 || row.x+row.width > box.x+box.width+20) break;
      low = Math.max(low,row.y+row.height+2);
    }
    return { ...box,height:low-box.y };
  });
  const panels = images.filter(box => box.width > 24 && box.height > 24 && box.width * box.height < width * height * .85);
  const groups = [];
  for (const box of panels.sort((a, b) => a.y - b.y)) {
    const last = groups.at(-1); const end = last && last.y + last.height;
    const within = (t,b) => t.x >= b.x-2 && t.x+t.width <= b.x+b.width+2 && t.y >= b.y-2 && t.y+t.height <= b.y+b.height+2;
    const union = last && { x:Math.min(last.x,box.x),y:Math.min(last.y,box.y),width:Math.max(last.x+last.width,box.x+box.width)-Math.min(last.x,box.x),height:Math.max(end,box.y+box.height)-Math.min(last.y,box.y) };
    const barrier = last && (runs.some(t => (prose.includes(t) || pdfCaptionReference(t.text)) && t.y >= end - 2 && t.y + t.height <= box.y + 2)
      || runs.some(t => pdfCaptionReference(t.text) && within(t,box) && t.y < box.y+35)
      || prose.some(t => within(t,union) && !within(t,box) && !last.parts.some(b=>within(t,b))));
    if (last && box.y <= end + height * .06 && !barrier) {
      const x = Math.min(last.x, box.x); const right = Math.max(last.x + last.width, box.x + box.width);
      last.height = Math.max(end, box.y + box.height) - last.y; last.x = x; last.width = right - x;
      last.parts.push(box);
    } else groups.push({ ...box, parts: [box] });
  }
  for (const group of groups) {
    // A shared caption also identifies panels belonging to one figure. Without
    // that evidence or a center-spanning panel, keep independent column figures.
    const end = group.y + group.height;
    const captionStart = t => !!pdfCaptionReference(t.text);
    const sharedCaption = text.some(t => captionStart(t)
      && t.y >= end - 4 && t.y < end + height * .08
      && (() => {
        // Only this caption's contiguous line counts. Unrelated prose in
        // the other column must not make a narrow caption look full-width.
        const line = text.filter(b => b.x >= t.x - 1 && Math.abs(b.y - t.y) < Math.max(4, t.height * .4)).sort((a,b) => a.x-b.x);
        let right = t.x + t.width;
        for (const b of line) {
          if (b === t) continue;
          if (b.x > right + t.height * 1.2 || captionStart(b)) break;
          right = Math.max(right, b.x + b.width);
        }
        return t.x < group.x + group.width * .25 && right > group.x + group.width * .75;
      })());
    if (group.parts.length < 2 || (!sharedCaption && !group.parts.some(b => b.x < width / 2 - 8 && b.x + b.width > width / 2 + 8))) continue;
    images = images.filter(box => !group.parts.includes(box));
    const { parts, ...box } = group; images.push(box);
  }
  return images;
}
