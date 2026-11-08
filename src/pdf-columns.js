// Repeated text edges provide stronger evidence than the page midpoint for
// magazine layouts with three columns or a wide introduction beside a sidebar.
export function pdfColumnRegions(text, images, bounds, lineHeight) {
  const groups = [];
  const median = values => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
  for (const box of text.filter(t => t.width >= bounds.width * .12 && t.text.trim().length >= 12 && t.height >= 7
    && !images.some(b => t.x >= b.x-2 && t.x+t.width <= b.x+b.width+2 && t.y >= b.y-2 && t.y+t.height <= b.y+b.height+2))
    .sort((a,b)=>a.x-b.x)) {
    let group = groups.find(g => Math.abs(g.x-box.x) <= lineHeight * .8);
    if (!group) { group = { x: box.x, boxes: [] }; groups.push(group); }
    group.boxes.push(box);
  }
  let columns = groups.filter(g => g.boxes.length >= 6).map(g => ({
    x: median(g.boxes.map(b=>b.x)), right: g.boxes.map(b=>b.x+b.width).sort((a,b)=>a-b)[Math.floor((g.boxes.length-1)*.9)], count: g.boxes.length,
  })).sort((a,b)=>a.x-b.x);
  columns = columns.filter(c => !columns.some(other => other !== c && other.x < c.x && other.right >= c.right-lineHeight));
  if (columns.length < 2 || columns.length > 4) return null;
  const cuts = [];
  for (let i=1;i<columns.length;i++) {
    const a=columns[i-1],b=columns[i];
    // A ragged column's longest lines and decorative frames still belong on
    // its own side. Widen only within the gap before the next repeated edge.
    const edge = Math.max(a.right, ...[...text,...images].filter(t => t.x >= a.x-lineHeight && t.x < a.right
      && t.x+t.width < b.x-3).map(t=>t.x+t.width));
    const gap=b.x-edge;
    if (gap < 3 || gap > bounds.width * .15) return null;
    cuts.push((edge+b.x)/2);
  }
  // Leave ordinary two-column papers on the established pixel detector.
  if (columns.length === 2 && Math.max(...columns.map(c=>c.right-c.x))/Math.min(...columns.map(c=>c.right-c.x)) < 1.4) return null;
  const result=[];
  const split = (left,top,right,bottom,available) => {
    if (bottom<=top) return;
    if (!available.length) { result.push([left,top,right,bottom]); return; }
    const crossing = x => [...text,...images].filter(b=>b.x < x-(images.includes(b)?3:1) && b.x+b.width > x+(images.includes(b)?3:1) && b.y < bottom && b.y+b.height > top
      && b.x+b.width > left && b.x < right);
    // Divide beside a wide figure first, leaving its adjacent prose column
    // continuous; divide the remaining columns above/below that figure next.
    const obstruction = x => crossing(x).reduce((n,b)=>n+Math.max(0,Math.min(bottom,b.y+b.height)-Math.max(top,b.y)),0);
    const x=[...available].sort((a,b)=>obstruction(a)-obstruction(b))[0];
    const bands=[];
    for (const b of crossing(x).sort((a,b)=>a.y-b.y)) {
      const start=Math.max(top,Math.floor(b.y-2)),end=Math.min(bottom,Math.ceil(b.y+b.height+2));
      const last=bands.at(-1);
      if (last && start<=last[1]+lineHeight*.8) last[1]=Math.max(last[1],end); else bands.push([start,end]);
    }
    const divide=(a,b)=>{ split(left,a,x,b,available.filter(c=>c<x)); split(x,a,right,b,available.filter(c=>c>x)); };
    let y=top;
    for (const [a,b] of bands) { divide(y,a); result.push([left,a,right,b]); y=b; }
    divide(y,bottom);
  };
  split(bounds.x,bounds.y,bounds.x+bounds.width,bounds.y+bounds.height,cuts);
  return result;
}
