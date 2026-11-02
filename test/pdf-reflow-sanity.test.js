import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pdfReflowPageSanity, pdfReflowSanity } from '../src/pdf-reflow-sanity.js';
import { auditCheckpointReflow, attachCheckpointReflowSanity } from '../desktop/ocr/reflow-audit.mjs';
import { checkReflowExpectations } from '../scripts/pdf-reflow-audit.mjs';

const prose = (count = 12) => ({ width: 900, height: 1200, needsOcr: true,
  text: Array.from({ length: count }, (_, i) => ({ x: 110, y: 100 + i * 24, width: 640, height: 16,
    text: 'Recognized prose explains how people interpret plans and actions in complex everyday human situations.', confidence: 94 })) });
const image = { page: 1, kind: 'figure', fullPage: true, text: '', lines: [] };
const reflow = extracted => ({ page: 1, reflow: { text: extracted.text.map(t => t.text).join(' ') } });

test('a confidently recognized text page cannot silently pass as a textless image', () => {
  const extracted = prose(), before = structuredClone(extracted);
  const result = pdfReflowPageSanity(12, extracted, [image]);
  assert.equal(result.issues[0].code, 'text-page-as-image');
  assert.equal(result.issues[0].confidentWordFraction, 1);
  assert.equal(result.proseLines, 12);
  assert.ok(result.recognizedWords > 100);
  assert.equal(result.reflowWords, 0);
  assert.deepEqual(extracted, before);
  assert.deepEqual(pdfReflowPageSanity(12, extracted, [reflow(extracted)]).issues, []);
});

test('short continuation pages and image-only contents are checked without flagging sparse covers', () => {
  assert.equal(pdfReflowPageSanity(11, prose(2), [image]).issues[0].code, 'text-page-as-image');
  const contents = { text: ['CONTENTS', 'INTRODUCTION 3', 'INTERACTIVE ARTIFACTS 7', 'PLANS AND ACTIONS 21',
    'SITUATED ACTIONS 35', 'HUMAN COMMUNICATION 47'].map((text, i) => ({ text, x: 100, y: 100 + i * 30, width: 400, height: 18 })) };
  assert.equal(pdfReflowPageSanity(8, contents, [image]).issues[0].contents, true);
  const cover = { text: [{ text: 'PLANS AND SITUATED ACTIONS', x: 100, y: 100, width: 500, height: 30 },
    { text: 'Example Author', x: 100, y: 300, width: 200, height: 20 }] };
  assert.deepEqual(pdfReflowPageSanity(1, cover, [image]).issues, []);
  assert.deepEqual(pdfReflowPageSanity(3, { text: [] }, [image]).issues, []);
});

test('structured pages remain reviewable and original-image mode is not called a reflow failure', () => {
  const result = pdfReflowPageSanity(85, prose(), [image], { markdown: '<fcel>USER<fcel>MACHINE<nl>' });
  assert.equal(result.issues[0].structuredContent, true);
  assert.equal(result.issues[0].code, 'text-page-as-image');
  assert.deepEqual(pdfReflowPageSanity(85, prose(), [image], { reflow: false }).issues, []);
  // A real figure beside fully retained prose is not suspicious.
  assert.deepEqual(pdfReflowPageSanity(85, prose(), [{ ...image, fullPage: false }, reflow(prose())]).issues, []);
});

test('partial text loss, empty output and absent confidence are reported conservatively', () => {
  const partial = pdfReflowPageSanity(4, prose(), [{ ...image, fullPage: false }, reflow(prose(2))]);
  assert.equal(partial.issues[0].code, 'most-text-not-reflowed');
  assert.equal(pdfReflowPageSanity(4, prose(), []).issues[0].code, 'recognized-text-without-content');
  const native = prose(); native.text.forEach(t => { delete t.confidence; });
  assert.equal(pdfReflowPageSanity(4, native, [image]).issues[0].confidentWordFraction, undefined);
  const report = pdfReflowSanity([partial], { expectedPages: [4, 5] });
  assert.equal(report.complete, false); assert.deepEqual(report.missingPages, [5]);
});

