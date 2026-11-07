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
  const r = await fetch(url, { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
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

export async function fetchSimple(ids) {
  if (!ids.length) return {};
  const r = await getJSON(`${API}/simple/price?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=usd&include_24hr_change=true`);
  const out = {};
  for (const id of ids) {
    if (r[id]?.usd != null) out[id] = { price: r[id].usd, chg24: r[id].usd_24h_change ?? null, ts: Date.now() };
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
