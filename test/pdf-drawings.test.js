import test from 'node:test';
import assert from 'node:assert/strict';
import { paintedPdfPaths, ruledPdfTables } from '../src/pdf-drawings.js';

const names = ['fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke', 'rawFillPath',
  'stroke', 'closeStroke', 'save', 'restore', 'paintFormXObjectBegin', 'paintFormXObjectEnd', 'beginGroup', 'endGroup',
  'transform', 'setLineWidth', 'setFillRGBColor', 'setStrokeRGBColor', 'setFillColorN', 'setStrokeColorN',
  'setFillTransparent', 'setStrokeTransparent', 'setGState', 'constructPath', 'endPath'];
const OPS = Object.fromEntries(names.map((name, i) => [name, i + 1]));
// Deliberately overbroad dependency bounds, as seen with reused paths in PDFs.
const bounds = { isEmpty: () => false, minX: () => 0, minY: () => 0, maxX: () => 1, maxY: () => 1 };
const paths = (commands, matrix) => paintedPdfPaths({ fnArray: commands.map(c => OPS[c[0]]), argsArray: commands.map(c => c.slice(1)) }, bounds, OPS, 600, 800, matrix);
const shape = (paint = 'fill') => ['constructPath', OPS[paint], [], [10, 20, 40, 60]];

test('clipping and pale paper paths do not masquerade as figures; dark strokes and restored fills do', () => {
  const result = paths([
    shape('endPath'), ['save'], ['setFillRGBColor', '#fdfdfb'], shape(),
    ['setStrokeRGBColor', '#000000'], shape('fillStroke'), ['restore'], shape(),
    ['save'], ['setGState', [['ca', 0], ['CA', 0]]], shape('fillStroke'), ['restore'],
    ['setFillTransparent'], shape(), ['setFillColorN', 'unknown-pattern'], shape(),
  ]);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { x: 9.5, y: 19.5, width: 31, height: 41 });
  assert.deepEqual(result[1], { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(result[2], result[1]);
});

test('reused path bounds follow each occurrence, nested form transforms, and page rotation', () => {
  const result = paths([
    shape(), ['save'], ['transform', 2, 0, 0, 2, 100, 40], shape(), ['restore'],
    ['paintFormXObjectBegin', [1, 0, 0, 1, 200, 0]], shape(), ['paintFormXObjectEnd'], shape(),
  ]);
  assert.deepEqual(result, [
    { x: 10, y: 20, width: 30, height: 40 },
    { x: 120, y: 80, width: 60, height: 80 },
    { x: 210, y: 20, width: 30, height: 40 },
    { x: 10, y: 20, width: 30, height: 40 },
  ]);
  assert.deepEqual(paths([shape()], [0, 1, -1, 0, 600, 0]), [{ x: 540, y: 10, width: 40, height: 30 }]);
});

test('aligned table rules protect rows; prose separates tables and two decorative rules are insufficient', () => {
  const rules = [100, 125, 200, 350, 375, 470].map(y => ({ x: 50, y, width: 400, height: 1 }));
  const prose = [{ x: 50, y: 260, width: 400, height: 12, text: 'An ordinary paragraph separates these two tables in the document.' }];
  const tables = ruledPdfTables(rules, prose, 600, 800);
  assert.equal(tables.length, 2); assert.equal(tables[0].y, 100); assert.equal(tables[0].height, 101);
  assert.equal(tables[1].y, 350); assert.equal(tables[1].height, 121);
  assert.deepEqual(ruledPdfTables([rules[0], rules[2]], prose, 600, 800), []);
});

test('normalized dark pages keep light vector strokes and ignore their paper fill', () => {
  const commands = [['setFillRGBColor', '#000000'], shape(), ['setStrokeRGBColor', '#ffffff'], shape('stroke')];
  const result = paintedPdfPaths({ fnArray: commands.map(c => OPS[c[0]]), argsArray: commands.map(c => c.slice(1)) },
    bounds, OPS, 600, 800, [1, 0, 0, 1, 0, 0], [0, 0, 0]);
  assert.equal(result.length, 1); assert.equal(result[0].width, 31);
});

test('a page-height gutter rule cannot join independent drawings across magazine columns', () => {
  assert.deepEqual(paths([['constructPath',OPS.fill,[],[300,0,301,800]]]), []);
  assert.equal(paths([['constructPath',OPS.fill,[],[300,100,301,300]]]).length, 1, 'short diagram strokes remain');
});

test('prose in the opposite column does not split a ruled table into isolated borders', () => {
  const rules = [100, 125, 210, 235].map(y => ({ x: 45, y, width: 240, height: 1 }));
  const prose = [{ x: 320, y: 155, width: 230, height: 14, text: 'A long sentence in the other column is unrelated to this table.' }];
  assert.deepEqual(ruledPdfTables(rules, prose, 600, 800), [{ x: 45, y: 100, width: 240, height: 136, kind: 'table' }]);
  assert.deepEqual(ruledPdfTables(rules, prose.map(t => ({ ...t, x: 45 })), 600, 800), []);
});

test('a tall table retains all rows between header and bottom rules, but a new table caption breaks the group', () => {
  const rules = [100, 125, 480].map(y => ({ x: 50, y, width: 500, height: 1 }));
  const cells = [160, 240, 340, 420].flatMap(y => [
    { x: 50, y, width: 80, height: 12, text: 'Study A' },
    { x: 180, y, width: 260, height: 12, text: 'A descriptive table cell with several words.' },
    { x: 480, y, width: 40, height: 12, text: '403' },
  ]);
  assert.deepEqual(ruledPdfTables(rules, cells, 600, 800), [{ x: 50, y: 100, width: 500, height: 381, kind: 'table' }]);
  assert.deepEqual(ruledPdfTables(rules, [...cells, { x: 50, y: 250, width: 150, height: 12, text: 'Table 2. Outcomes' }], 600, 800), []);
});

test('a nearly full-page table with sparse horizontal rules remains intact', () => {
  const rules = [100,130,700].map(y=>({x:50,y,width:500,height:1}));
  const cells = [160,300,450,650].flatMap(y=>[50,250,450].map(x=>({x,y,width:80,height:12,text:'A table cell'})));
  assert.deepEqual(ruledPdfTables(rules,cells,600,800),[{x:50,y:100,width:500,height:601,kind:'table'}]);
});
