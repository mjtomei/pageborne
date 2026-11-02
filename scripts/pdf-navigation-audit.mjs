// Read-only audit of completed desktop preparations and their saved page OCR.
// No recognizer, GPU model, daemon, or browser is loaded by this command.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { attachCheckpointNavigation } from '../desktop/ocr/navigation.mjs';
import { documentContents } from '../src/document-contents.js';
import { unpackPdfPreparation } from '../src/pdf-cache.js';
import { pdfNavigationSanity } from '../src/pdf-navigation.js';

const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const root = option('--root');
if (!root) throw Error('Usage: npm run audit:pdf-navigation -- --root <OCR engine directory> [--expect <JSON>] [--output <JSON>]');
const expected = option('--expect') ? JSON.parse(await fs.readFile(option('--expect'), 'utf8')) : {};
const digest = data => createHash('sha256').update(data).digest('hex');
const results = [];
for (const file of (await fs.readdir(path.join(root, 'prepared'))).sort()) {
  if (!file.endsWith('.json')) continue;
  const artifact = JSON.parse(await fs.readFile(path.join(root, 'prepared', file), 'utf8'));
  const source = JSON.parse(artifact.key)[2], saved = artifact.saved;
  const blocks = digest(JSON.stringify(saved.layout.blocks));
  // Always exercise the current detector; keep original inputs on disk intact.
  if (saved.layout.navigation) saved.layout.navigation.version = 0;
  const upgraded = await attachCheckpointNavigation(saved, async number => {
    try { return JSON.parse(await fs.readFile(path.join(root, 'pages', source, number + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  });
  assert.equal(digest(JSON.stringify(saved.layout.blocks)), blocks, 'navigation changed reading content');
  const navigation = saved.layout.navigation;
  const layout = unpackPdfPreparation(saved).layout;
  const entries = documentContents(layout);
  const sanity = navigation?.outline?.length ? pdfNavigationSanity(navigation.outline, { source: 'bookmarks', pages: saved.pageScales.length }) : navigation?.sanity;
  const check = expected[source];
  if (check) {
    if (check.chapters) assert.deepEqual(navigation.sections.filter(e => e.role === 'chapter').map(e => e.page), check.chapters);
    for (const { title, page, level } of check.entries || []) assert.ok(entries.some(e => e.title === title && e.page === page && (level === undefined || e.level === level)), `Missing ${title} on page ${page}`);
    if (check.noIssues) assert.deepEqual(sanity?.issues, []);
    if (check.issues) assert.deepEqual(sanity?.issues, check.issues);
  }
  results.push({ source, upgraded, pages: saved.pageScales.length, sourceType: navigation?.outline?.length ? 'bookmarks' : 'derived',
    chapters: navigation?.sections?.filter(e => e.role === 'chapter').map(e => e.page), entries, sanity });
}
for (const source of Object.keys(expected)) assert.ok(results.some(r => r.source === source), 'Expected document missing: ' + source);
const report = { documents: results.length, pages: results.reduce((sum, r) => sum + r.pages, 0),
  documentsWithIssues: results.filter(r => r.sanity?.issues.length).length, results };
if (option('--output')) await fs.writeFile(option('--output'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ documents: report.documents, pages: report.pages, documentsWithIssues: report.documentsWithIssues,
  expectedDocuments: Object.keys(expected).length, checkpointOnly: true }));
