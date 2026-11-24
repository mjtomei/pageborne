// Run after `lit models pull ocria-nano` verifies the upstream package. Capture
// every installed asset (including the platform runtime) for offline checks.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { verifyOcrModels } from './identity.mjs';
const [model, python, library] = process.argv.slice(2);
if (!model || !python || !library) throw Error('Usage: node desktop/ocr/configure-nano.mjs MODEL_DIRECTORY PYTHON LIBRARY > private-config.json');
const modelPath = path.resolve(model), modelFiles = [];
async function walk(prefix = '') {
  for (const entry of (await readdir(path.join(modelPath, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = prefix + entry.name;
    if (entry.isDirectory()) await walk(file + '/');
    else if (entry.isFile()) modelFiles.push({ file, sha256: createHash('sha256').update(await readFile(path.join(modelPath, file))).digest('hex') });
    else throw Error('Unsupported model asset');
  }
}
await walk();
const config = { recognizer: 'ocria-nano', modelPath, python: path.resolve(python), libraryDir: path.resolve(library),
  weightsSha256: createHash('sha256').update(JSON.stringify(modelFiles)).digest('hex'), modelFiles, batchSize: 1 };
await verifyOcrModels(config);
process.stdout.write(JSON.stringify(config, null, 2) + '\n');
