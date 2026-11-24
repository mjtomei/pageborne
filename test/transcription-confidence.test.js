import test from 'node:test';
import assert from 'node:assert/strict';
import { getTextWidth } from '@evenrealities/pretext';
import { nativeTranscriptRuns } from '../src/transcription-confidence.js';
import { transcriptionReview, reviewDialog, liveTranscriptionDialog } from '../src/transcription-review.js';
import { reviewPageDefinition } from '../src/glasses.js';
import { AskSession } from '../src/ask.js';

const wordScores = text => [...text.matchAll(/\w+/g)].map(m => ({ start: m.index, end: m.index + m[0].length, confidence: .3 }));
function glyphs(runs) {
  return runs.flatMap(run => run.content.split('\n').flatMap((line, row) => [...line.matchAll(/\S/gu)].map(m =>
    ({ char: m[0], x: run.x + getTextWidth(line) - getTextWidth(line.slice(m.index)), y: run.y + row * 27, color: run.color }))));
}
const readingOrder = list => list.sort((a, b) => a.y - b.y || a.x - b.x);

test('newest uncertainty fits the native budget without moving or dropping any visible glyphs', () => {
  const text = 'Older doubtful words here\nMore words on another line\nNewest doubtful words remain.';
  const words = wordScores(text);
  // Exhaust every uncertainty pattern on nine positions across three rows.
  const choices = [words[1], words[2], words[4], words[5], words[7], words[8], words[9], words[11], words.at(-1)];
  const plain = readingOrder(glyphs(nativeTranscriptRuns(text).runs)).map(({ color, ...g }) => g);
  for (let mask = 1; mask < 512; mask++) {
    const uncertain = choices.filter((_, i) => mask & (1 << i));
    const result = nativeTranscriptRuns(text, uncertain);
    assert(result.runs.length <= 4);
    const actual = readingOrder(glyphs(result.runs));
    assert.deepEqual(actual.map(({ color, ...g }) => g), plain, `glyph preservation for mask ${mask}`);
    const highlighted = uncertain.slice(-result.highlighted);
    const expectedDim = highlighted.map(w => text.slice(w.start, w.end)).join('').replace(/\s/g, '');
    assert.equal(actual.filter(g => g.color === 1).map(g => g.char).join(''), result.highlighted ? expectedDim : '');
    for (const pdf of [false, true]) {
      const page = reviewPageDefinition({ body: 'Reading above', status: 'Listening' }, { text, uncertain, hint: 'Tap: accept', status: 'Listening' }, pdf);
      assert(page.textObject.length <= 8); assert(page.containerTotalNum <= 12);
      assert.equal(page.textObject.filter(b => b.isEventCapture === 1).length, 1);
      assert.equal(page.textObject.find(b => b.isEventCapture === 1).content, ' ');
      const boxes = [...page.textObject, ...(page.imageObject || [])];
      assert.equal(new Set(boxes.map(b => b.containerID)).size, boxes.length);
    }
  }
});

test('latest words win; adjacent uncertain words share a dim block', () => {
  const text = 'old bright older bright newest bright latest bright';
  const uncertain = wordScores(text).filter((_, i) => i % 2 === 0);
  const result = nativeTranscriptRuns(text, uncertain);
  assert.equal(result.highlighted, 1);
  assert.deepEqual(result.runs.filter(r => r.color === 1).map(r => r.content), ['latest']);
  const adjacent = nativeTranscriptRuns('bright dim words together bright', wordScores('bright dim words together bright').slice(1, 4));
  assert.equal(adjacent.highlighted, 3);
  assert.deepEqual(adjacent.runs.filter(r => r.color === 1).map(r => r.content), ['dim words together']);
});

test('confidence offsets survive whitespace, repeated words, wrapping and review paging', () => {
  const text = '   same\t  same\n' + 'same words '.repeat(20) + 'same!  ';
  const words = [{ start: text.lastIndexOf('same'), end: text.lastIndexOf('same') + 4, confidence: .2 }];
  const live = liveTranscriptionDialog('listening', text, '', 0, null, words);
  assert.equal(live.uncertain.length, 1);
  assert.equal(live.text.slice(live.uncertain[0].start, live.uncertain[0].end), 'same');
  assert.equal(live.uncertain[0].start, live.text.lastIndexOf('same'));
  const review = transcriptionReview(text, words);
  assert.deepEqual(reviewDialog(review).uncertain, []);
  review.page = review.pages.length - 1;
  const final = reviewDialog(review);
  assert.equal(final.uncertain.length, 1);
  assert.equal(final.text.slice(final.uncertain[0].start, final.uncertain[0].end), 'same');
  assert.deepEqual(review.pages, transcriptionReview(text).pages, 'confidence never changes pagination');
  review.following = true;
  const following = reviewDialog(review);
  assert.equal(following.text, live.text, 'release keeps the rolling three-line tail');
  assert.deepEqual(following.uncertain, live.uncertain, 'confidence offsets follow the same lines');
});

test('unknown scores stay bright, the 0.70 cutoff applies live and in review, and editing clears confidence', () => {
  const s = new AskSession(); s.open({}); s.setStatus('listening');
  const text = 'uncertain accepted unknown';
  const words = [{ start: 0, end: 9, confidence: .69 }, { start: 10, end: 18, confidence: .7 }, { start: 19, end: 26, confidence: null }];
  s.updateTranscription(text, words);
  assert.deepEqual(s.dialog().uncertain, [{ start: 0, end: 9 }]);
  s.reviewQuestion(text, words); assert.deepEqual(s.dialog().uncertain, [{ start: 0, end: 9 }]);
  s.reviewQuestion('Edited words'); assert.deepEqual(s.dialog().uncertain, []);
  s.cancelReview(); s.setStatus('starting'); assert.deepEqual(s.voiceWords, []);
});
