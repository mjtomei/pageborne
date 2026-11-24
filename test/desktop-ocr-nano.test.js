import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { nanoDiagramGrid } from '../desktop/ocr/nano-layout.js';
import { verifyOcrModels } from '../desktop/ocr/identity.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');

test('short aligned diagram labels retain their spatial relationships as an image', () => {
  const lines = [0, 22, 44].flatMap(y => [100, 300, 500, 700].map(x => ({ x, y, width: 80, height: 20, text: 'a label' })));
  assert(nanoDiagramGrid(lines, 900));
  assert(!nanoDiagramGrid(lines.slice(0, 4), 900), 'one row alone is insufficient');
  assert(!nanoDiagramGrid([0, 25, 50].flatMap(y => [50, 480].map(x => ({ x, y, width: 350, height: 20, text: 'Normal prose column with several words.' }))), 900));
  assert(!nanoDiagramGrid([0, 300, 600].flatMap(y => [100, 300, 500].map(x => ({ x, y, width: 80, height: 20, text: 'label' }))), 900), 'separate figure labels are not a grid');
});
test('Nano checks every pinned model asset before starting inference', async t => {
  const modelPath = await mkdtemp(path.join(tmpdir(), 'nano-assets-')); t.after(() => rm(modelPath, { recursive: true, force: true }));
  const names = ['LICENSE', 'manifest.json', 'det.onnx', 'rec_latin.onnx', 'router.onnx'];
  for (const name of names) await writeFile(path.join(modelPath, name), name);
  const modelFiles = names.map(file => ({ file, sha256: hash(file) }));
  const config = { recognizer: 'ocria-nano', modelPath, modelFiles, weightsSha256: hash(JSON.stringify(modelFiles)) };
  await verifyOcrModels(config);
  await writeFile(path.join(modelPath, 'det.onnx'), 'corrupt');
  await assert.rejects(verifyOcrModels(config), /checksum mismatch/);
  await assert.rejects(verifyOcrModels({ ...config, modelFiles: modelFiles.slice(1) }), /manifest/);
});


test('Nano recognition failure uses Tesseract, while cancellation never starts fallback', async () => {
  const { NanoOcr } = await import('../desktop/ocr/nano-ocr.js');
  const expected = { text: [{ text: 'Recovered prose' }], turn: 0 };
  let fallbackCalls = 0; const warnings = [];
  const ocr = new NanoOcr({ recognize: async () => { fallbackCalls++; return expected; }, destroy: async () => {} }, null, text => warnings.push(text));
  ocr.recognizeTurn = async () => { throw Error('Unavailable engine'); };
  assert.equal(await ocr.recognize({ pageNumber: 1 }, {}, 'fixture'), expected);
  assert.equal(fallbackCalls, 1);
  assert.equal(ocr.results.get(1).fallback, 'nano-failed');
  assert.equal(warnings.length, 1);
  await ocr.destroy();
  await assert.rejects(ocr.recognize({ pageNumber: 2 }, {}, 'fixture'), /Unavailable engine/);
  assert.equal(fallbackCalls, 1);
});
