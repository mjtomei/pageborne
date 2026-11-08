import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePdfPage, createPdfLayout, groupPdfDrawings, pdfPageTurn, pdfAnchor, restorePdfAnchor, PDF_SCREEN } from '../src/pdf-layout.js';
import { readLocalFile, localSnapshot } from '../src/library.js';
import { bytesToBase64, base64ToBytes } from '../src/binary.js';
import { GlassesDisplay, gray4, pdfPageDefinition } from '../src/glasses.js';
import { PhoneLibrary } from '../src/phone-storage.js';

function page(width = 600, height = 800) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const text = []; const images = [];
  const rectangle = (x, y, w, h) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const i = (yy * width + xx) * 4; data[i] = data[i + 1] = data[i + 2] = 0;
  } };
  return { width, height, data, text, images, rectangle,
    line(label, x, y, w = 200) { text.push({ text: label, x, y, width: w, height: 10 }); rectangle(x, y, w, 8); },
    paragraph(label, x, y, w = 200, lines = 4) { for (let i = 0; i < lines; i++) this.line(`${label}-${i}`, x, y + i * 14, w); },
  };
}

test('PDF mixed columns retain full-width sections and read each column top to bottom', () => {
  const p = page(); p.paragraph('Intro', 50, 40, 500, 3);
  p.paragraph('LeftA', 50, 130); p.paragraph('LeftB', 50, 210);
  p.paragraph('RightA', 350, 130); p.paragraph('RightB', 350, 210);
  p.rectangle(50, 310, 500, 90); p.images.push({ x: 50, y: 310, width: 500, height: 90 });
  p.paragraph('LeftC', 50, 450); p.paragraph('RightC', 350, 450);
  p.paragraph('Conclusion', 50, 600, 500, 3);
  const result = analyzePdfPage(p); assert.equal(result.columns, true);
  const text = result.blocks.map(b => b.text).join('\n');
  let last = -1;
  for (const label of ['Intro', 'LeftA', 'LeftB', 'RightA', 'RightB', 'LeftC', 'RightC', 'Conclusion']) {
    const at = text.indexOf(label); assert.ok(at > last, `${label} is in reading order: ${text}`); last = at;
  }
  assert.ok(result.blocks.some(b => b.y <= 310 && b.y + b.height >= 400 && b.width >= 500), 'full-width figure remains intact');
  assert.ok(result.bounds.x >= 48 && result.bounds.width <= 504, 'side margins cropped');
  assert.equal(analyzePdfPage({ ...p, mode: 'single' }).columns, false);
});

test('white padding around an embedded chart does not split its disconnected bars into images', () => {
  const p = page();
  p.images.push({ x: 40, y: 40, width: 520, height: 410 });
  for (const [y, width] of [[60, 400], [130, 200], [230, 240], [340, 440], [420, 300]]) p.rectangle(65, y, width, 15);
  p.paragraph('BelowChart', 50, 500, 480);
  for (const mode of ['auto', 'single']) {
    const result = analyzePdfPage({ ...p, mode });
    const images = result.blocks.filter(b => b.kind === 'figure');
    assert.equal(images.length, 1);
    assert.ok(images[0].y <= 60 && images[0].y + images[0].height >= 435);
    assert.ok(!images[0].text.includes('BelowChart'));
  }
});

test('magazine rules around a two-column brief do not turn its contents into a figure', () => {
  const p = page(); p.rectangle(50, 70, 500, 2); p.rectangle(50, 600, 500, 2);
  p.paragraph('LeftBrief is a full sentence in this column', 50, 110, 220, 18);
  p.paragraph('RightBrief is a full sentence in this column', 330, 110, 220, 22);
  p.images.push({ x: 50, y: 70, width: 500, height: 532, kind: 'drawing' });
  const result = analyzePdfPage(p);
  assert.ok(result.columns);
  const lines = result.blocks.flatMap(b => b.lines).map(t => t.text);
  assert.ok(lines.findIndex(t => t.startsWith('LeftBrief') && t.endsWith('-17')) < lines.findIndex(t => t.startsWith('RightBrief')));
});

