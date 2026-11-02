import { validatePdfPreparation } from './pdf-cache.js';
import { PDF_NAVIGATION_VERSION } from './pdf-navigation.js';
import { base64ToBytes } from './binary.js';

// Probe once per open. A missing/old/offline desktop never blocks local OCR,
// and a result arriving later cannot replace the layout under a reader.
export function desktopPdfCache(local, client, name, current = () => true) {
  return {
    async read(key) {
      let saved;
      try { saved = await local.read(key); if (saved) validatePdfPreparation(saved); }
      catch { saved = null; }
      if (!client || !current()) return saved;
      try {
        const result = await client.api('pageborne/library/preparation', {
          // Older artifacts lack chapter metadata, including OCR hidden by a
          // full-page image. Fetch the upgraded preparation once on first open.
          body: { name, key, engine: saved?.layout.navigation?.version === PDF_NAVIGATION_VERSION ? saved.desktopEngine : undefined }, timeoutMs: 1500,
        });
        if (!current()) return saved;
        if (result.state === 'ready' && result.key === key && /^[a-f0-9]{64}$/.test(result.engine)) {
          if (result.unchanged && saved?.desktopEngine === result.engine) return saved;
          if (!Number.isSafeInteger(result.bytes) || result.bytes <= 0
            || !/^[a-f0-9]{64}$/.test(result.sha256)) return saved;
          const bytes = new Uint8Array(result.bytes);
          for (let offset = 0; offset < bytes.length;) {
            if (!current()) return saved;
            const chunk = await client.api('pageborne/library/preparation', {
              body: { name, key, offset, sha256: result.sha256 }, timeoutMs: 5000,
            });
            const data = base64ToBytes(chunk.data);
            if (chunk.offset !== offset || chunk.sha256 !== result.sha256 || chunk.bytes !== bytes.length
              || !data.length || data.length > 768*1024 || offset+data.length > bytes.length) return saved;
            bytes.set(data, offset); offset += data.length;
          }
          const actualHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
          if (actualHash !== result.sha256 || !current()) return saved;
          const downloaded = JSON.parse(new TextDecoder().decode(bytes));
          if (downloaded.key !== key || downloaded.engine !== result.engine) return saved;
          // Validate before replacing a usable phone result or writing storage.
          const artifact = downloaded.saved;
          validatePdfPreparation(artifact);
          artifact.desktopEngine = result.engine;
          try { await local.write(key, artifact, current); } catch { /* Still usable if phone storage is full. */ }
          return artifact;
        }
      } catch { /* Optional acceleration; preserve the existing offline path. */ }
      return saved;
    },
    write: (...args) => local.write(...args),
  };
}
