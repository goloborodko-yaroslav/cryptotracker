// Синхронізація через приватний репозиторій GitHub.
//
// У репозиторії лежить один файл vault.json — те саме зашифроване сховище,
// що й на пристрої. GitHub бачить лише зашифровані байти. Токен доступу
// зберігається всередині зашифрованих даних.
//
// Злиття: транзакції об'єднуються за id (перемагає новіша правка),
// видалення зберігаються як «надгробки», щоб не воскресати з іншого пристрою.

const API = 'https://api.github.com';
const FILE = 'vault.json';

export function parseRepo(s) {
  const m = String(s || '').trim()
    .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
    .match(/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/);
  return m ? { owner: m[1], repo: m[2], full: `${m[1]}/${m[2]}` } : null;
}

const err = (code, extra) => Object.assign(new Error(code), { code, ...extra });

async function gh(cfg, path, { method = 'GET', body } = {}) {
  const r = parseRepo(cfg.repo);
  if (!r) throw err('BAD_REPO');
  let res;
  try {
    res = await fetch(`${API}/repos/${r.owner}/${r.repo}${path}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw err('NETWORK');
  }
  if (res.status === 401) throw err('BAD_TOKEN');
  return res;
}

// Перевірка токена й репозиторію під час підключення
export async function checkRepo(cfg) {
  const res = await gh(cfg, '');
  if (res.status === 404) throw err('NO_ACCESS');
  if (res.status === 403) throw err('FORBIDDEN');
  if (!res.ok) throw err('HTTP_' + res.status);
  const j = await res.json();
  if (!j.private) throw err('PUBLIC_REPO');
  return j;
}

export async function pull(cfg) {
  const res = await gh(cfg, `/contents/${FILE}`);
  if (res.status === 404) return null;
  if (res.status === 403) throw err('FORBIDDEN');
  if (!res.ok) throw err('HTTP_' + res.status);
  const j = await res.json();
  let vault;
  try { vault = JSON.parse(atob(String(j.content || '').replace(/\s/g, ''))); }
  catch { throw err('BAD_REMOTE'); }
  return { sha: j.sha, vault };
}

export async function push(cfg, vault, sha) {
  const res = await gh(cfg, `/contents/${FILE}`, {
    method: 'PUT',
    body: { message: 'CryptoTracker sync', content: btoa(JSON.stringify(vault)), ...(sha ? { sha } : {}) },
  });
  if (res.status === 409 || res.status === 422) throw err('CONFLICT');
  if (res.status === 403 || res.status === 404) throw err('FORBIDDEN');
  if (!res.ok) throw err('HTTP_' + res.status);
  return (await res.json()).content.sha;
}

// ---------- Злиття ----------

const upd = (t) => t.updated || t.created || 0;

export function mergeStates(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  for (const [id, ts] of Object.entries(local.deleted || {})) deleted[id] = Math.max(deleted[id] || 0, ts);

  const byId = new Map();
  for (const t of [...(remote.txs || []), ...(local.txs || [])]) {
    const cur = byId.get(t.id);
    if (!cur || upd(t) > upd(cur)) byId.set(t.id, t);
  }
  const txs = [...byId.values()].filter((t) => !(deleted[t.id] >= upd(t)));

  const prices = { ...(remote.prices || {}) };
  for (const [id, p] of Object.entries(local.prices || {})) {
    if (!prices[id] || (p.ts || 0) > (prices[id].ts || 0)) prices[id] = p;
  }

  return {
    ...remote,
    ...local,
    txs,
    deleted,
    coins: { ...(remote.coins || {}), ...(local.coins || {}) },
    prices,
    settings: local.settings || remote.settings, // налаштування — свої на кожному пристрої
    sync: local.sync || remote.sync,
    cgKey: 'cgKey' in local ? local.cgKey : remote.cgKey,
    ...mergeWatch(local, remote),
  };
}

// Watchlist: { id: коли додано }, видалення — { id: коли видалено }; новіша дія перемагає.
// watchOrder: { ids: [...], at } — порядок, який задав користувач
function mergeWatch(local, remote) {
  const watchDel = { ...(remote.watchDel || {}) };
  for (const [id, ts] of Object.entries(local.watchDel || {})) watchDel[id] = Math.max(watchDel[id] || 0, ts);
  const watch = {};
  for (const src of [remote.watch || {}, local.watch || {}]) {
    for (const [id, ts] of Object.entries(src)) watch[id] = Math.max(watch[id] || 0, ts);
  }
  for (const id of Object.keys(watch)) if ((watchDel[id] || 0) >= watch[id]) delete watch[id];
  // Порядок: перемагає новіша перестановка
  const lo = local.watchOrder, ro = remote.watchOrder;
  const watchOrder = (lo?.at || 0) >= (ro?.at || 0) ? lo : ro;
  return { watch, watchDel, ...(watchOrder ? { watchOrder } : {}) };
}

function digest(s) {
  const txs = [...(s.txs || [])].sort((a, b) => (a.id < b.id ? -1 : 1));
  const del = Object.keys(s.deleted || {}).sort().map((k) => [k, s.deleted[k]]);
  const coins = Object.keys(s.coins || {}).sort();
  const watch = Object.keys(s.watch || {}).sort().map((k) => [k, s.watch[k]]);
  const wdel = Object.keys(s.watchDel || {}).sort().map((k) => [k, s.watchDel[k]]);
  return JSON.stringify([txs, del, coins, watch, wdel, s.watchOrder?.at || 0]);
}

export const sameContent = (a, b) => digest(a) === digest(b);

// Пароль або ключ відновлення, змінені на іншому пристрої, переносимо сюди.
export function adoptNewerKeys(local, remote) {
  let changed = false;
  if ((remote.pwAt || 0) > (local.pwAt || 0)) {
    local.kdf = remote.kdf; local.wrapPw = remote.wrapPw; local.pwAt = remote.pwAt;
    changed = true;
  }
  if ((remote.rkAt || 0) > (local.rkAt || 0)) {
    local.wrapRk = remote.wrapRk; local.rkAt = remote.rkAt;
    changed = true;
  }
  return changed;
}

export const localKeysNewer = (local, remote) =>
  (local.pwAt || 0) > (remote.pwAt || 0) || (local.rkAt || 0) > (remote.rkAt || 0);
