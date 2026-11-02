// Read-only scan of the final reader output versus saved, pre-layout OCR.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCheckpointReflow } from '../desktop/ocr/reflow-audit.mjs';

export function checkReflowExpectations(results, expected) {
  const failures = [];
  for (const [source, check] of Object.entries(expected)) {
    const matches = results.filter(result => result.source === source);
    if (!matches.length) { failures.push({ source, error: 'Expected document missing' }); continue; }
    for (const result of matches) {
      if (!result.complete) failures.push({ source, error: 'Missing recognition checkpoints', pages: result.missingPages });
      for (const page of check.mustReflow || []) {
        const actual = result.pages.find(p => p.page === page);
        if (!actual || actual.reflowWords === 0 || actual.fullPage) failures.push({ source, page, error: 'Expected reflowed text' });
      }
      for (const page of result.fullPageImages) if (!(check.imagePages || []).includes(page))
        failures.push({ source, page, error: 'New full-page image' });
      for (const issue of result.issues) if (!(check.knownIssues || []).some(known => known.page === issue.page && known.code === issue.code))
        failures.push({ source, page: issue.page, error: 'New reflow issue', code: issue.code });
    }
  }
  // A newly added document must be reviewed too, not silently omitted from CI.
  for (const result of results) if (!Object.hasOwn(expected, result.source)) failures.push({ source: result.source, error: 'Document has no regression expectations' });
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
  const root = option('--root');
  if (!root) throw Error('Usage: npm run audit:pdf-reflow -- --root <OCR engine directory> [--expect <JSON>] [--output <JSON>] [--strict]');
  const results = [];
  for (const file of (await fs.readdir(path.join(root, 'prepared'))).sort()) {
    if (!file.endsWith('.json')) continue;
    const artifact = JSON.parse(await fs.readFile(path.join(root, 'prepared', file), 'utf8'));
    const [, , source, settings] = JSON.parse(artifact.key);
    if (!/^[a-f0-9]{64}$/.test(source)) throw Error('Invalid preparation source hash');
    const report = await auditCheckpointReflow(artifact.saved, async number => {
      try { return JSON.parse(await fs.readFile(path.join(root, 'pages', source, number + '.json'), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }, { reflow: settings.reflow !== false });
    results.push({ source, preparation: file, ...report });
  }
  if (!results.length) throw Error('No completed preparations found.');
  const failures = option('--expect') ? checkReflowExpectations(results, JSON.parse(await fs.readFile(option('--expect'), 'utf8'))) : [];
  const report = { documents: results.length, checkedPages: results.reduce((sum, r) => sum + r.checkedPages, 0),
    complete: results.every(r => r.complete), fullPageImages: results.reduce((sum, r) => sum + r.fullPageImages.length, 0),
    flaggedPages: results.reduce((sum, r) => sum + new Set(r.issues.map(issue => issue.page)).size, 0), failures, results };
  if (option('--output')) await fs.writeFile(option('--output'), JSON.stringify(report, null, 2) + '\n');
  const { results: _, ...summary } = report; console.log(JSON.stringify(summary));
  if (!report.complete || failures.length || args.includes('--strict') && report.flaggedPages) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
