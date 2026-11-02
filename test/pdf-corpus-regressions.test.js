import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfContentsEntries, markPdfContents } from '../src/pdf-contents.js';
import { reflowPdfBlock, joinPdfTextTails } from '../src/pdf-reflow.js';
import { scannedPdfFigures } from '../src/pdf-figures.js';
import { pdfGraphicFurnitureMasks, pdfPageNumberMasks } from '../src/pdf-furniture.js';
import { pdfBodySize, separatePdfAnnotations } from '../src/pdf-annotations.js';
import { pdfQuarterTurnNeeded, pdfOcrScore, pdfSourceTransform, pdfSourcePoint, pdfRomanStrokes } from '../src/pdf-orientation.js';
import { pdfWordGeometryNeedsOcr, restorePdfOcrMarkers, splitPdfOcrColumns } from '../src/pdf-text.js';
import { createPdfLayout, pdfAnchor, restorePdfAnchor, analyzePdfPage } from '../src/pdf-layout.js';
import { packPdfPreparation, unpackPdfPreparation } from '../src/pdf-cache.js';

const line = (text, x, y, width = 180, height = 16) => ({ text, x, y, width, height });
const block = lines => ({ kind: 'text', x: Math.min(...lines.map(t=>t.x)), y: Math.min(...lines.map(t=>t.y)),
  width: Math.max(...lines.map(t=>t.x+t.width))-Math.min(...lines.map(t=>t.x)),
  height: Math.max(...lines.map(t=>t.y+t.height))-Math.min(...lines.map(t=>t.y)), lines, text: lines.map(t=>t.text).join(' ') });

test('contents keep each title and folio together, remove leaders, and do not reinterpret data tables', () => {
  const text = Array.from({length:6},(_,i)=>[line(`${i+1}. Section heading`,50,100+i*30),line(': : : : :',280,100+i*30,180),line(`${40+i}`,520,100+i*30,30)]).flat();
  const entries = pdfContentsEntries(text,600); assert.equal(entries.length,6);
  const source = block(text); const marked = markPdfContents([source],entries)[0];
  const flowed = reflowPdfBlock(marked);
  assert.ok(flowed); assert.doesNotMatch(flowed.text, /: :/);
  for (let i=0;i<6;i++) assert.ok(flowed.text.includes(`${i+1}. Section heading — page ${40+i}`));
  assert.deepEqual(marked.lines,source.lines,'source geometry survives normalization');
  const table = text.map(t=>t.text.includes('heading')?{...t,text:'Model 200 300'}:t);
  assert.deepEqual(pdfContentsEntries(table,600),[]);
});

test('scanned contents retain the gap between titles and folios inside OCR line objects', () => {
  const text = [line('Contents', 50, 40), ...Array.from({ length: 6 }, (_, i) => {
    const title = line(`${i + 1}. Section heading`, 50, 100 + i * 30);
    const folio = line(`${40 + i}`, 520, title.y, 30);
    return { ...title, width: 500, text: `${title.text} ${folio.text}`, words: [title, folio] };
  })];
  const entries = pdfContentsEntries(text, 600);
  assert.equal(entries.length, 6);
  const marked = markPdfContents([block(text.slice(1))], entries)[0];
  assert.match(reflowPdfBlock(marked).text, /1\. Section heading — page 40/);
  assert.deepEqual(pdfContentsEntries(text.map(row => ({ ...row, words: undefined })), 600), [], 'a string alone cannot establish alignment');
});

test('scanned graph axes include detached tick labels without absorbing the following caption or paragraph', () => {
  const width=600,height=800,data=new Uint8ClampedArray(width*height*4).fill(255);
  const rect=(x,y,w,h)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)data.fill(0,(yy*width+xx)*4,(yy*width+xx)*4+3);};
  rect(100,210,2,230);rect(100,438,360,2);rect(220,462,45,12);
  rect(50,510,280,12);rect(50,550,500,12);
  const figures=scannedPdfFigures({width,height,data,text:[line('Education level',220,462,160,12),
    line('Figure 1: The signaling equilibrium.',50,510,280,12),line('The next paragraph remains ordinary text after the complete graph.',50,550,500,12)]});
  assert.ok(figures.some(b=>b.y<=210&&b.y+b.height>=474));
  assert.ok(figures.every(b=>b.y+b.height<510));
});

