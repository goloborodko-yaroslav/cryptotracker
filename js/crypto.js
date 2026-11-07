// Шифрування CryptoTracker.
//
// Схема:
//   DEK  — випадковий 256-бітний ключ, яким шифруються всі дані (AES-256-GCM).
//   KEK  — ключ із головного пароля через Argon2id (64 МБ пам'яті, 3 проходи).
//   RKEK — ключ із ключа відновлення через HKDF-SHA256.
// DEK зберігається двічі: зашифрований KEK і зашифрований RKEK.
// Пароль, ключ відновлення і DEK у відкритому вигляді ніколи не записуються на диск.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const KDF_PARAMS = { t: 3, m: 65536, p: 1 }; // m у КіБ = 64 МБ

const AAD = {
  pw: 'CryptoTracker/v1/dek/password',
  rk: 'CryptoTracker/v1/dek/recovery',
  data: 'CryptoTracker/v1/data',
};

export const b64 = {
  to(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  from(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); },
};

const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function argon(password, salt, p) {
  const hw = globalThis.hashwasm;
  if (!hw?.argon2id) throw new Error('ARGON_MISSING');
  return hw.argon2id({
    password: password.normalize('NFKC'),
    salt,
    iterations: p.t,
    memorySize: p.m,
    parallelism: p.p,
    hashLength: 32,
    outputType: 'binary',
  });
}

const aesKey = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function seal(key, plain, aad) {
  const iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, plain));
  return { iv: b64.to(iv), ct: b64.to(ct) };
}

async function open(key, box, aad) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64.from(box.iv), additionalData: enc.encode(aad) }, key, b64.from(box.ct)));
}

// ---------- Ключ відновлення ----------
// 32 символи з алфавіту без схожих літер (без I, O, 0, 1) = 160 біт ентропії.
const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genRecovery() {
  const bytes = rand(20);
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out; // 32 символи
}

export function normalizeRecovery(s) {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function formatRecovery(rk) {
  return normalizeRecovery(rk).match(/.{1,4}/g).join('-');
}

async function recoveryKek(rk, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizeRecovery(rk)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('CryptoTracker recovery v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function passwordKek(vault, password) {
  const k = vault.kdf;
  const raw = await argon(password, b64.from(k.salt), { t: k.t, m: k.m, p: k.p });
  try { return await aesKey(raw); } finally { raw.fill(0); }
}

async function wrapWithPassword(vault, dekRaw, password) {
  const salt = rand(16);
  vault.kdf = { alg: 'argon2id', salt: b64.to(salt), ...KDF_PARAMS };
  vault.wrapPw = await seal(await passwordKek(vault, password), dekRaw, AAD.pw);
  vault.pwAt = Date.now(); // для синхронізації: новіша зміна пароля перемагає
}

async function wrapWithRecovery(vault, dekRaw) {
  const rk = genRecovery();
  const salt = rand(16);
  vault.wrapRk = { salt: b64.to(salt), ...(await seal(await recoveryKek(rk, salt), dekRaw, AAD.rk)) };
  vault.rkAt = Date.now();
  return formatRecovery(rk);
}

async function dekFromPassword(vault, password) {
  const kek = await passwordKek(vault, password);
  try { return await open(kek, vault.wrapPw, AAD.pw); }
  catch { throw new Error('WRONG_PASSWORD'); }
}

async function dekFromRecovery(vault, rk) {
  if (normalizeRecovery(rk).length !== 32) throw new Error('WRONG_RECOVERY');
  const kek = await recoveryKek(rk, b64.from(vault.wrapRk.salt));
  try { return await open(kek, vault.wrapRk, AAD.rk); }
  catch { throw new Error('WRONG_RECOVERY'); }
}

// ---------- Публічне API ----------

export function isVault(v) {
  return v && v.app === 'CryptoTracker' && v.v === 1 && v.kdf && v.wrapPw && v.wrapRk && v.data;
}

export async function sealData(vault, dek, state) {
  vault.data = await seal(dek, enc.encode(JSON.stringify(state)), AAD.data);
  vault.updatedAt = Date.now();
}

export async function openData(vault, dek) {
  return JSON.parse(dec.decode(await open(dek, vault.data, AAD.data)));
}

export async function createVault(password, initialState) {
  const dekRaw = rand(32);
  try {
    const vault = { app: 'CryptoTracker', v: 1, createdAt: Date.now() };
    await wrapWithPassword(vault, dekRaw, password);
    const recoveryKey = await wrapWithRecovery(vault, dekRaw);
    const dek = await aesKey(dekRaw);
    await sealData(vault, dek, initialState);
    return { vault, dek, recoveryKey };
  } finally { dekRaw.fill(0); }
}

export async function unlockWithPassword(vault, password) {
  const dekRaw = await dekFromPassword(vault, password);
  try {
    const dek = await aesKey(dekRaw);
    return { dek, state: await openData(vault, dek) };
  } finally { dekRaw.fill(0); }
}

// Вхід ключем відновлення: одразу встановлює новий пароль.
export async function recoverWithKey(vault, rk, newPassword) {
  const dekRaw = await dekFromRecovery(vault, rk);
  try {
    const dek = await aesKey(dekRaw);
    const state = await openData(vault, dek);
    await wrapWithPassword(vault, dekRaw, newPassword);
    return { dek, state };
  } finally { dekRaw.fill(0); }
}

export async function changePassword(vault, oldPassword, newPassword) {
  const dekRaw = await dekFromPassword(vault, oldPassword);
  try { await wrapWithPassword(vault, dekRaw, newPassword); }
  finally { dekRaw.fill(0); }
}

export async function newRecoveryKey(vault, password) {
  const dekRaw = await dekFromPassword(vault, password);
  try { return await wrapWithRecovery(vault, dekRaw); }
  finally { dekRaw.fill(0); }
}
