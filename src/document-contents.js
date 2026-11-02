import { pdfTextRows } from './pdf-reflow.js';
import { pdfAnalysisViewport, pdfSourcePoint } from './pdf-orientation.js';
import { pdfNavigationCandidates, pdfNavigationSections, PDF_NAVIGATION_VERSION } from './pdf-navigation.js';

const clean = text => String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
const key = text => clean(text).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const cache = new WeakMap();

// Navigation is cheap metadata, read even when the expensive OCR/layout comes
// from an older phone or desktop cache. Never invalidate those preparations.
export async function readPdfNavigation(pdf) {
  const outline = [], pages = new Map();
  let visited = 0;
  let labels = null;
  try { labels = await pdf.getPageLabels(); } catch { /* Optional PDF metadata. */ }
  let tree;
  try { tree = await pdf.getOutline(); } catch { return { outline, labels }; }
  const visit = async (items, level = 1) => {
    for (const item of items || []) {
      if (++visited > 4096 || level > 16) break;
      try {
        const dest = typeof item.dest === 'string' ? await pdf.getDestination(item.dest) : item.dest;
        const index = Array.isArray(dest) ? typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]) : -1;
        const title = clean(item.title);
        if (title && Number.isInteger(index) && index >= 0 && index < pdf.numPages) {
          const entry = { title, level, page: index + 1 };
          const type = dest[1]?.name;
          const top = type === 'XYZ' ? dest[3] : ['FitH', 'FitBH'].includes(type) ? dest[2] : null;
          if (Number.isFinite(top)) {
            if (!pages.has(index)) pages.set(index, pdf.getPage(index + 1));
            const viewport = pdfAnalysisViewport(await pages.get(index));
            const [x, y] = viewport.convertToViewportPoint(Number.isFinite(dest[2]) && type === 'XYZ' ? dest[2] : 0, top);
            entry.point = { x, y };
          }
          outline.push(entry);
        }
      } catch { /* A broken/external bookmark must not hide its valid children. */ }
      await visit(item.items, level + 1);
    }
  };
  await visit(tree);
  return { outline, labels };
}

function pdfTarget(layout, entry) {
  const ready = layout.preparation?.readyPages ?? layout.headings.length;
  if (entry.page > ready) return null;
  const blocks = layout.blocks.filter(b => b.page === entry.page && !b.annotation && !b.annotationLabel);
  if (!blocks.length) {
    const next = layout.blocks.find(b => b.page > entry.page && !b.annotation);
    return next ? next.y : null;
  }
  if (!entry.point) return blocks[0].y;
  // PDF destinations often have left=0, outside the text crop. Use the vertical
  // destination rather than letting that margin discard an otherwise valid row.
  const rows = blocks.flatMap(block => {
    const point = pdfSourcePoint(block, entry.point, true);
    return block.reflow?.rows.length ? block.reflow.rows.map(row => ({ y: block.y + row.y, distance: row.sourceY - point.y }))
      : [{ y: block.y, distance: block.sourceY - point.y }];
  });
  return (rows.find(row => row.distance >= -4) || rows.at(-1)).y;
}

