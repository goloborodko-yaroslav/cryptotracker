const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const nf = {};
function fmt(key, opts) { return (nf[key] ??= new Intl.NumberFormat('en-US', opts)); }

export function usd(v, { sign = false } = {}) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  let s;
  if (a === 0 || a >= 1) s = fmt('u2', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a);
  else if (a >= 0.01) s = fmt('u4', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(a);
  else s = fmt('us', { style: 'currency', currency: 'USD', maximumSignificantDigits: 4 }).format(a);
  const pre = v < 0 && s !== '$0.00' ? '−' : sign && v > 0 ? '+' : '';
  return pre + s;
}

export function pct(v, { sign = true } = {}) {
  if (v == null || !isFinite(v)) return '—';
  const s = fmt('p', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v)) + '%';
  return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + s;
}

export function qty(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 6 : 8;
  return fmt('q' + d, { maximumFractionDigits: d }).format(v);
}

const dtf = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });
export const dt = (ms) => dtf.format(new Date(ms));
export const time = (ms) => tf.format(new Date(ms));

export const tone = (v) => (v == null || !isFinite(v) || Math.abs(v) < 1e-9 ? 'flat' : v > 0 ? 'up' : 'down');

export function parseNum(s) {
  if (s == null) return NaN;
  const t = String(s).trim().replace(/\s/g, '').replace(',', '.');
  return t === '' ? NaN : Number(t);
}

export function toLocalInput(ms) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

// Капіталізація коротко: $1.52T, $85.3B, $412M
export function usdShort(v) {
  if (v == null || !isFinite(v) || v <= 0) return '—';
  const u = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']].find(([d]) => v >= d);
  if (!u) return usd(v);
  const x = v / u[0];
  return '$' + x.toFixed(x >= 100 ? 0 : x >= 10 ? 1 : 2) + u[1];
}