test('small publisher marks are removed with running furniture, while actual figures remain', () => {
  const logo={x:470,y:18,width:105,height:24}; const figure={x:60,y:190,width:400,height:180};
  const page={width:600,height:800,images:[logo,figure],text:[line('Journal publication accepted today.',50,75,450)]};
  const masks=pdfGraphicFurnitureMasks(page);assert.equal(masks.length,1);assert.ok(masks[0].y<logo.y);
  assert.deepEqual(pdfGraphicFurnitureMasks({...page,text:[line('Figure 1: A top-of-page inset',450,46,140)]}),[]);
});

test('word-level text establishes body size and trustworthy embedded markers recover OCR footnotes', () => {
  const body=Array.from({length:100},(_,i)=>line('ordinary',50+i%10*45,100+Math.floor(i/10)*22,42,16));
  const note=[{...line('® An explanatory note belongs after the section.',50,700,460,12),confidence:90,
    words:[{...line('®',50,700,5,6),confidence:20},{...line('An',60,700,20,12),confidence:96}]}];
  const repaired=restorePdfOcrMarkers(note,[line('4',50,699,5,8)]);
  assert.equal(repaired[0].noteMarker,'4');assert.match(repaired[0].text,/^4 An/);
  assert.equal(repaired[0].noteMarkerRaised,true);
  const p={width:600,height:800,text:[...body,...repaired],blocks:[block(body),block(repaired)]};
  assert.equal(pdfBodySize([p]),16);
  const result=separatePdfAnnotations(p,{bodySize:16});
  assert.equal(result.at(-1).annotation.number,'4');
  assert.equal(note[0].text[0],'®','original recognition is not mutated');
});

test('embedded note numbers joined to a citation repair the OCR marker without inventing a sequence', () => {
  const words=[line('1',50,700,7,5),line('(1916),',61,702,44,11),line('a citation.',112,702,110,11)];
  const recognized={...line('1 (1916), a citation.',50,700,180,13),confidence:90,words};
  const fixed=restorePdfOcrMarkers([recognized],[line('14(iqi6),',49,707,35,10)])[0];
  assert.equal(fixed.noteMarker,'14');assert.equal(fixed.noteMarkerRaised,true);assert.equal(fixed.text,'14 (1916), a citation.');
  assert.equal(restorePdfOcrMarkers([recognized],[])[0],recognized);
});

test('a single superscript note detaches from a body crop, and dense verified notes do not become a bibliography', () => {
  const body=Array.from({length:4},(_,i)=>line('A sustained body passage continues before its separately numbered note.',50,550+i*22,470,16));
  const note={...line('9 An explanatory note.',50,680,250,12),confidence:90,noteMarker:'9',noteMarkerRaised:true};
  let result=separatePdfAnnotations({width:600,height:800,blocks:[block([...body,note])]}, {bodySize:16});
  assert.equal(result.length,2);assert.equal(result[1].annotation.number,'9');
  const notes=Array.from({length:7},(_,i)=>({...line(`${10+i} Author, a brief explanatory citation.`,50,620+i*18,470,12),
    confidence:90,noteMarker:String(10+i),noteMarkerRaised:true}));
  const p={width:600,height:800,blocks:[block(body.map(t=>({...t,y:t.y-400}))),block(notes)]};
  result=separatePdfAnnotations(p,{bodySize:16});
  assert.deepEqual(result.filter(b=>b.annotation).map(b=>b.annotation.number),['10','11','12','13','14','15','16']);
  const ordinary={...p,blocks:[p.blocks[0],block(notes.map(({noteMarkerRaised,...t})=>t))]};
  assert.ok(separatePdfAnnotations(ordinary,{bodySize:16}).every(b=>!b.annotation),'normal-size citation markers do not override bibliography protection');
});

