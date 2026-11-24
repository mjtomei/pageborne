import { wrapText, HEIGHT } from './document.js';
import { measureNativeText, LINE_HEIGHT } from './native-text.js';
import { transcriptionHint } from './controls.js';
import { visibleUncertainWords } from './transcription-confidence.js';

// Keep the controls at the bottom and grow upward only as the transcript wraps.
// Three lines is the maximum; transcription follows its tail through completion
// unless the reader chooses an earlier review page.
export function transcriptionGeometry(dialog) {
  const lines = Math.max(1, Math.min(3, String(dialog.text || '').split('\n').length));
  const textHeight = lines * LINE_HEIGHT;
  const controlsTop = dialog.status && !dialog.statusInline ? 226 : 253;
  const separatorY = controlsTop - 6;
  const top = separatorY - 12 - textHeight;
  return { top, height: HEIGHT - top, textHeight, controlsTop, separatorY, bodyLines: Math.floor(top / LINE_HEIGHT),
    statusWidth: dialog.statusInline ? 104 : 528, hintWidth: dialog.statusInline ? 408 : 528 };
}

export const transcriptionLines = text => wrapText(String(text || '').replace(/\s+/g, ' '), 492, measureNativeText).map(line => line.text);

export function transcriptionReview(text, words = []) {
  const source = String(text || ''), leading = source.length - source.trimStart().length;
  text = source.trim();
  words = words.map(word => ({ ...word, start: word.start - leading, end: word.end - leading }));
  const lines = transcriptionLines(text);
  const pages = [];
  for (let i = 0; i < lines.length; i += 3) pages.push(lines.slice(i, i + 3).join('\n'));
  return { text, pages, page: 0, words };
}
export function reviewDialog(review, phase = 0) {
  const lines = transcriptionLines(review.text);
  const start = review.following ? Math.max(0, lines.length - 3) : review.page * 3;
  return { text: lines.slice(start, start + 3).join('\n') || ' ', dimmed: !!review.dimmed,
    uncertain: visibleUncertainWords(review.text, review.words, lines, start),
    hint: transcriptionHint(review.pages.length),
    status: review.refining ? `Refining${'.'.repeat(phase + 1)}` : '', statusInline: true };
}

export function liveTranscriptionDialog(status, text, progress, phase = 0, line = null, words = []) {
  const lines = transcriptionLines(text), start = Math.max(0, Math.min(line ?? lines.length - 3, lines.length - 3));
  const dots = '.'.repeat(phase + 1);
  return { text: lines.slice(start, start + 3).join('\n') || ' ', hint: transcriptionHint(Math.ceil(lines.length / 3)),
    uncertain: visibleUncertainWords(String(text || ''), words, lines, start),
    status: status === 'starting' ? 'Starting microphone…' : status === 'listening' ? `Listening${dots}` : `Refining${dots}`,
    statusInline: status === 'transcribing' };
}