test('three magazine columns preserve body order and separately numbered two-column figures', () => {
  const p = page(900, 1200);
  p.paragraph('Left column prose with enough words', 50, 80, 240, 60);
  p.paragraph('Middle column prose with enough words', 320, 80, 240, 12);
  p.paragraph('Right column prose with enough words', 590, 80, 240, 12);
  for (const [i,y] of [300,530,760].entries()) {
    p.images.push({ x:320,y,width:510,height:200,kind:'drawing' });
    p.rectangle(320,y,510,2); p.rectangle(320,y+198,510,2);
    p.line(`Figure ${i+1}: A separate numbered diagram`,330,y+10,400);
    p.rectangle(360,y+50,300,110);
  }
  const result = analyzePdfPage(p), lines = result.blocks.flatMap(b=>b.lines);
  assert.equal(lines.length, p.text.length, 'every source line appears once');
  assert.ok(lines.findIndex(t=>t.text.endsWith('words-59')) < lines.findIndex(t=>t.text.startsWith('Middle')));
  assert.ok(lines.findIndex(t=>t.text.startsWith('Middle') && t.text.endsWith('-11')) < lines.findIndex(t=>t.text.startsWith('Right')));
  const figures = result.blocks.filter(b=>b.kind === 'figure');
  assert.equal(figures.length, 3);
  assert.ok(figures.every(b=>b.width>=510 && b.height>=200 && b.height<230));
  assert.equal(result.split, null, 'a binary OCR split must not be applied to three columns');
});

test('a large magazine introduction does not hide a smaller parallel prose column as marginalia', () => {
  const p = page(900,1200);
  for (let i=0;i<20;i++) {
    p.text.push({ x:55,y:500+i*25,width:510,height:22,text:'An introduction in larger type with a long line of prose.' });
    p.rectangle(55,500+i*25,510,20);
    p.line('A smaller body column with readable prose.',590,500+i*25,240);
  }
  const result=analyzePdfPage(p);
  assert.equal(result.blocks.flatMap(b=>b.lines).length,p.text.length);
  assert.ok(!result.marginMasks.length);
});

test('a thin gutter rule does not stretch a short magazine pull quote into a full-height image', () => {
  const p=page(900,1200);
  p.paragraph('Left column prose with enough words',50,80,240,65);
  p.paragraph('Middle pull quote with several words',320,130,240,10);
  p.paragraph('Right column prose with enough words',590,80,240,65);
  p.rectangle(305,80,1,1040); p.rectangle(575,80,1,1040);
  for (const y of [80,300]) { p.rectangle(320,y,120,30); p.images.push({x:320,y,width:120,height:30,kind:'drawing'}); }
  const result=analyzePdfPage(p);
  assert.equal(result.blocks.flatMap(b=>b.lines).length,p.text.length);
  assert.ok(result.blocks.filter(b=>b.kind==='figure').every(b=>b.height<100));
});

test('disconnected panels stay one figure and both caption columns precede the body', () => {
  const p = page();
  for (const box of [{ x: 80, y: 50, width: 440, height: 90 },
    { x: 90, y: 180, width: 160, height: 90 }, { x: 310, y: 180, width: 210, height: 90 }]) {
    p.rectangle(box.x, box.y, box.width, box.height); p.images.push(box);
  }
  p.paragraph('CaptionLeft', 50, 305, 220, 4); p.paragraph('CaptionRight', 330, 305, 220, 4);
  p.paragraph('BodyLeft', 50, 430, 220, 18); p.paragraph('BodyRight', 330, 430, 220, 18);
  const result = analyzePdfPage(p);
  assert.ok(result.blocks.some(b => b.x <= 80 && b.x + b.width >= 520 && b.y <= 50 && b.y + b.height >= 270));
  const lines = result.blocks.flatMap(b => b.lines).map(t => t.text);
  assert.ok(lines.indexOf('CaptionLeft-3') < lines.indexOf('CaptionRight-0'));
  assert.ok(lines.indexOf('CaptionRight-3') < lines.indexOf('BodyLeft-0'));
  assert.ok(lines.indexOf('BodyLeft-17') < lines.indexOf('BodyRight-0'));
});

