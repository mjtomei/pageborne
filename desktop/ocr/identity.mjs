import { createHash } from 'node:crypto';
import { readFile, readdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export async function verifyOcrModels(config) {
  const nano = config.recognizer === 'ocria-nano';
  if (config.recognizer && !['ocria-nano', 'tesseract-xiaomi'].includes(config.recognizer)) throw Error('Unknown OCR recognizer');
  const files = nano ? config.modelFiles : [{ file: 'model.safetensors', sha256: config.weightsSha256 }];
  if (!Array.isArray(files) || !files.length || nano && createHash('sha256').update(JSON.stringify(files)).digest('hex') !== config.weightsSha256) throw Error('Invalid Nano asset manifest');
  if (nano && !['LICENSE', 'manifest.json', 'det.onnx', 'rec_latin.onnx', 'router.onnx'].every(name => files.some(f => f.file === name))) throw Error('Incomplete Nano asset manifest');
  if (nano) {
    const installed = [];
    const walk = async (prefix = '') => {
      for (const entry of await readdir(path.join(config.modelPath, prefix), { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) await walk(name + '/');
        else if (entry.isFile()) installed.push(name);
        else throw Error('Linked or unsupported Nano asset');
      }
    };
    await walk();
    if (JSON.stringify(installed.sort()) !== JSON.stringify(files.map(f => f.file).sort())) throw Error('Nano asset manifest does not cover the installed package');
  }
  for (const entry of files) {
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(entry.file) || entry.file.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw Error('Invalid OCR asset');
    const hash = createHash('sha256'), file = await open(path.join(config.modelPath, entry.file), 'r');
    try { for await (const chunk of file.createReadStream()) hash.update(chunk); } finally { await file.close().catch(() => {}); }
    if (hash.digest('hex') !== entry.sha256) throw Error(`OCR asset checksum mismatch: ${entry.file}`);
  }
}
// Shared with checkpoint-only rebuild tools. Calculating this identity never
// imports the inference engine or allocates model/GPU memory.
export async function ocrEngineIdentity(config, dist) {
  const signature = createHash('sha256').update(config.weightsSha256);
  signature.update(config.recognizer || 'tesseract-xiaomi');
  for (const name of ['engine.py', 'inference_result.py', 'correction.py', 'worker.js', 'requirements.txt', 'nano.py', 'nano-ocr.js', 'nano-layout.js', 'requirements-nano.txt']) signature.update(await readFile(path.join(here, name)));
  for (const name of (await readdir(config.modelPath)).filter(name => name.endsWith('.json')).sort()) {
    signature.update(name).update(await readFile(path.join(config.modelPath, name)));
  }
  for (const name of (await readdir(path.join(dist, 'assets'))).sort()) signature.update(await readFile(path.join(dist, 'assets', name)));
  return signature.digest('hex');
}
