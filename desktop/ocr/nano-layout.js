// A repeated grid of short labels is unsafe to flatten as prose. Keep the
// original page until we can preserve its diagram as one measured region.
// This is deliberately independent of Nano's learned layout classifications.
export function nanoDiagramGrid(text, width) {
  const labels = text.filter(b => b.width < width * .18 && b.text.trim().split(/\s+/).length <= 5);
  const rows = [];
  for (const box of labels.toSorted((a, b) => a.y - b.y)) {
    let row = rows.find(r => Math.abs(r.y - box.y) < Math.min(r.height, box.height) * .5);
    if (!row) rows.push(row = { y: box.y, height: box.height, boxes: [] });
    row.boxes.push(box);
  }
  const grids = rows.filter(row => {
    const boxes = row.boxes.toSorted((a, b) => a.x - b.x);
    return boxes.length >= 3 && boxes.at(-1).x - boxes[0].x > width * .3
      && boxes.every((b, i) => !i || b.x > boxes[i - 1].x + boxes[i - 1].width + width * .015);
  });
  return grids.some((row, i) => grids.slice(i + 1).some(other => other.y - row.y < row.height * 3
    && row.boxes.filter(b => other.boxes.some(c => Math.abs(c.x - b.x) < width * .025)).length >= 3));
}
