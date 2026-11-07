export const PALETTE = ['#ffffff', '#cfcfcf', '#a3a3a3', '#7d7d7d', '#5e5e5e', '#454545'];
export const OTHER = '#2e2e2e';
export const UP = '#ffffff';
export const DOWN = '#8d8d8d';

let gid = 0;

export function sparkline(pts, { w = 300, h = 64, color = UP } = {}) {
  if (!Array.isArray(pts) || pts.length < 2) return '';
  const min = Math.min(...pts), max = Math.max(...pts), rng = max - min || 1;
  const x = (i) => ((i / (pts.length - 1)) * w).toFixed(1);
  const y = (v) => (h - 3 - ((v - min) / rng) * (h - 6)).toFixed(1);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
  const id = 'sg' + ++gid;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark-svg" aria-hidden="true">
<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".30"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
<path d="${d}L${w},${h}L0,${h}Z" fill="url(#${id})"/>
<path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

export function donut(segs, { size = 200, thick = 20 } = {}) {
  const total = segs.reduce((a, s) => a + s.value, 0);
  const r = (size - thick) / 2, c = size / 2, C = 2 * Math.PI * r;
  const gap = segs.length > 1 ? 3 : 0;
  let off = 0;
  const arcs = total > 0 ? segs.map((s) => {
    const len = (s.value / total) * C;
    const a = `<circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="${s.color}" stroke-width="${thick}" stroke-dasharray="${Math.max(len - gap, 0.01).toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
    off += len;
    return a;
  }).join('') : '';
  return `<svg viewBox="0 0 ${size} ${size}" class="donut" aria-hidden="true"><g transform="rotate(-90 ${c} ${c})">
<circle r="${r}" cx="${c}" cy="${c}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="${thick}"/>${arcs}</g></svg>`;
}