test('a shared caption joins side-by-side plots, while separate captions retain column figures', () => {
  const make = shared => {
    const p = page();
    for (const x of [50, 330]) {
      p.rectangle(x, 50, 220, 100); p.images.push({ x, y: 50, width: 220, height: 100 });
    }
    if (shared) p.line('Figure 1: A shared caption describing both panels in this diagram.', 50, 170, 500);
    else { p.line('Figure 1: Left plot', 50, 170, 220); p.line('Figure 2: Right plot', 330, 170, 220); }
    p.paragraph('LeftBody', 50, 240, 220, 24); p.paragraph('RightBody', 330, 240, 220, 24);
    return analyzePdfPage(p);
  };
  const whole = b => b.x <= 50 && b.x + b.width >= 550 && b.y <= 50 && b.y + b.height >= 150;
  assert.ok(make(true).blocks.some(whole), 'shared figure stays intact across the gutter');
  assert.ok(!make(false).blocks.some(whole), 'unrelated column figures are not combined');
});

test('PDF single columns, scan-only columns and empty pages have conservative layouts', () => {
  const one = page(); one.paragraph('Single', 60, 50, 480, 25);
  assert.equal(analyzePdfPage(one).columns, false);
  const scan = page(); scan.paragraph('Left', 60, 50, 200, 20); scan.paragraph('Right', 340, 50, 200, 20);
  assert.equal(analyzePdfPage({ ...scan, text: [] }).columns, true);
  assert.deepEqual(analyzePdfPage(page()).blocks, []);
});

test('prose beside a narrow caption does not merge unrelated column figures', () => {
  const p = page();
  for (const x of [50,330]) {
    p.rectangle(x,50,220,100); p.images.push({x,y:50,width:220,height:100});
  }
  p.line('An unrelated sentence on the left.',50,170,220);
  p.line('Figure 2: Right plot.',330,170,220);
  p.paragraph('LeftBody',50,240,220,24); p.paragraph('RightBody',330,240,220,24);
  const result = analyzePdfPage(p);
  assert.ok(!result.blocks.some(b => b.kind === 'figure' && b.width > 400));
});

test('narrow column gutters preserve column order instead of splicing lines together', () => {
  const p = page();
  p.paragraph('Left', 50, 80, 245, 30); p.paragraph('Right', 305, 80, 245, 30);
  const result = analyzePdfPage(p);
  assert.equal(result.columns, true);
  assert.ok(result.split > 295 && result.split < 305);
  const ordered = result.blocks.map(b => b.text).join(' ');
  assert.ok(ordered.indexOf('Left-29') < ordered.indexOf('Right-0'));
  assert.equal(result.blocks.length, 2);
});

test('connected vector paths including thin arrows remain a whole diagram', () => {
  const paths = [{ x: 50, y: 100, width: 100, height: 80 }, { x: 150, y: 140, width: 80, height: 1 },
    { x: 230, y: 100, width: 100, height: 80 }, { x: 450, y: 500, width: 40, height: 40 }];
  const grouped = groupPdfDrawings(paths, 600, 800);
  assert.deepEqual(grouped, [{ x: 50, y: 100, width: 280, height: 80 }, paths[3]]);
  const p = page(); for (const b of paths) p.rectangle(b.x, b.y, b.width, b.height);
  p.images = grouped;
  assert.ok(analyzePdfPage(p).blocks.some(b => b.x <= 50 && b.x + b.width >= 330 && b.y <= 100 && b.y + b.height >= 180));
});

test('landscape scans ignore narrow binding shadows and read the left page before the right', () => {
  const p = page(600, 400);
  p.paragraph('Left', 45, 50, 215, 20); p.paragraph('Right', 340, 50, 215, 20);
  p.rectangle(297, 2, 6, 395); p.text = [];
  const result = analyzePdfPage(p);
  assert.equal(result.columns, true); assert.equal(result.blocks.length, 2);
  assert.ok(result.blocks[0].x + result.blocks[0].width < 290);
  assert.ok(result.blocks[1].x > 310);
});

test('spanning text keeps its descenders in the same crop', () => {
  const p = page(); p.paragraph('Left', 50, 120, 245, 20); p.paragraph('Right', 305, 120, 245, 20);
  p.line('Heading', 280, 45, 200); p.text.at(-1).height = 14;
  p.rectangle(330, 54, 5, 4);
  const result = analyzePdfPage(p); const heading = result.blocks.find(b => b.text.includes('Heading'));
  assert.ok(heading.y + heading.height >= 58, 'descender pixels stay attached to the line');
});

