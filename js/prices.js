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

// ---------- Черга запитів до CoinGecko ----------
// Безкоштовний доступ дозволяє лише кілька запитів на хвилину (з мобільного інтернету —
// ще менше, бо одну IP ділять тисячі абонентів). Тому запити йдуть по одному з паузою,
// а після відмови ми хвилину не стукаємо, щоб не продовжувати блокування.
// Безкоштовний ключ CoinGecko (Demo) піднімає ліміт до ~30 запитів на хвилину.
let apiKey = '';
let queue = Promise.resolve();
let nextAt = 0;
let blockedUntil = 0;
export function setApiKey(k) { apiKey = String(k || '').trim(); }
export const hasApiKey = () => !!apiKey;
export const blockedFor = () => Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));
const rateErr = () => Object.assign(new Error('RATE_LIMIT'), { code: 429 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function getJSON(url) {
  const run = async () => {
    if (Date.now() < blockedUntil) throw rateErr();
    const gap = nextAt - Date.now();
    if (gap > 0) await wait(gap);
    nextAt = Date.now() + (apiKey ? 1200 : 2500);
    const full = apiKey ? `${url}${url.includes('?') ? '&' : '?'}x_cg_demo_api_key=${encodeURIComponent(apiKey)}` : url;
    let r;
    try {
      r = await fetch(full, { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
    } catch {
      // Відповідь 429 від CoinGecko приходить без CORS-заголовків, і браузер бачить її
      // як мережеву помилку. Якщо інтернет є — це майже напевно ліміт запитів.
      if (navigator.onLine === false) throw Object.assign(new Error('OFFLINE'), { code: 'OFFLINE' });
      blockedUntil = Date.now() + 60_000;
      throw rateErr();
    }
    if (r.status === 429) { blockedUntil = Date.now() + 60_000; throw rateErr(); }
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('BAD_KEY'), { code: 'BAD_KEY' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

export async function checkApiKey(k) {
  const r = await fetch(`${API}/ping?x_cg_demo_api_key=${encodeURIComponent(k)}`, { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' })
    .catch(() => null);
  if (!r) throw Object.assign(new Error('NETWORK'), { code: 'NETWORK' });
  if (r.status === 401 || r.status === 403 || r.status === 400) throw Object.assign(new Error('BAD_KEY'), { code: 'BAD_KEY' });
  if (!r.ok && r.status !== 429) throw new Error('HTTP ' + r.status);
  return true;
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
    mcap: c.market_cap,
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

// Локальний довідник токенізованих акцій, ETF і золота — для пошуку без запитів.
// Оновлюється раз на 12 годин; ціни в ньому лише орієнтовні (для списку вибору).
const RWA_CATEGORIES = ['tokenized-stock', 'tokenized-gold'];
export async function loadRwa() {
  const cached = await db.get('rwa');
  if (cached?.list && Date.now() - cached.ts < 12 * 3600e3) return cached;
  const list = [];
  const seen = new Set();
  for (const cat of RWA_CATEGORIES) {
    try {
      const r = await getJSON(`${API}/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=250&page=1`);
      for (const c of r) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        list.push({ id: c.id, symbol: c.symbol, name: c.name, image: safeImg(c.image), price: c.current_price, rank: c.market_cap_rank, rwa: true });
      }
    } catch (e) {
      if (cached?.list) return cached;
      if (!list.length) throw e;
    }
  }
  const m = { ts: Date.now(), list };
  await db.set('rwa', m);
  return m;
}

// Топ RWA для вкладки Cap: токенізоване золото й акції разом, за капіталізацією.
// Кеш у IndexedDB; оновлюється не частіше ніж раз на 5 хвилин.
const CAP_RWA = [['tokenized-gold', 'gold'], ['tokenized-stock', 'stock']];
export const loadCachedCapRwa = () => db.get('cap-rwa');
export async function fetchCapRwa(n = 20) {
  const all = [];
  for (const [cat, kind] of CAP_RWA) {
    const r = await getJSON(`${API}/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=${n + 5}&page=1&sparkline=true&price_change_percentage=24h,7d`);
    for (const c of r) {
      if (!c.market_cap || all.some((x) => x.id === c.id)) continue;
      all.push({
        id: c.id, symbol: c.symbol, name: c.name, image: safeImg(c.image), kind,
        price: c.current_price, rank: c.market_cap_rank, mcap: c.market_cap,
        chg24: c.price_change_percentage_24h ?? null,
        chg7: c.price_change_percentage_7d_in_currency ?? null,
        spark: downsample(c.sparkline_in_7d?.price, 60),
      });
    }
  }
  const m = { ts: Date.now(), list: all.sort((a, b) => b.mcap - a.mcap).slice(0, n) };
  await db.set('cap-rwa', m);
  return m;
}

export async function search(query) {
  const r = await getJSON(`${API}/search?query=${encodeURIComponent(query)}`);
  return (r.coins || []).slice(0, 15).map((c) => ({
    id: c.id, name: c.name, symbol: c.symbol, rank: c.market_cap_rank,
    image: safeImg(c.large || c.thumb),
  }));
}

// Ціна на конкретну дату й годину. Джерела по черзі:
//   1. CoinGecko — погодинно, точний токен за id (безкоштовно лише за останні 365 днів);
//   2. Binance — свічка 1 год, пара ТІКЕР/USDT (повна історія, але без делістингованих монет, напр. XMR);
//   3. Kraken — пара ТІКЕР/USD, також токенізовані акції xStocks (AAPLx, NVDAx…).
//      Kraken віддає останні 720 свічок, тому для старих дат свічка ширша (4 год, доба, тиждень).
// Такий запит показує сервісу монету й дату, але не ваш портфель.
const HOUR = 3600e3, DAY = 24 * HOUR;

async function fromCoinGecko(id, ts) {
  const from = Math.floor((ts - 3 * HOUR) / 1000), to = Math.ceil((ts + 3 * HOUR) / 1000);
  const r = await getJSON(`${API}/coins/${encodeURIComponent(id)}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`);
  const pts = r.prices || [];
  if (!pts.length) return null;
  let best = pts[0];
  for (const p of pts) if (Math.abs(p[0] - ts) < Math.abs(best[0] - ts)) best = p;
  return { price: best[1], at: best[0], source: 'CoinGecko' };
}

async function plainJSON(url) {
  const res = await fetch(url, { referrerPolicy: 'no-referrer', credentials: 'omit', cache: 'no-store' });
  return res.ok ? res.json() : null;
}

async function fromBinance(sym, ts) {
  const hour = Math.floor(ts / HOUR) * HOUR;
  const k = await plainJSON(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&startTime=${hour}&limit=1`);
  if (Array.isArray(k) && k[0] && Math.abs(k[0][0] - hour) < HOUR) return { price: +k[0][1], at: k[0][0], source: 'Binance' };
  return null;
}

// Базовий тікер акції для різних емітентів токенів: TSLAX (xStocks), TSLAON (Ondo), TSLAB (bStocks), TSLA (Robinhood)
function stockTicker(id, sym) {
  if (/-xstock$/.test(id) && /X$/.test(sym)) return sym.slice(0, -1);
  if (/-ondo-/.test(id) && /ON$/.test(sym)) return sym.slice(0, -2);
  if (/bstock/.test(id) && /B$/.test(sym)) return sym.slice(0, -1);
  if (/robinhood/.test(id)) return sym;
  return null;
}

async function fromKraken(id, sym, ts) {
  const age = Date.now() - ts;
  const interval = age < 29 * DAY ? 60 : age < 118 * DAY ? 240 : age < 715 * DAY ? 1440 : 10080; // хвилини
  const stock = stockTicker(id, sym);
  const pair = stock ? `${stock}xUSD&asset_class=tokenized_asset` : `${sym}USD`;
  const step = interval * 60;
  const tsSec = Math.floor(ts / 1000);
  const r = await plainJSON(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}&since=${tsSec - step}`);
  if (!r || r.error?.length || !r.result) return null;
  const key = Object.keys(r.result).find((k) => k !== 'last');
  const rows = key ? r.result[key] : null;
  if (!Array.isArray(rows)) return null;
  const c = rows.find((row) => row[0] <= tsSec && tsSec < row[0] + step);
  if (!c) return null;
  const vwap = +c[5], close = +c[4];
  const label = interval >= 1440 ? (interval === 1440 ? 'середня за добу' : 'середня за тиждень') : null;
  const name = stock && `${stock}X` !== sym ? `Kraken ${stock}x` : 'Kraken';
  return { price: vwap > 0 ? vwap : close, at: c[0] * 1000, source: label ? `${name}, ${label}` : name, daily: interval >= 1440 };
}

export async function priceAt(id, symbol, ts) {
  let rateLimited = false;
  const sym = String(symbol || '').toUpperCase();
  if (Date.now() - ts < 364 * DAY) {
    try {
      const r = await fromCoinGecko(id, ts);
      if (r) return r;
    } catch (e) { if (e.code === 429) rateLimited = true; }
  }
  if (sym === 'USDT') return { price: 1, at: ts, source: 'USDT' };
  if (!/^[A-Z0-9]{2,12}$/.test(sym)) return rateLimited ? { error: 'RATE' } : null;
  const isStock = !!stockTicker(id, sym);
  const sources = isStock ? [() => fromKraken(id, sym, ts)] : [() => fromBinance(sym, ts), () => fromKraken(id, sym, ts)];
  // Токенізоване золото: якщо історії цього токена немає, беремо PAXG (обидва ≈ ціна унції золота)
  if (/gold/.test(id) && sym !== 'PAXG') {
    sources.push(async () => {
      const r = await fromBinance('PAXG', ts);
      return r && { ...r, source: 'Binance PAXG ≈ унція золота' };
    });
  }
  for (const src of sources) {
    try {
      const r = await src();
      if (r) return r;
    } catch { /* наступне джерело */ }
  }
  return rateLimited ? { error: 'RATE' } : null;
}
