import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Shared with checkpoint-only rebuild tools. Calculating this identity never
// imports the inference engine or allocates model/GPU memory.
export async function ocrEngineIdentity(config, dist) {
  const signature = createHash('sha256').update(config.weightsSha256);
  for (const name of ['engine.py', 'inference_result.py', 'correction.py', 'worker.js', 'requirements.txt']) signature.update(await readFile(path.join(here, name)));
  for (const name of (await readdir(config.modelPath)).filter(name => name.endsWith('.json')).sort()) {
    signature.update(name).update(await readFile(path.join(config.modelPath, name)));
  }
  for (const name of (await readdir(path.join(dist, 'assets'))).sort()) signature.update(await readFile(path.join(dist, 'assets', name)));
  return signature.digest('hex');
}