test('PDF anchors restore exact blocks even when neighboring source bounds overlap', () => {
  const layout = createPdfLayout([{ number: 1, blocks: [
    { x: 50, y: 50, width: 500, height: 100, text: 'First', lines: [] },
    { x: 50, y: 149, width: 500, height: 100, text: 'Second', lines: [] },
  ] }]);
  const y = layout.blocks[1].y;
  assert.equal(restorePdfAnchor(layout, pdfAnchor(layout, y)), y);
});

test('outside arXiv stamps do not widen body crops; vertical axis labels remain visible', () => {
  const make = label => {
    const p = page(); p.paragraph('Body', 100, 120, 400, 20);
    p.text.push({ x: 20, y: 150, width: 16, height: 240, text: label }); p.rectangle(20, 150, 16, 240);
    return analyzePdfPage(p);
  };
  const cropped = make('arXiv:1234.5678v1 [cs.AI] 1 Jan 2026');
  assert.ok(cropped.blocks.every(b => b.x >= 99));
  assert.ok(cropped.blocks.map(b => b.text).join(' ').includes('Body-19'));
  const labeled = make('Pressure (kPa)');
  assert.ok(labeled.bounds.x <= 20);
  assert.ok(labeled.blocks.some(b => b.text.includes('Pressure')));
});

test('outside notes are optional while body text and bottom footnotes stay intact', () => {
  const p = page(); p.paragraph('Body', 130, 70, 340, 30);
  p.paragraph('LeftNote', 30, 80, 70, 4); p.paragraph('RightNote', 500, 240, 65, 3);
  p.paragraph('Footnote', 130, 570, 340, 3);
  // A scan ornament has no OCR text, but belongs to the same outside lane.
  p.rectangle(25, 135, 80, 3);
  const removed = analyzePdfPage(p); const kept = analyzePdfPage({ ...p, keepMarginNotes: true });
  const visible = removed.blocks.flatMap(b => b.lines).map(t => t.text);
  assert.equal(visible.filter(t => t.startsWith('Body')).length, 30);
  assert.equal(visible.filter(t => t.startsWith('Footnote')).length, 3);
  assert.ok(!visible.some(t => /Note/.test(t)));
  assert.ok(removed.blocks.every(b => b.x >= 129 && b.x + b.width <= 471));
  assert.equal(kept.blocks.flatMap(b => b.lines).filter(t => /Note/.test(t.text)).length, 7);
  assert.deepEqual(kept.marginMasks, []);
  assert.ok(kept.bounds.width > removed.bounds.width + 150);
});

test('kept notes shrink only the affected lines and preserve short paragraph endings', () => {
  const p = page(); p.paragraph('Body', 130, 70, 340, 24);
  p.paragraph('MarginNote', 500, 126, 65, 3);
  p.line('Short ending', 130, 406, 100);
  const kept = analyzePdfPage({ ...p, keepMarginNotes: true });
  const noteBlock = kept.blocks.find(b => b.text.includes('MarginNote'));
  const after = kept.blocks.find(b => b.text.includes('Body-23'));
  assert.ok(noteBlock.width > 430); assert.ok(after.width < 350);
  assert.ok(after.text.includes('Short ending'), 'short last line keeps the surrounding body size');
  const body = kept.blocks.flatMap(b => b.lines).filter(t => t.text.startsWith('Body-'));
  assert.equal(body.length, 24); assert.equal(new Set(body).size, 24);
  assert.ok(!analyzePdfPage(p).blocks.some(b => b.text.includes('MarginNote')));
});

test('an outside header page number does not set the width of all following body lines', () => {
  const p = page(); p.line('517', 50, 56, 25); p.line('Header', 240, 56, 100);
  p.paragraph('Body', 130, 70, 340, 24);
  const kept = analyzePdfPage({ ...p, keepMarginNotes: true });
  assert.notEqual(kept.blocks.find(b => b.text.includes('517')), kept.blocks.find(b => b.text.includes('Body-23')));
  assert.ok(kept.blocks.find(b => b.text.includes('Body-23')).width < 350);
  const removed = analyzePdfPage(p);
  assert.ok(!removed.blocks.some(b => b.text.includes('517')));
  assert.equal(removed.blocks.flatMap(b => b.lines).filter(t => t.text.startsWith('Body-')).length, 24);
});

