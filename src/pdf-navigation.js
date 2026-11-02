import { pdfTextRows } from './pdf-reflow.js';
import { pdfContentsEntries } from './pdf-contents.js';

export const PDF_NAVIGATION_VERSION = 2;

const marker = /^(chapter|part|book|section)\s+([ivxlcdm\d]+|one|two|three|four|five|six|seven|eight|nine|ten)\b[.\s:;—-]*(.*)$/i;
const compact = text => String(text || '').replace(/\s+/g, ' ').trim();
const capitals = text => {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toUpperCase();
};

// Work with OCR/native word geometry before reflow strips running furniture or
// keeps an uncertain page as an image. No additional recognizer or model load.
export function pdfNavigationCandidates({ text, width, height }, page) {
  const rows = pdfTextRows(text || []).map(row => ({ ...row,
    left: Math.min(...row.items.map(i => i.x)), right: Math.max(...row.items.map(i => i.x + i.width)),
    height: Math.max(...row.items.map(i => i.height)), text: compact(row.text) }));
  // OCR often stores a whole contents row in one box. Its word boxes retain
  // the large gap before the folio, even when the row string has one space.
  const contents = pdfContentsEntries((text || []).flatMap(line => line.words?.length ? line.words : [line]), width);
  if (contents.length) return contents.map(row => ({ title: row.title, reference: row.reference,
    role: 'contents', page, point: { x: row.items[0].x, y: row.y } }));
  if (rows.some(row => row.y < height * .4 && /^(?:table of )?contents\b/i.test(row.text))) return [];
  const body = rows.filter(r => r.text.length > 65);
  const bounds = body.length ? body : rows.filter(r => r.text.length > 5);
  const left = bounds.length ? Math.min(...bounds.map(r => r.left)) : width * .1;
  const right = bounds.length ? Math.max(...bounds.map(r => r.right)) : width * .9;
  const center = (left + right) / 2;
  const centered = row => Math.abs((row.left + row.right) / 2 - center) < width * .09;
  const spaced = i => (!rows[i - 1] || rows[i].y - rows[i - 1].y > rows[i].height * 1.7)
    && (!rows[i + 1] || rows[i + 1].y - rows[i].y > rows[i].height * 1.7);
  const separated = (i, end = i) => (!rows[i - 1] || rows[i].y - rows[i - 1].y > rows[i].height * 1.65)
    && (!rows[end + 1] || rows[end + 1].y - rows[end].y > rows[end].height * 1.65);
  const headingText = value => value.length <= 140 && value.split(' ').length <= 16
    && !/[.!?;,]$/.test(value) && !/[;,()]/.test(value);
  const found = []; let consumed = -1;
  for (let i = 0; i < rows.length; i++) {
    if (i <= consumed) continue;
    const row = rows[i];
    if (row.y < height * .07 || row.y > height * .9 || row.text.length > 180) continue;
    let title = row.text.replace(/^[|¦]\s*(?=chapter\b)/i, ''), end = i;
    if (/^(chapter|part|book|section)$/i.test(title) && rows[i + 1] && rows[i + 1].y - row.y < row.height * 3)
      title += ' ' + rows[++end].text;
    const match = title.match(marker);
    if (match && centered(row) && headingText(match[3]) && !/^\p{Ll}/u.test(match[3]) && separated(i, end)) {
      // Chapter numbers and their (often smaller, all-capital) titles occupy
      // different rows in old books. Keep them together as one destination.
      while (end + 1 < rows.length && end < i + 3 && capitals(rows[end + 1].text)
        && centered(rows[end + 1]) && rows[end + 1].y - rows[end].y < row.height * 4
        && !marker.test(rows[end + 1].text)) title += (end === i ? ' — ' : ' ') + rows[++end].text;
      const role = /^(part|book)$/i.test(match[1]) ? 'part' : match[1].toLowerCase() === 'chapter' ? 'chapter' : 'heading';
      found.push({ title, role, page, point: { x: row.left, y: row.y } }); consumed = end; continue;
    }
    // Numbered titles may be left aligned and the same size as the prose.
    // Whitespace on BOTH sides matters: a body reference isn't a heading.
    const numbered = title.match(/^(\d{1,3}(?:\.\d{1,3})*)(\.?)[ \t]+(["“‘']*\p{Lu}.*)$/u);
    if (numbered && headingText(numbered[3]) && separated(i)
      && row.right - row.left < (right - left) * .94) {
      const path = numbered[1].split('.').map(Number);
      found.push({ title: title.replace(/[*†‡]+$/, ''), role: path.length > 1 || numbered[2] ? 'numbered' : 'number-uncertain',
        number: path, opener: row.y < height * .35, page, point: { x: row.left, y: row.y } }); continue;
    }
    const frontMatter = frontMatterTitle.test(row.text);
    if (frontMatter && (separated(i) || !rows[i - 1] && (!rows[i + 1] || rows[i + 1].y - row.y > row.height * 1.3)) && row.right - row.left < width * .7) {
      found.push({ title: row.text, role: 'heading', page, point: { x: row.left, y: row.y } }); continue;
    }
    if (/^(?:[IVXLC]{1,7}|[1-9]\d?)\.?$/.test(row.text) && centered(row) && row.right - row.left < width * .12
      && rows[i + 1]?.text.length > 30 && rows[i + 1].y - row.y > row.height * 1.15
      && (!rows[i - 1] || row.y - rows[i - 1].y > row.height * 1.5)) {
      found.push({ title: `Section ${row.text.replace(/\.$/, '')}`, role: 'section', page, point: { x: row.left, y: row.y } }); continue;
    }
    // Capitals alone are insufficient: a sentence or a running title must not
    // become a section. Require a short centered line and surrounding space.
    if (capitals(row.text) && centered(row) && (spaced(i) || frontMatter && (!rows[i + 1] || rows[i + 1].y - row.y > row.height * 1.3)) && row.text.split(' ').length <= 12
      && !/[.!?;,]$/.test(row.text) && !/^\d+\s|\s\d+$/.test(row.text)) {
      found.push({ title: row.text, role: 'heading', page, point: { x: row.left, y: row.y } });
    }
  }
  // Old part dividers often repeat the upcoming chapters as a local contents
  // list. Navigate to the actual chapter openings on subsequent prose pages.
  if (found.some(entry => entry.role === 'part') && !rows.some(row => row.text.length > 80
    && (row.text.match(/[a-z]/g) || []).length > (row.text.match(/[A-Z]/g) || []).length * 2))
    return found.filter(entry => entry.role === 'part');
  return found;
}

const frontMatterTitle = /^(?:abstract|summary|list of (?:figures|tables|figures and tables)|preface|prefatory note|foreword|acknowledg[e]?ments|introduction|appendix|appendices|bibliography|references|index|notes)$/i;
const titleKey = text => compact(text).toLowerCase().replace(marker, (whole, type, number, title) => title || whole)
  .replace(/^(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.:]?\s+/, '').replace(/(?:[.·…_]\s*){3,}.*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const similarTitle = (a, b) => {
  a = titleKey(a); b = titleKey(b);
  if (!a || !b) return false;
  if (a === b) return true;
  // A small article/punctuation difference is common between printed contents
  // and openers ("Case and Methods" vs "The Case and Methods"). No substring
  // matches against prose or arbitrary inferred printed-page offsets.
  const words = s => s.split(' ').filter(w => !['the', 'a', 'an'].includes(w));
  return words(a).join(' ') === words(b).join(' ');
};

export function pdfNavigationSections(candidates, { pages = Math.max(0, ...candidates.map(e => e.page)) } = {}) {
  const printed = candidates.filter(e => e.role === 'contents' && /^[\p{L}\p{N}§["“‘']/u.test(e.title) && titleKey(e.title).length >= 3);
  const ordered = candidates.filter(e => e.role !== 'contents').map(entry => ({ ...entry }))
    .sort((a,b) => a.page - b.page || (a.point?.y || 0) - (b.point?.y || 0));
  const counts = new Map();
  for (const entry of ordered) if (entry.role === 'heading') {
    const k = titleKey(entry.title); counts.set(k, (counts.get(k) || 0) + 1);
  }
  const hasParts = ordered.some(e => e.role === 'part');
  const topNumbers = ordered.filter(e => e.role === 'numbered' && e.number.length === 1 && e.opener);
  const chapterNumbers = new Set(topNumbers.filter(e => printed.some(p => p.page < e.page && similarTitle(p.title, e.title))
    || topNumbers.some(other => other !== e && Math.abs(other.number[0] - e.number[0]) === 1
      && (other.page - e.page) * (other.number[0] - e.number[0]) > 0)).map(e => e.number[0]));
  const hasChapters = ordered.some(e => e.role === 'chapter') || chapterNumbers.size > 0;
  const firstPart = ordered.find(e => e.role === 'part' && /^(part|book)\s+(I|1|one)\b/i.test(e.title));
  let chapter = null, previousNumber = null;
  const sections = [];
  for (let entry of ordered) {
    if (entry.role === 'part' && firstPart && entry.page < firstPart.page) continue;
    if (entry.role === 'part') { chapter = null; previousNumber = null; }
    if (entry.role === 'heading' && (counts.get(titleKey(entry.title)) >= 3 || hasChapters && !frontMatterTitle.test(entry.title))) continue;
    if (['numbered', 'number-uncertain'].includes(entry.role)) {
      let number = entry.number;
      // Repair missing OCR dots only when the previous, confirmed heading gives
      // one unambiguous next sibling (3.1.2 -> 313, 4.3 -> 44). Never guess a
      // chapter or turn a footnote number into one.
      if (previousNumber && (entry.role === 'number-uncertain' || number[0] !== chapter)) {
        const sibling = [...previousNumber]; sibling[sibling.length - 1]++;
        const possible = [sibling, [...previousNumber, 1], ...(entry.opener ? [previousNumber] : [])]
          .filter(path => path.length > 1 && path.join('') === number.join(''));
        if (possible.length === 1) {
          number = possible[0]; entry = { ...entry, number, title: entry.title.replace(/^\d[\d.]*/, number.join('.')), role: 'numbered' };
        }
      }
      if (entry.role === 'number-uncertain') continue;
      if (number.length > 1 && chapter !== null && number[0] !== chapter) continue;
      if (number.some(n => n < 1)) continue;
      if (number.length === 1) {
        if (hasChapters && !chapterNumbers.has(number[0])) continue;
        chapter = number[0]; entry = { ...entry, role: chapterNumbers.has(number[0]) ? 'chapter' : 'heading' };
      }
      else entry = { ...entry, role: 'heading' };
      // Numbered siblings must progress, while a new parent can restart them.
      if (previousNumber && previousNumber.length === number.length && number.slice(0,-1).join('.') === previousNumber.slice(0,-1).join('.')
        && number.at(-1) < previousNumber.at(-1)) continue;
      previousNumber = number;
      entry = { ...entry, level: number.length + (hasParts ? 1 : 0) };
    }
    if (!entry.level) entry = { ...entry, level: entry.role === 'part' ? 1 : entry.role === 'chapter' ? hasParts ? 2 : 1
      : frontMatterTitle.test(entry.title) ? 1 : hasChapters ? hasParts ? 3 : 2 : 1 };
    sections.push(entry);
  }
  // Contents corroborate destinations from raw recognition, even when the
  // reading layout keeps that page as an image. Keep subsection hierarchy.
  const resolved = [];
  for (const entry of sections) {
    const matches = printed.filter(p => p.page < entry.page && similarTitle(p.title, entry.title));
    if (matches.length === 1) {
      entry.contentsReference = matches[0].reference;
      if (/^\d+$/.test(matches[0].reference)) resolved.push({ contents: matches[0], entry,
        offset: entry.page - Number(matches[0].reference) });
    }
  }
  // Resolve image-only appendix/divider destinations using a consensus offset
  // proven by at least three independent heading matches. No presumed +N for
  // all books: reject inconsistent pagination, and never cross a TOC's bounds.
  const offsets = new Set(resolved.map(r => r.offset));
  if (new Set(resolved.map(r => r.contents)).size >= 3 && offsets.size === 1) {
    const offset = resolved[0].offset;
    for (const contents of printed) {
      if (!/^\d+$/.test(contents.reference) || resolved.some(r => r.contents === contents)) continue;
      const page = Number(contents.reference) + offset;
      if (page <= contents.page || page > pages || sections.some(e => e.page === page
        && (['chapter', 'part'].includes(e.role) || similarTitle(e.title, contents.title)))) continue;
      const match = contents.title.match(marker);
      sections.push({ title: contents.title, page, level: 1, role: match?.[1].toLowerCase() === 'chapter' ? 'chapter' : 'heading',
        contentsReference: contents.reference, inferredFromContents: true });
    }
  }
  return sections.sort((a,b) => a.page - b.page || (a.point?.y || 0) - (b.point?.y || 0));
}

// Run at preparation time and in library audits. Failures are observable rather
// than silently accepting a tiny or nonsensical list as a successful outline.
export function pdfNavigationSanity(sections, { candidates = [], pages = Infinity, source = 'derived' } = {}) {
  const issues = [], seen = new Set(), numbers = new Set(); let previous = 0;
  for (const entry of sections) {
    const identity = `${entry.page}:${titleKey(entry.title)}:${Math.round(entry.point?.y || 0)}`;
    if (!Number.isInteger(entry.page) || entry.page < 1 || entry.page > pages) issues.push({ code: 'invalid-page', page: entry.page });
    if (entry.page < previous) issues.push({ code: 'backward-page', page: entry.page });
    if (seen.has(identity)) issues.push({ code: 'duplicate-heading', page: entry.page });
    if (source !== 'bookmarks' && (entry.title.length > 140 || entry.title.split(' ').length > 20)) issues.push({ code: 'prose-heading', page: entry.page });
    if (entry.role === 'part') numbers.clear();
    if (entry.number) {
      const number = entry.number.join('.');
      if (numbers.has(number)) issues.push({ code: 'duplicate-section-number', page: entry.page, number });
      numbers.add(number);
    }
    seen.add(identity); previous = entry.page;
  }
  const contents = candidates.filter(e => e.role === 'contents');
  for (const entry of contents) if (!sections.some(s => s.page > entry.page && similarTitle(s.title, entry.title)))
    issues.push({ code: 'unresolved-contents', page: entry.page, title: entry.title });
  return { checked: sections.length, contents: contents.length, issues };
}
