import TextWorker from './text-worker.js?worker&inline';

// Long books must not block touch input, cancellation, or bridge timeouts.
export function prepareTextInBackground(content, signal, progress = () => {}, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new TextWorker();
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Text preparation took too long. Choose another document or reopen this one to retry.')), timeout);
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort); worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(signal.reason || new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') progress(data.stage);
      else if (data.type === 'done') finish(null, data);
      else if (data.type === 'error') finish(new Error(data.message));
    };
    worker.onerror = event => { event.preventDefault(); finish(new Error('Text preparation failed. Reopen the document to retry.')); };
    worker.onmessageerror = () => finish(new Error('Could not receive the prepared text.'));
    try { worker.postMessage(content); } catch (error) { finish(error); }
  });
}