test('short body words and slightly misplaced OCR edges do not leave holes in margin removal', () => {
  const p = page(); p.paragraph('Body', 150, 70, 313, 11); p.paragraph('LaterBody', 150, 310, 313, 11);
  for (const [x, width, word] of [[150, 80, 'Words'], [238, 8, 'in'], [254, 90, 'the body'], [352, 8, 'is'], [368, 95, 'complete']]) p.line(word, x, 260, width);
  p.paragraph('SideNote', 50, 84, 65, 3); p.line('NoteTail', 50, 260, 65);
  p.line('Slight OCR intrusion', 142, 238, 321); p.line('NoteBesideIntrusion', 50, 238, 65);
  const result = analyzePdfPage(p); const lines = result.blocks.flatMap(b => b.lines);
  assert.ok(!lines.some(t => /Note/.test(t.text)));
  for (const value of ['in', 'is', 'complete', 'Slight OCR intrusion', 'LaterBody-10']) assert.ok(lines.some(t => t.text === value), value);
});

test('a bottom footnote number beside its text is not an outside page number', () => {
  const p = page(); p.paragraph('Body', 150, 70, 340, 30);
  p.line('Footnote remains present', 150, 570, 340); p.line('1', 130, 570, 8);
  const result = analyzePdfPage(p);
  assert.ok(result.blocks.some(b => b.lines.some(t => t.text === '1')));
});

test('notes within the body crop padding are removed without erasing the adjacent body', () => {
  const p = page(); p.paragraph('Body', 130, 70, 340, 30);
  p.paragraph('LeftNote', 60, 84, 67, 4); p.paragraph('RightNote', 474, 252, 65, 4);
  const removed = analyzePdfPage(p); const lines = removed.blocks.flatMap(b => b.lines);
  assert.equal(lines.filter(t => t.text.startsWith('Body')).length, 30);
  assert.ok(!lines.some(t => t.text.includes('Note')));
  assert.ok(removed.blocks.every(b => b.x >= 129 && b.x + b.width <= 471));
  for (const body of p.text.filter(t => t.text.startsWith('Body'))) {
    assert.ok(!removed.marginMasks.some(m => m.x < body.x + body.width && m.x + m.width > body.x
      && m.y < body.y + body.height && m.y + m.height > body.y), 'mask keeps every adjacent body edge');
  }
  const kept = analyzePdfPage({ ...p, keepMarginNotes: true });
  assert.equal(kept.blocks.flatMap(b => b.lines).filter(t => t.text.includes('Note')).length, 8);
});

test('margin inference joins word fragments and protects figures and wider sections', () => {
  const p = page();
  for (let y = 60; y <= 550; y += 16) {
    for (let x = 140; x <= 410; x += 45) p.line('BodyWord', x, y, 36);
  }
  p.paragraph('SideNote', 35, 65, 70, 4);
  p.line('WiderHeading', 35, 25, 530);
  p.rectangle(25, 610, 550, 100); p.images.push({ x: 25, y: 610, width: 550, height: 100 });
  p.line('FigureLabel', 35, 630, 70); p.line('FigureLabel', 35, 650, 70);
  const result = analyzePdfPage(p); const lines = result.blocks.flatMap(b => b.lines);
  assert.ok(!lines.some(t => t.text.startsWith('SideNote')));
  assert.equal(lines.filter(t => t.text === 'BodyWord').length, 217);
  assert.equal(lines.filter(t => t.text === 'FigureLabel').length, 2);
  assert.ok(lines.some(t => t.text === 'WiderHeading'));
  assert.ok(result.blocks.some(b => b.x <= 25 && b.x + b.width >= 575 && b.y <= 610 && b.y + b.height >= 710));
});

test('opposite-margin scan specks do not widen crops, but isolated text there is retained', () => {
  const p = page(); p.paragraph('Body', 130, 70, 340, 30); p.paragraph('Note', 500, 80, 65, 4);
  p.rectangle(12, 180, 1, 1); p.line('Marker', 45, 600, 40);
  const result = analyzePdfPage(p);
  assert.ok(result.blocks.find(b => b.text.includes('Body')).x >= 129);
  assert.ok(result.blocks.some(b => b.text.includes('Marker')));
});

