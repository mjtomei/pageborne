import { readingWords, readingUnitKey } from './reading-activity.js';

// The phone chat is plain text inside each message. Measure only words actually
// inside its clipped viewport, excluding speaker labels, controls and activity.
// Cache until scrolling, resizing or message content changes; never measure the
// whole conversation on every animation frame.
export class AskPhoneReadingView {
  sample(scroller, signature) {
    const box = scroller.getBoundingClientRect();
    const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
    if (bottom <= top || !box.width || !box.height) return null;
    const key = `${signature}:${scroller.scrollTop}:${box.top}:${box.bottom}:${box.width}:${innerHeight}`;
    if (key === this.key) return this.saved;
    this.key = key;
    const units = [], range = document.createRange();
    for (const message of scroller.querySelectorAll('.ask-message-user, .ask-message-assistant')) {
      if (message.hidden) continue;
      const body = message.querySelector('.ask-message-text'), rect = body.getBoundingClientRect();
      if (rect.bottom <= top || rect.top >= bottom) continue;
      const text = body.firstChild; if (!text || text.nodeType !== Node.TEXT_NODE) continue;
      for (const match of text.textContent.matchAll(/\S+/g)) {
        if (!readingWords(match[0])) continue;
        range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
        const word = range.getBoundingClientRect();
        if (word.top >= top - 1 && word.bottom <= bottom + 1 && word.left >= box.left - 1 && word.right <= box.right + 1)
          units.push({ key: readingUnitKey(message.dataset.key, match.index, match[0]), words: 1, text: match[0] });
      }
    }
    return this.saved = { pane: `phone:${units[0]?.key || Math.round(scroller.scrollTop)}`, units };
  }
}
