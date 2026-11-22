/**
 * Squarified treemap layout (Bruls, Huizing, van Wijk): tiles sized by value,
 * kept as close to square as the box allows. Pure so the self-check can test it.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function squarify<T>(items: T[], value: (t: T) => number, box: Rect): (Rect & { item: T })[] {
  const list = items
    .map((item) => ({ item, v: Math.max(value(item) || 0, 0) }))
    .filter((d) => d.v > 0)
    .sort((a, b) => b.v - a.v);
  const total = list.reduce((s, d) => s + d.v, 0);
  const out: (Rect & { item: T })[] = [];
  if (!total || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  const areas = list.map((d) => ({ item: d.item, a: d.v * scale }));
  let { x, y, w, h } = box;

  const worst = (row: typeof areas, side: number) => {
    const s = row.reduce((t, d) => t + d.a, 0);
    const max = Math.max(...row.map((d) => d.a));
    const min = Math.min(...row.map((d) => d.a));
    return Math.max((side * side * max) / (s * s), (s * s) / (side * side * min));
  };
  const place = (row: typeof areas) => {
    const s = row.reduce((t, d) => t + d.a, 0);
    if (w >= h) {
      const cw = h > 0 ? s / h : 0;
      let yy = y;
      for (const d of row) {
        const rh = cw > 0 ? d.a / cw : 0;
        out.push({ x, y: yy, w: cw, h: rh, item: d.item });
        yy += rh;
      }
      x += cw;
      w = Math.max(w - cw, 0);
    } else {
      const rh = w > 0 ? s / w : 0;
      let xx = x;
      for (const d of row) {
        const rw = rh > 0 ? d.a / rh : 0;
        out.push({ x: xx, y, w: rw, h: rh, item: d.item });
        xx += rw;
      }
      y += rh;
      h = Math.max(h - rh, 0);
    }
  };

  let row: typeof areas = [];
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const next = [...row, areas[i]];
    if (row.length === 0 || worst(next, side) <= worst(row, side)) {
      row = next;
      i++;
    } else {
      place(row);
      row = [];
    }
  }
  if (row.length) place(row);
  return out;
}