test('abstract margin notes do not hide short lines when the page changes to two body columns', () => {
  const p = page(); p.paragraph('Abstract', 250, 50, 300, 20);
  p.paragraph('DatesInMargin', 50, 65, 80, 4);
  p.paragraph('LeftBody', 50, 430, 220, 12); p.line('ShortBodyEnding', 50, 600, 100);
  p.paragraph('RightBody', 350, 430, 200, 12);
  const result = analyzePdfPage(p); const text = result.blocks.map(b => b.text).join(' ');
  assert.ok(!text.includes('DatesInMargin'));
  assert.ok(text.includes('ShortBodyEnding'));
  assert.equal(result.blocks.flatMap(b => b.lines).filter(t => t.text.startsWith('LeftBody')).length, 12);
});

test('a narrow second column and uncertain textless marginalia are retained', () => {
  const p = page(); p.paragraph('WideColumn', 40, 60, 300, 40); p.paragraph('NarrowColumn', 385, 60, 100, 40);
  assert.deepEqual(analyzePdfPage(p).marginMasks, []);
  const scan = { ...p, text: [] };
  assert.deepEqual(analyzePdfPage(scan).marginMasks, []);
  const stamp = page(); stamp.paragraph('Body', 140, 100, 320, 8);
  stamp.rectangle(25, 100, 10, 220); stamp.text.push({ text: 'arXiv: test', x: 25, y: 100, width: 10, height: 220 });
  assert.ok(analyzePdfPage({ ...stamp, keepMarginNotes: true }).blocks.some(b => b.text.includes('arXiv:')));
});

test('narrow paragraphs fill the width and moderate figures fit the screen without enlarging page numbers', () => {
  const p = page(); p.paragraph('Narrow', 100, 80, 170);
  p.rectangle(100, 250, 160, 100); p.images.push({ x: 100, y: 250, width: 160, height: 100 });
  p.line('1', 290, 700, 6);
  const layout = createPdfLayout([{ number: 1, ...analyzePdfPage(p) }]);
  const body = layout.blocks.find(b => b.text.includes('Narrow'));
  const figure = layout.blocks.find(b => b.sourceY >= 245 && b.sourceY <= 250);
  assert.equal(body.width * body.scale, 576); assert.ok(body.scale > 2);
  assert.equal(figure.drawHeight, PDF_SCREEN); assert.ok(figure.width * figure.scale >= 288); assert.ok(figure.keepTogether);
  assert.ok(layout.blocks.find(b => b.text === '1').scale <= 2);
  const mark = pdfAnchor(layout, body.y + 100);
  body.scale *= 1.5;
  assert.ok(Math.abs(restorePdfAnchor(layout, mark) - body.y - 150) < 1e-6, 'saved source position follows new magnification');
});

test('outlined body glyphs retain paragraphs and a consistent size on short last lines', () => {
  const p = page(); p.line('Small toolbar text', 50, 20, 180); p.text[0].height = 6;
  for (let i = 0; i < 12; i++) p.rectangle(100, 120 + i * 24, i === 11 ? 150 : 400, 16);
  const result = analyzePdfPage(p);
  const body = result.blocks.filter(b => b.y >= 100);
  assert.equal(body.length, 1, 'short final line stays with its paragraph');
  assert.ok(body[0].height >= 280);
});

test('PDF paging fits images on separate panes and restores image positions', () => {
  const layout = createPdfLayout([{ number: 1, blocks: [100, 120, 700, 50].map((height, i) => ({ x: 50, y: i * 800 + 20, width: 576, height, text: `Block ${i}`, lines: [] })) }]);
  assert.equal(pdfPageTurn(layout, 0, 1), layout.blocks[1].y, 'next image begins its own pane');
  let end = 0;
  for (const y of layout.pages) { assert.ok(y <= end + 12); end = y + PDF_SCREEN; }
  assert.ok(end >= layout.height); assert.equal(layout.pages.at(-1), layout.maxY);
  const middle = layout.blocks[2].y + 100;
  assert.equal(restorePdfAnchor(layout, pdfAnchor(layout, middle)), middle);
  assert.ok(pdfPageTurn(layout, middle, 1) > middle);
});

test('PDF binary imports and phone snapshots preserve every byte and type', async () => {
  const data = new Uint8Array(180000); for (let i = 0; i < data.length; i++) data[i] = i % 256;
  data.set(new TextEncoder().encode('%PDF-1.7\n'));
  assert.deepEqual(base64ToBytes(bytesToBase64(data)), data);
  const saved = await readLocalFile(new File([data], 'figure.pdf'));
  assert.equal(saved.format, 'pdf'); assert.equal(saved.bytes, data.length);
  assert.deepEqual(base64ToBytes(localSnapshot({ documents: [saved] }).documents[0].content), data);
  assert.equal(localSnapshot({ documents: [saved] }).documents[0].format, 'pdf');
  await assert.rejects(readLocalFile(new File(['not a PDF'], 'bad.pdf')), /PDF header/);
});

