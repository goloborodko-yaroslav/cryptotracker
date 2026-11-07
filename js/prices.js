// Ціни з публічного API CoinGecko (без ключа, без cookies, без referrer).
// Приватність: завжди завантажуємо топ-250 монет цілком, тож із запиту
// не видно, які саме монети у вашому портфелі. Окремий запит робиться лише
// для монет поза топ-250.
import * as db from './store.js';

const API = 'https://api.coingecko.com/api/v3';
const IMG_HOSTS = ['coin-images.coingecko.com', 'assets.coingecko.com'];

export function safeImg(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && IMG_HOSTS.includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

function index(m) {
  return { ...m, byId: Object.fromEntries(m.list.map((c) => [c.id, c])) };
}

async function getJSON(url) {
  let r;
  try {
    r = await fetch(url, { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
  } catch {
    // Відповідь 429 від CoinGecko приходить без CORS-заголовків, і браузер бачить її
    // як мережеву помилку. Якщо інтернет є — це майже напевно ліміт запитів.
    throw Object.assign(new Error('NETWORK'), { code: navigator.onLine === false ? 'OFFLINE' : 429 });
  }
  if (r.status === 429) throw Object.assign(new Error('RATE_LIMIT'), { code: 429 });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function downsample(arr, n) {
  if (!Array.isArray(arr) || arr.length <= n) return arr || null;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]);
  return out;
}

export async function loadCachedMarket() {
  const m = await db.get('market');
  return m?.list ? index(m) : null;
}

export async function fetchMarket() {
  const list = await getJSON(`${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=24h,7d`);
  const slim = list.map((c) => ({
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    image: safeImg(c.image),
    price: c.current_price,
    rank: c.market_cap_rank,
    chg24: c.price_change_percentage_24h,
    chg7: c.price_change_percentage_7d_in_currency,
    spark: downsample(c.sparkline_in_7d?.price, 60),
  }));
  const m = { ts: Date.now(), list: slim };
  await db.set('market', m);
  return index(m);
}

// Монети поза топ-250 (наприклад, токенізовані акції): ціна, зміни, графік 7 днів і логотип.
export async function fetchSimple(ids) {
  if (!ids.length) return {};
  const list = await getJSON(`${API}/coins/markets?vs_currency=usd&ids=${ids.map(encodeURIComponent).join(',')}&sparkline=true&price_change_percentage=24h,7d&per_page=250`);
  const out = {};
  for (const c of list) {
    if (c.current_price == null) continue;
    out[c.id] = {
      price: c.current_price,
      chg24: c.price_change_percentage_24h ?? null,
      chg7: c.price_change_percentage_7d_in_currency ?? null,
      spark: downsample(c.sparkline_in_7d?.price, 60),
      image: safeImg(c.image),
      rank: c.market_cap_rank ?? null,
      ts: Date.now(),
    };
  }
  return out;
}

export async function search(query) {
  const r = await getJSON(`${API}/search?query=${encodeURIComponent(query)}`);
  return (r.coins || []).slice(0, 15).map((c) => ({
    id: c.id, name: c.name, symbol: c.symbol, rank: c.market_cap_rank,
    image: safeImg(c.large || c.thumb),
  }));
}

// Ціна на конкретну дату й годину.
// За останній рік — CoinGecko (погодинно). Старіші дати, або якщо CoinGecko не відповів, —
// Binance (свічка 1 год, пара <ТІКЕР>USDT). Запит видає сервісу монету й дату.
const HOUR = 3600e3, DAY = 24 * HOUR;
export async function priceAt(id, symbol, ts) {
  let rateLimited = false;
  if (Date.now() - ts < 364 * DAY) {
    try {
      const from = Math.floor((ts - 3 * HOUR) / 1000), to = Math.ceil((ts + 3 * HOUR) / 1000);
      const r = await getJSON(`${API}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`);
      const pts = r.prices || [];
      if (pts.length) {
        let best = pts[0];
        for (const p of pts) if (Math.abs(p[0] - ts) < Math.abs(best[0] - ts)) best = p;
        return { price: best[1], at: best[0], source: 'CoinGecko' };
      }
    } catch (e) { if (e.code === 429) rateLimited = true; }
  }
  const sym = String(symbol || '').toUpperCase();
  if (sym === 'USDT') return { price: 1, at: ts, source: 'USDT' };
  if (!/^[A-Z0-9]{2,12}$/.test(sym)) return null;
  try {
    const hour = Math.floor(ts / HOUR) * HOUR;
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&startTime=${hour}&limit=1`,
      { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
    if (res.ok) {
      const k = await res.json();
      if (Array.isArray(k) && k[0] && Math.abs(k[0][0] - hour) < HOUR) return { price: +k[0][1], at: k[0][0], source: 'Binance' };
    }
  } catch { /* немає даних */ }
  return rateLimited ? { error: 'RATE' } : null;
}
