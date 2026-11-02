import { pdfNavigationCandidates, pdfNavigationSections, pdfNavigationSanity, PDF_NAVIGATION_VERSION } from '../../src/pdf-navigation.js';
import { pdfSourcePoint } from '../../src/pdf-orientation.js';

// Upgrade navigation from saved recognition, one page at a time. This optional
// metadata does not change OCR/layout identity or require loading any models.
export async function attachCheckpointNavigation(saved, readPage, current = () => true) {
  if (saved.layout.navigation?.version === PDF_NAVIGATION_VERSION) return false;
  const candidates = [];
  const numbers = saved.pageScales.map(([number]) => number).sort((a, b) => a - b);
  if (!numbers.length) return false;
  for (const number of numbers) {
    if (!current()) return false;
    const page = await readPage(number);
    if (page?.number !== number || !Array.isArray(page.extracted?.text)) return false;
    const block = saved.layout.blocks.find(b => b.page === number && b.sourceTransform);
    if (page.turn && !block) return false;
    candidates.push(...pdfNavigationCandidates(page.extracted, number).map(entry => ({ ...entry,
      point: pdfSourcePoint(block || {}, entry.point) })));
    if (candidates.length > 8192) return false;
  }
  if (!current()) return false;
  const pages = Math.max(...numbers), sections = pdfNavigationSections(candidates, { pages });
  saved.layout.navigation = { ...saved.layout.navigation, version: PDF_NAVIGATION_VERSION, sections,
    sanity: pdfNavigationSanity(sections, { candidates, pages }) };
  return true;
}
