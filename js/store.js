// Мінімальне key-value сховище поверх IndexedDB.
// Тут лежить лише зашифроване сховище ('vault') і публічний кеш цін ('market').
const DB = 'cryptotracker';
const ST = 'kv';
let dbp;

function db() {
  return (dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(ST, mode);
    const req = fn(t.objectStore(ST));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const get = (k) => tx('readonly', (s) => s.get(k));
export const set = (k, v) => tx('readwrite', (s) => s.put(v, k));
export const del = (k) => tx('readwrite', (s) => s.delete(k));
export const clear = () => tx('readwrite', (s) => s.clear());

// Просимо браузер не видаляти дані автоматично (важливо для Safari).
export async function persist() {
  try { return await navigator.storage?.persist?.(); } catch { return false; }
}