test('only heavily displaced word boxes trigger a new OCR pass', () => {
  const words=Array.from({length:160},(_,i)=>line('ordinary',50+i%10*46,100+Math.floor(i/10)*30,40,12));
  assert.equal(pdfWordGeometryNeedsOcr(words),false);
  assert.equal(pdfWordGeometryNeedsOcr(words.map((word,i)=>({...word,y:word.y+(i%2)*5}))),true);
});

test('OCR lines accidentally joined across a column gutter separate without losing words or splitting notes', () => {
  const words=[line('Left-column',50,100,100),line('continuation.',160,100,110),line('Right-column',310,100,100),line('beginning.',420,100,100)];
  const source={...line(words.map(w=>w.text).join(' '),50,100,470),words,confidence:95};
  const split=splitPdfOcrColumns([source],290);assert.equal(split.length,2);
  assert.deepEqual(split.flatMap(t=>t.words),words);assert.equal(split[0].text,'Left-column continuation.');
  assert.deepEqual(splitPdfOcrColumns([{...source,noteMarker:'1'}],290),[{...source,noteMarker:'1'}]);
  assert.deepEqual(splitPdfOcrColumns([source],200),[source],'a word crossing the boundary stays intact');
});

test('legacy caption separators and touching section titles are recognized without moving ordinary references', () => {
  const blocks=[block([line('2. Methods',50,100,160),line('A normal sentence follows the heading on the next line.',50,123,480)]),
    block([line('Figure 1 j Results of the model.',50,500,400)]),block([line('Figure 1 shows an ordinary reference in the body.',50,600,480)])];
  const result=separatePdfAnnotations({width:600,height:800,blocks},{bodySize:16});
  assert.equal(result[0].text,'2. Methods');assert.match(result[1].text,/normal sentence/);
  assert.equal(result[2].annotation.reference,'Figure 1');assert.equal(result[3].annotation,undefined);
});

test('hyphenated uppercase titles join, and asterisms and confident short OCR stay native', () => {
  const title=joinPdfTextTails([block([line('GENERALIZATION BEYOND OVERFIT-',50,100,460,18)]),block([line('TING ON SMALL ALGORITHMIC DATASETS',50,129,460,18)])]);
  assert.equal(title.length,1);assert.match(reflowPdfBlock(title[0]).text,/OVERFITTING/);
  assert.equal(reflowPdfBlock(block([line('***',50,100,30,12)])).text,'***');
  assert.ok(reflowPdfBlock(block([{...line('EDWIN MANSFIELD',50,100,180,16),confidence:96}])));
  assert.equal(reflowPdfBlock(block([{...line('Uncertain',50,100,180,16),confidence:40}])),null);
});

test('sideways OCR is detected by geometry and scored against upright English, not just character count', () => {
  const sideways=Array.from({length:8},(_,i)=>({...line('An unreliable string repeated through the rotated table.',100+i*30,100,15,450),confidence:25}));
  assert.equal(pdfQuarterTurnNeeded(sideways),true);
  const upright=sideways.map(t=>({...t,width:450,height:15,confidence:95}));
  assert.equal(pdfQuarterTurnNeeded(upright),false);assert.ok(pdfOcrScore(upright).score>pdfOcrScore(sideways).score);
  assert.equal(pdfPageNumberMasks({width:600,height:800,text:[line('218',80,40,30,12),...sideways]}).length,1);
});

