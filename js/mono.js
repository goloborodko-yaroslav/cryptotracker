// Чорно-білі логотипи: кожен логотип перемальовується як білий круг із чорним знаком.
//
// Як це працює: картинку малюємо на canvas і шукаємо в ній круглу підкладку
// (кільце майже суцільного кольору). Якщо підкладка є, її колір стає білим,
// а все, що від нього помітно відрізняється (і прозорі вирізи), — чорним.
// Якщо підкладки немає (знак на прозорому тлі), непрозорі частини стають
// чорними, білі деталі — білими, а сам знак вписується в білий круг.
//
// Результат зберігається лише в пам'яті на час сесії, на диск нічого не пишеться.
// Картинки CoinGecko беруться з кешу service worker, повторних запитів немає.

const SIZE = 256;
const R = SIZE / 2;
const CORS_HOSTS = ['coin-images.coingecko.com']; // assets.coingecko.com не дає CORS
const results = new Map(); // src → dataURL | null
const pending = new Map(); // src → Promise

let enabled = true;
export function setEnabled(on) { enabled = !!on; }
export const isEnabled = () => enabled;
export const cached = (src) => results.get(src);

function canProcess(src) {
  try {
    const u = new URL(src, location.href);
    return u.origin === location.origin || (u.protocol === 'https:' && CORS_HOSTS.includes(u.hostname));
  } catch { return false; }
}

export function process(src) {
  if (results.has(src)) return Promise.resolve(results.get(src));
  if (!pending.has(src)) {
    const p = (canProcess(src) ? render(src) : Promise.resolve(null))
      .catch(() => null)
      .then((url) => { results.set(src, url); pending.delete(src); return url; });
    pending.set(src, p);
  }
  return pending.get(src);
}

async function render(src) {
  // cache: 'reload' — копія в HTTP-кеші, завантажена тегом <img>, не має CORS-заголовка
  const res = await fetch(src, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'reload' });
  if (!res.ok) return null;
  const blobUrl = URL.createObjectURL(await res.blob());
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode();
    return convert(img);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Кільце радіуса r: яка частка непрозора і який у нього медіанний колір
function ring(d, r) {
  const rs = [], gs = [], bs = [];
  const n = 144;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.min(SIZE - 1, Math.max(0, Math.round(R + r * Math.cos(t) - 0.5)));
    const y = Math.min(SIZE - 1, Math.max(0, Math.round(R + r * Math.sin(t) - 0.5)));
    const k = (y * SIZE + x) * 4;
    if (d[k + 3] > 200) { rs.push(d[k]); gs.push(d[k + 1]); bs.push(d[k + 2]); }
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  return { opaque: rs.length / n, color: rs.length ? [med(rs), med(gs), med(bs)] : null };
}

function convert(img) {
  const work = document.createElement('canvas');
  work.width = work.height = SIZE;
  const g = work.getContext('2d', { willReadFrequently: true });
  const iw = img.naturalWidth || SIZE, ih = img.naturalHeight || SIZE;
  const s = Math.min(SIZE / iw, SIZE / ih);
  g.drawImage(img, (SIZE - iw * s) / 2, (SIZE - ih * s) / 2, iw * s, ih * s);
  const d = g.getImageData(0, 0, SIZE, SIZE).data;

  // Найбільший круг-підкладка
  let discR = 0, bg = null;
  for (let f = 0.96; f >= 0.5; f -= 0.02) {
    const rg = ring(d, f * R);
    if (rg.opaque >= 0.9) { discR = f * R; bg = rg.color; break; }
  }

  // Вага «чорного» для кожного пікселя (0 — білий, 1 — чорний)
  const W = new Float32Array(SIZE * SIZE);
  let x0 = SIZE, y0 = SIZE, x1 = -1, y1 = -1;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = y * SIZE + x, k = i * 4;
      const a = d[k + 3] / 255;
      const r = d[k], gg = d[k + 1], b = d[k + 2];
      let w;
      if (bg) {
        const rr = Math.hypot(x + 0.5 - R, y + 0.5 - R);
        if (rr > discR + 0.06 * R) { w = 0; } else {
          const dist = Math.hypot(r - bg[0], gg - bg[1], b - bg[2]);
          const cw = smooth(38, 100, dist);
          w = rr < discR - 0.02 * R ? a * cw + (1 - a) : a * cw; // прозорі вирізи всередині — теж знак
        }
      } else {
        const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
        const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
        const sat = max ? (max - min) / max : 0;
        const white = smooth(0.78, 0.9, lum) * (1 - smooth(0.1, 0.25, sat));
        w = a * (1 - white);
      }
      W[i] = w;
      if (w > 0.1) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }

  // Знак як чорний шар із прозорістю
  // Перевірка результату всередині підкладки
  let gray = false;
  if (bg) {
    let n = 0, black = 0, mid = 0;
    const lim = discR * 0.85;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if (Math.hypot(x + 0.5 - R, y + 0.5 - R) > lim) continue;
      const w = W[y * SIZE + x];
      n++; if (w > 0.5) black++; if (w > 0.2 && w < 0.8) mid++;
    }
    // Малюнок із градієнтами (USD1) або підкладку не вдалося розпізнати (ARB, SHIB):
    // замість знака — відтінки сірого з оригіналу
    if (n && (mid / n > 0.12 || black / n > 0.7)) gray = true;
  }

  const glyph = document.createElement('canvas');
  glyph.width = glyph.height = SIZE;
  const gctx = glyph.getContext('2d');
  const out = gctx.createImageData(SIZE, SIZE);
  if (gray) {
    for (let i = 0; i < W.length; i++) {
      const k = i * 4, a = d[k + 3] / 255;
      const lum = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
      const v = Math.min(255, Math.max(0, (lum * a + 255 * (1 - a) - 128) * 1.25 + 128));
      out.data[k] = out.data[k + 1] = out.data[k + 2] = v;
      out.data[k + 3] = 255;
    }
  } else {
    for (let i = 0; i < W.length; i++) out.data[i * 4 + 3] = Math.round(W[i] * 255);
  }
  gctx.putImageData(out, 0, 0);

  const res = document.createElement('canvas');
  res.width = res.height = SIZE;
  const c = res.getContext('2d');
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(R, R, R, 0, Math.PI * 2); c.fill();
  c.globalCompositeOperation = 'source-atop';
  c.imageSmoothingQuality = 'high';
  if (bg) {
    // Підкладку розтягуємо на весь круг
    const rd = Math.min(R, discR + 0.03 * R);
    c.drawImage(glyph, R - rd, R - rd, rd * 2, rd * 2, 0, 0, SIZE, SIZE);
  } else if (x1 >= 0) {
    // Знак без підкладки вписуємо в білий круг із полями
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const k = (SIZE * 0.6) / Math.max(bw, bh);
    const dw = bw * k, dh = bh * k;
    c.drawImage(glyph, x0, y0, bw, bh, R - dw / 2, R - dh / 2, dw, dh);
  }
  return res.toDataURL('image/png');
}
