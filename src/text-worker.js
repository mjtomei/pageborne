import { parseDocument } from './document.js';
import { nativeLayout } from './native-text.js';
import { speedEntries } from './speed-reading.js';

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ type: 'progress', stage: 'Laying out text…' });
    const layout = nativeLayout(parseDocument(data), 0);
    self.postMessage({ type: 'progress', stage: 'Indexing words…' });
    const entries = speedEntries(layout);
    self.postMessage({ type: 'done', layout, entries });
  } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
};