test('PDF image tiles cover the native reading area with valid Gray4 encoding', () => {
  const page = pdfPageDefinition(); assert.equal(page.imageObject.length, 4);
  assert.equal(page.textObject.filter(t => t.isEventCapture === 1).length, 1);
  assert.equal(new Set([...page.imageObject, ...page.textObject].map(c => c.zOrderIndex)).size, 7);
  assert.deepEqual(gray4(new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])), new Uint8Array([15]));
  assert.equal(page.imageObject.reduce((sum, tile) => sum + tile.width * tile.height, 0), 576 * 258);
  assert.equal(Math.min(...page.imageObject.map(tile => tile.xPosition)), 0);
  assert.equal(Math.max(...page.imageObject.map(tile => tile.xPosition + tile.width)), 576);
});

test('native phone storage restores PDF bytes and format without a browser cache', async () => {
  const values = new Map(); const kv = { get: async key => values.get(key) || '', set: async (key, value) => { values.set(key, value); } };
  const store = new PhoneLibrary(kv); await store.read();
  const bytes = new TextEncoder().encode('%PDF-1.7\n' + 'binary data '.repeat(20000));
  await store.save(await readLocalFile(new File([bytes], 'kept.pdf')));
  const doc = (await new PhoneLibrary(kv).read()).documents[0];
  assert.equal(doc.format, 'pdf'); assert.deepEqual(base64ToBytes(doc.content), bytes);
});

test('a PDF frame is accepted only after four serial tiles, and switching to Markdown rebuilds once', async () => {
  const previousWindow = globalThis.window; globalThis.window = { addEventListener() {} };
  try {
    const calls = []; let inflight = 0; let release;
    const display = new GlassesDisplay({ onStatus() {}, onAction() {}, diagnostics: { log() {} } });
    display.ready = true;
    display.bridge = {
      async rebuildPageContainer(page) { calls.push(page.imageObject ? 'pdf' : 'text'); return true; },
      async updateImageRawData(data) {
        assert.equal(++inflight, 1); calls.push(data.containerID);
        assert.equal(data.imageData.length, 288 * 129 / 2);
        if (data.containerID === 13) await new Promise(resolve => { release = resolve; });
        inflight--; return 'success';
      },
      async textContainerUpgrade() { return true; },
    };
    const layout = createPdfLayout([{ number: 1, blocks: [{ x: 0, y: 0, width: 552, height: 900, lines: [], text: 'Diagram' }] }]);
    const frame = { layout, y: 0, mode: 'page', speed: 30, bitmap: { getContext: () => ({ getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }) }) } };
    const sending = display.send(frame);
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(display.acceptedFrame, undefined); release(); await sending;
    assert.equal(display.acceptedFrame, frame);
    await display.send(frame); assert.deepEqual(calls, ['pdf', 10, 11, 12, 13], 'same pixels are not resent for status-only changes');
    await display.send({ ...frame, mode: 'auto' });
    assert.deepEqual(calls, ['pdf', 10, 11, 12, 13], 'identical tiles are retained across mode/position changes');
    const changedBitmap = { getContext: () => ({ getImageData: (x, y, w, h) => {
      const data = new Uint8ClampedArray(w * h * 4); if (x && y) data.fill(255); return { data };
    } }) };
    release = null; const changingMode = display.send({ ...frame, y: 27, mode: 'auto', bitmap: changedBitmap });
    while (!release) await new Promise(resolve => setTimeout(resolve, 0));
    release(); await changingMode;
    assert.deepEqual(calls, ['pdf', 10, 11, 12, 13, 13], 'only the changed tile is transmitted');
    await display.send({ layout, nativePdf: { content: 'Native PDF prose', start: 0, end: 1 }, y: 0, mode: 'page', speed: 30 });
    assert.equal(calls.at(-1), 'text');
    assert.equal(display.lastAccepted.renderer, 'native-text');
    assert.equal(display.sent.body, 'Native PDF prose');
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; }
});