test('saved checkpoint audit sees text erased by fallback and changes only optional metadata', async () => {
  const saved = { pageScales: [[1, 1], [2, 1]], layout: { blocks: [image, { ...reflow(prose()), page: 2 }] } };
  const before = structuredClone(saved); const reads = [];
  const read = async number => { reads.push(number); return { number, extracted: prose() }; };
  assert.equal(await attachCheckpointReflowSanity(saved, read), true);
  assert.deepEqual(reads, [1, 2]);
  assert.equal(saved.layout.reflowSanity.complete, true);
  assert.deepEqual(saved.layout.reflowSanity.issues.map(i => i.page), [1]);
  const clone = structuredClone(saved); delete clone.layout.reflowSanity; assert.deepEqual(clone, before);
  assert.equal(await attachCheckpointReflowSanity(saved, () => { throw Error('must not reread'); }), false);
  const report = await auditCheckpointReflow(saved, async number => number === 2 ? null : { number, extracted: prose() });
  assert.equal(report.complete, false); assert.deepEqual(report.missingPages, [2]);
  assert.equal(await attachCheckpointReflowSanity(before, read, { current: () => false }), false);
  await assert.rejects(auditCheckpointReflow(before, read, { current: () => false }), /cancelled/);
  assert.equal(before.layout.reflowSanity, undefined);
});

test('incomplete checkpoint audits retry and never claim missing OCR passed', async () => {
  const saved = { pageScales: [[1, 1]], layout: { blocks: [image] } };
  await attachCheckpointReflowSanity(saved, async () => null);
  assert.equal(saved.layout.reflowSanity.complete, false);
  assert.equal(await attachCheckpointReflowSanity(saved, async () => ({ number: 999, extracted: prose() })), false);
  await attachCheckpointReflowSanity(saved, async number => ({ number, extracted: prose() }));
  assert.equal(saved.layout.reflowSanity.complete, true);
  assert.equal(saved.layout.reflowSanity.issues.length, 1);
});

test('regressions fail for new image pages, new issues, missing input and missing documents', () => {
  const clean = { source: 'book', complete: true, fullPageImages: [], issues: [], pages: [{ page: 12, reflowWords: 500 }] };
  const expected = { book: { mustReflow: [12], imagePages: [1], knownIssues: [] } };
  assert.deepEqual(checkReflowExpectations([clean], expected), []);
  const broken = { ...clean, fullPageImages: [12], issues: [{ page: 12, code: 'text-page-as-image' }], pages: [{ page: 12, fullPage: true, reflowWords: 0 }] };
  assert.deepEqual(checkReflowExpectations([broken], expected).map(f => f.error),
    ['Expected reflowed text', 'New full-page image', 'New reflow issue']);
  const acknowledged = { book: { imagePages: [12], knownIssues: [{ page: 12, code: 'text-page-as-image' }] } };
  assert.deepEqual(checkReflowExpectations([broken], acknowledged), []);
  assert.equal(checkReflowExpectations([{ ...clean, complete: false, missingPages: [12] }], expected)[0].error, 'Missing recognition checkpoints');
  assert.equal(checkReflowExpectations([], expected)[0].error, 'Expected document missing');
  assert.equal(checkReflowExpectations([clean], {})[0].error, 'Document has no regression expectations');
});

test('audit CLI is read-only, strict mode exposes existing bugs and baseline mode catches new ones', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pageborne-reflow-audit-'));
  const source = 'a'.repeat(64), checkpoint = path.join(root, 'pages', source, '1.json');
  try {
    await fs.mkdir(path.join(root, 'prepared')); await fs.mkdir(path.dirname(checkpoint), { recursive: true });
    const artifact = JSON.stringify({ key: JSON.stringify([18, 'test', source, { reflow: true }]),
      saved: { pageScales: [[1, 1]], layout: { blocks: [image] } } });
    const recognition = JSON.stringify({ number: 1, extracted: prose() });
    await fs.writeFile(path.join(root, 'prepared', 'book.json'), artifact); await fs.writeFile(checkpoint, recognition);
    const expect = path.join(root, 'expected.json'), output = path.join(root, 'report.json');
    await fs.writeFile(expect, JSON.stringify({ [source]: { imagePages: [1], knownIssues: [{ page: 1, code: 'text-page-as-image' }] } }));
    const run = (...args) => spawnSync(process.execPath, ['scripts/pdf-reflow-audit.mjs', '--root', root, '--output', output, ...args], { encoding: 'utf8' });
    assert.equal(run('--expect', expect).status, 0);
    assert.equal(JSON.parse(await fs.readFile(output)).flaggedPages, 1, 'baseline does not hide known failures');
    assert.equal(run('--strict', '--expect', expect).status, 1);
    await fs.writeFile(expect, JSON.stringify({ [source]: { mustReflow: [1], imagePages: [], knownIssues: [] } }));
    assert.equal(run('--expect', expect).status, 1);
    assert.equal(await fs.readFile(path.join(root, 'prepared', 'book.json'), 'utf8'), artifact);
    assert.equal(await fs.readFile(checkpoint, 'utf8'), recognition);
    await fs.unlink(checkpoint);
    assert.equal(run().status, 1, 'missing checkpoints cannot pass even outside strict mode');
    assert.equal(JSON.parse(await fs.readFile(output)).complete, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