function derivedPdfContents(layout) {
  const body = layout.blocks.filter(b => !b.annotation && !b.annotationLabel && !b.contents && b.kind !== 'figure');
  const rows = body.flatMap(block => pdfTextRows(block.lines || []).map(row => ({ ...row, block })));
  // Resolve a printed contents list by actual page labels, or by finding its
  // heading in the body. Printed page 1 is usually NOT PDF page 1.
  const printed = layout.blocks.flatMap(block => (block.contents || []).flatMap(entry => {
    const match = entry.text.match(/^(.*?)\s+— page\s+(\d+|[ivxlcdm]+)$/i);
    if (!match) return [];
    const title = clean(match[1]), label = match[2];
    const found = rows.find(row => row.block.page > block.page && key(row.text) === key(title));
    if (found) return [{ title, level: 1, page: found.block.page, point: pdfSourcePoint(found.block, { x: found.items[0].x, y: found.y }) }];
    const index = layout.navigation?.labels?.indexOf(label) ?? -1;
    return index >= 0 ? [{ title, level: 1, page: index + 1 }] : [];
  }));
  // Current metadata was checked against raw page recognition, including pages
  // retained as images. A partial reflowed contents list must not replace it.
  if (layout.navigation?.version === PDF_NAVIGATION_VERSION && layout.navigation.sections?.some(e => ['chapter', 'part'].includes(e.role)))
    return layout.navigation.sections;
  if (printed.length >= 2) return printed;

  let sections = layout.navigation?.sections;
  if (!sections?.length) {
    const pages = new Map();
    for (const block of body) {
      if (!pages.has(block.page)) pages.set(block.page, []);
      pages.get(block.page).push(block);
    }
    sections = pdfNavigationSections([...pages].flatMap(([number, blocks]) => {
      const text = blocks.flatMap(b => b.lines || []);
      const entries = pdfNavigationCandidates({ text, width: 900, height: Math.max(1000, ...text.map(t => t.y + t.height + 50)) }, number);
      return entries.map(entry => ({ ...entry, point: pdfSourcePoint(blocks[0], entry.point) }));
    }));
  }
  if (sections.some(e => ['chapter', 'part'].includes(e.role))) return sections;

  // Conservative typography fallback: short, isolated lines larger than the
  // body font, or explicit chapter/section labels. Ignore recurring furniture.
  const weights = new Map();
  for (const row of rows) for (const item of row.items) {
    const size = Math.round(item.height * 2) / 2;
    weights.set(size, (weights.get(size) || 0) + (item.text?.length || 0));
  }
  const normal = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const occurrences = new Map();
  for (const row of rows) {
    const k = key(row.text);
    if (!occurrences.has(k)) occurrences.set(k, new Set());
    occurrences.get(k).add(row.block.page);
  }
  return rows.flatMap((row, index) => {
    const title = clean(row.text), height = Math.max(...row.items.map(item => item.height));
    if (title.length < 3 || title.length > 160 || title.split(' ').length > 22 || !/\p{L}/u.test(title)
      || /[.!?;,:]$/.test(title) || /[=∑∫√]/.test(title) || occurrences.get(key(title)).size > 2) return [];
    const explicit = /^(?:chapter|part|book|section)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five)\b/i.test(title);
    const next = rows[index + 1];
    const isolated = !next || next.block !== row.block || next.y - row.y > height * 1.5;
    // Explicit words alone are not evidence: body paragraphs also begin with
    // "Chapter 2 describes...". Same-size structural headings come from the
    // geometry detector above; this fallback requires larger typography.
    if (!(normal > 0 && height >= normal * 1.22 && isolated && /^[\d.\s]*\p{Lu}/u.test(title))) return [];
    return [{ title, level: height >= normal * 1.65 || explicit ? 1 : 2, page: row.block.page,
      point: pdfSourcePoint(row.block, { x: row.items[0].x, y: row.y }) }];
  }).concat(sections);
}

export function documentContents(layout) {
  if (!layout) return [];
  if (cache.has(layout)) return cache.get(layout);
  const pdf = layout.format === 'pdf';
  const source = pdf ? layout.navigation?.outline?.length ? layout.navigation.outline : derivedPdfContents(layout)
    : (layout.headings || []).map(h => ({ title: h.text, level: h.level, y: layout.blockY[h.index] }));
  const seen = new Set();
  const entries = source.flatMap(entry => {
    const title = clean(entry.title), target = pdf ? pdfTarget(layout, entry) : entry.y;
    if (!title || !Number.isFinite(target)) return [];
    const y = Math.max(0, Math.min(layout.maxY, target));
    const identity = `${title}:${y}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ title, level: Math.min(6, Math.max(1, entry.level || 1)), y, ...(pdf ? { page: entry.page } : {}) }];
  }).sort((a, b) => a.y - b.y);
  // A document title alone offers no navigation. Keep percentage selection.
  const usable = entries.length > 1 || entries[0]?.y > 0 ? entries : [];
  cache.set(layout, usable);
  return usable;
}
