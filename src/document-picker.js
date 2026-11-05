import { byteLength, titleText, VISIBLE_LINES } from './native-text.js';
import { TERMINAL_SESSIONS_ID, terminalSessionPickerText } from './terminal-sessions.js';
export const LIBRARIAN_ID = Symbol('librarian');

export function openDocumentPicker(documents = [], activeId = null, highlightedId = activeId) {
  const counts = new Map();
  for (const doc of documents) counts.set(doc.title, (counts.get(doc.title) || 0) + 1);
  const canReturn = Boolean(activeId);
  const items = [...(canReturn ? [{ id: null, title: 'Back to reading' }] : []), { id: LIBRARIAN_ID, title: 'Librarian' }, { id: TERMINAL_SESSIONS_ID, title: 'Even Terminal sessions' }, ...documents.map(doc => ({
    id: doc.id, title: counts.get(doc.title) > 1 ? `${doc.id} — ${doc.title}` : doc.title || doc.id,
  }))];
  const selected = canReturn && highlightedId === null ? null : highlightedId ?? documents[0]?.id ?? LIBRARIAN_ID;
  return { items, canReturn, index: Math.max(0, items.findIndex(item => item.id === selected)) };
}

export function moveDocumentPicker(picker, direction) {
  if (!picker.items.length) return picker;
  return { ...picker, index: (picker.index + Math.sign(direction) + picker.items.length) % picker.items.length };
}

export function documentPickerText(picker) {
  if (picker.kind === 'terminal-sessions') return terminalSessionPickerText(picker);
  const count = picker.items.length - Number(picker.canReturn) - 2;
  const visible = VISIBLE_LINES - 1;
  const start = Math.max(0, Math.min(picker.items.length - visible, picker.index - Math.floor(visible / 2)));
  const selected = picker.items[picker.index]?.id;
  const number = picker.index - Number(picker.canReturn) - 1;
  const lines = [selected === TERMINAL_SESSIONS_ID ? 'Browse Even Terminal sessions' : selected === LIBRARIAN_ID ? 'Ask the librarian' : selected === null ? 'Library · Back to reading' : `Choose document (${number}/${count})`];
  if (!count) lines.push('No saved documents. Add files on phone.');
  for (let i = start; i < Math.min(picker.items.length, start + visible); i++) {
    const label = `${i === picker.index ? '> ' : '  '}${picker.items[i].title.replace(/\s+/g, ' ')}`;
    // Bound missing glyphs as well as measured width, for libraries containing
    // long Unicode titles. The entire picker stays within one native payload.
    let bounded = '';
    for (const character of label) {
      if (byteLength(bounded + character) > 93) { bounded += '…'; break; }
      bounded += character;
    }
    lines.push(titleText(bounded));
  }
  return lines.join('\n');
}