test('rotation transforms preserve source bookmarks and survive preparation cache round trips', () => {
  const sourceTransform=pdfSourceTransform({transform:[1,0,0,-1,0,800]},{transform:[0,1,1,0,0,0]});
  const crop={...block([line('Upright rotated table',100,120,500,180)]),kind:'figure',turn:90,pageRotation:90,sourceTransform};
  const point=pdfSourcePoint(crop,{x:200,y:180});assert.deepEqual(pdfSourcePoint(crop,point,true),{x:200,y:180});
  const layout=createPdfLayout([{number:1,blocks:[crop,{...crop,y:400}]}]);
  const anchor=pdfAnchor(layout,50);assert.equal(restorePdfAnchor(layout,anchor),50);
  const restored=unpackPdfPreparation(JSON.parse(JSON.stringify(packPdfPreparation(layout,new Map(),new Map([[1,1]]))))).layout;
  assert.deepEqual(restored.blocks[0].sourceTransform,sourceTransform);assert.equal(restorePdfAnchor(restored,anchor),50);
  const oldAnchor={pdf:{page:1,...pdfSourcePoint(crop,{x:350,y:180})},percent:0};
  assert.equal(restorePdfAnchor(layout,oldAnchor),(180-crop.y)*layout.blocks[0].scale);
  const damaged=packPdfPreparation(layout,new Map(),new Map([[1,1]]));
  damaged.layout.blocks[0].sourceTransform=[0,0,0,0,0,0];
  assert.throws(()=>unpackPdfPreparation(damaged),/incomplete/);
});

test('Roman-I correction requires separate matching serif glyphs, not a row of digits or an arbitrary mark', () => {
  const width=70,height=50,pixels=new Uint8ClampedArray(width*height*4).fill(255);
  const rect=(x,y,w,h)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)pixels.fill(0,(yy*width+xx)*4,(yy*width+xx)*4+3);};
  for(const x of [10,35]) {rect(x,10,14,3);rect(x+6,13,3,24);rect(x,37,14,3);}
  assert.equal(pdfRomanStrokes(pixels,width,height),'II');
  rect(10,10,14,30);assert.equal(pdfRomanStrokes(pixels,width,height),null);
});

test('a few scan letters entering the scored gutter do not send the reader into the right column early', () => {
  const width=600,height=800,data=new Uint8ClampedArray(width*height*4).fill(255),text=[];
  const rect=(x,y,w,h)=>{for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)data.fill(0,(yy*width+xx)*4,(yy*width+xx)*4+3);};
  for(let row=0;row<32;row++) {
    const y=100+row*18;
    for(const [x,prefix] of [[50,'Left'],[310,'Right']]) {
      for(let word=0;word<6;word++)rect(x+word*40,y,30,8);
      text.push(line(`${prefix} row ${row} continues the source paragraph.`,x,y,240,12));
    }
    if(row===27)rect(282,y,15,8);
  }
  const page=analyzePdfPage({width,height,data,text,images:[{x:0,y:0,width,height}]});
  const flow=page.blocks.map(b=>b.text).join(' ');
  assert.ok(page.columns);assert.ok(flow.indexOf('Left row 31')<flow.indexOf('Right row 0'));
});

test('hand-drawn frames around printed paragraphs do not become scanned figures', () => {
  const width = 600, height = 800, data = new Uint8ClampedArray(width * height * 4).fill(255);
  const rect = (x,y,w,h) => { for(let yy=y;yy<y+h;yy++) for(let xx=x;xx<x+w;xx++) data.fill(0,(yy*width+xx)*4,(yy*width+xx)*4+3); };
  const text = Array.from({length:8},(_,i)=>({...line('This ordinary printed paragraph remains readable under its hand-drawn lines.',100,150+i*35,400,20),confidence:96}));
  for(const row of text) { for(let x=100;x<500;x+=20) rect(x,row.y,12,18);rect(100,row.y+23,400,2); }
  rect(95,145,2,285);
  assert.deepEqual(scannedPdfFigures({width,height,data,text}),[]);
  // A connected interior plot is unexplained by those OCR words.
  rect(200,410,2,150);rect(200,558,280,2);
  assert.ok(scannedPdfFigures({width,height,data,text}).length>0);
});
