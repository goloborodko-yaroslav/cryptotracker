import * as db from './store.js';
import * as V from './crypto.js';
import { computePortfolio, computeCoin, sortTxs, TX_TYPES } from './calc.js';
import * as P from './prices.js';
import * as Sync from './sync.js';
import { esc, usd, pct, qty as fq, dt, time, tone, parseNum, toLocalInput } from './format.js';
import { sparkline, donut, PALETTE, OTHER, UP, DOWN } from './charts.js';
import { icon, LOGO } from './icons.js';

const APP_VERSION = '1.3.1';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const app = $('#app');
const modalRoot = $('#modal-root');

const S = {
  vault: null, dek: null, state: null, market: null,
  priceError: null, refreshing: false, lastActive: Date.now(), started: false,
  pendingSync: null,
};

const newState = () => ({
  v: 1, txs: [], coins: {}, prices: {},
  settings: { autoLockMin: 5, hideValues: false },
  createdAt: Date.now(),
});

// ---------------- Утиліти ----------------

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}

let saveChain = Promise.resolve();
function save({ sync = true } = {}) {
  saveChain = saveChain
    .then(async () => {
      await V.sealData(S.vault, S.dek, S.state);
      await db.set('vault', S.vault);
    })
    .catch((e) => { console.error(e); toast('Не вдалося зберегти дані', 'err'); });
  if (sync) saveChain.then(() => scheduleSync());
  return saveChain;
}

// ---------------- Синхронізація ----------------

const SYNC = { busy: false, at: null, err: null, timer: null, again: false };
const DEFAULT_REPO = location.hostname.endsWith('.github.io') ? `${location.hostname.split('.')[0]}/cryptotracker-data` : '';
const SYNC_ERRORS = {
  BAD_TOKEN: 'Токен недійсний або прострочений',
  NO_ACCESS: 'Репозиторій не знайдено або токен не має до нього доступу',
  FORBIDDEN: 'Токен не має права запису (потрібно Contents: Read and write)',
  PUBLIC_REPO: 'Репозиторій публічний — потрібен приватний',
  DIFFERENT_KEY: 'На GitHub лежить інший портфель, зашифрований іншим ключем',
  BAD_REMOTE: 'Файл на GitHub пошкоджений',
  BAD_REPO: 'Невірна назва репозиторію (має бути: користувач/назва)',
  NETWORK: 'Немає з’єднання з GitHub',
};
const syncErrText = (code) => SYNC_ERRORS[code] || 'Помилка синхронізації (' + code + ')';
const syncCfg = () => (S.state?.sync?.token && S.state.sync.repo ? S.state.sync : null);

function scheduleSync(delay = 1500) {
  if (!syncCfg()) return;
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(() => syncNow(), delay);
}

async function syncNow({ overwrite = false, manual = false } = {}) {
  const cfg = syncCfg();
  if (!cfg || !S.dek) return;
  if (SYNC.busy) { SYNC.again = true; return; }
  SYNC.busy = true;
  updateSyncUI();
  try {
    for (let attempt = 0; ; attempt++) {
      await saveChain;
      const remote = await Sync.pull(cfg);
      let needPush = true;
      if (remote && !overwrite) {
        if (!V.isVault(remote.vault)) throw Object.assign(new Error('BAD_REMOTE'), { code: 'BAD_REMOTE' });
        let rstate;
        try { rstate = await V.openData(remote.vault, S.dek); }
        catch { throw Object.assign(new Error('DIFFERENT_KEY'), { code: 'DIFFERENT_KEY' }); }
        const keysChanged = Sync.adoptNewerKeys(S.vault, remote.vault);
        const merged = Sync.mergeStates(S.state, rstate);
        const localChanged = !Sync.sameContent(merged, S.state);
        S.state = merged;
        needPush = !Sync.sameContent(merged, rstate) || Sync.localKeysNewer(S.vault, remote.vault);
        if (localChanged || keysChanged) await save({ sync: false });
        if (localChanged) renderView();
        if (keysChanged) toast('Пароль або ключ відновлення змінено на іншому пристрої');
      }
      if (!needPush) break;
      await saveChain;
      try { await Sync.push(cfg, S.vault, remote?.sha); break; }
      catch (e) { if (e.code === 'CONFLICT' && attempt < 3) continue; throw e; }
    }
    SYNC.at = Date.now();
    SYNC.err = null;
    if (manual) toast('Синхронізовано');
  } catch (e) {
    console.warn('sync', e);
    SYNC.err = e.code || e.message;
    if (manual) toast(syncErrText(SYNC.err), 'err');
  } finally {
    SYNC.busy = false;
    updateSyncUI();
    if (SYNC.again) { SYNC.again = false; scheduleSync(300); }
  }
}

function syncStatusHtml() {
  if (!syncCfg()) return '';
  if (SYNC.busy) return `<span class="spinner sm"></span> Синхронізація…`;
  if (SYNC.err) return `${icon('alert', 14)} ${esc(syncErrText(SYNC.err))}`;
  if (SYNC.at) return `${icon('cloud', 14)} Синхронізовано · ${time(SYNC.at)}`;
  return `${icon('cloud', 14)} Синхронізація увімкнена`;
}

function updateSyncUI() {
  for (const el of $$('.sync-status')) {
    el.innerHTML = syncStatusHtml();
    el.classList.toggle('warn', !!SYNC.err && !SYNC.busy);
  }
  const box = $('#sync-diff');
  if (box) box.hidden = SYNC.err !== 'DIFFERENT_KEY';
}

const TOKEN_HELP = `
  <details class="howto">
    <summary>Як створити токен (2 хвилини)</summary>
    <ol>
      <li>Відкрийте <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">github.com → Fine-grained token</a>.</li>
      <li><b>Token name:</b> CryptoTracker. <b>Expiration:</b> 1 рік (або довше).</li>
      <li><b>Repository access:</b> Only select repositories → <b>cryptotracker-data</b>.</li>
      <li><b>Permissions → Repository permissions → Contents:</b> Read and write.</li>
      <li>Натисніть <b>Generate token</b> і скопіюйте його (починається з <code>github_pat_</code>).</li>
    </ol>
    <p>Токен дає доступ лише до цього одного репозиторію. Він зберігається всередині зашифрованих даних.</p>
  </details>`;

function waitArgon() {
  if (globalThis.hashwasm?.argon2id) return Promise.resolve();
  return new Promise((res, rej) => {
    let n = 0;
    const iv = setInterval(() => {
      if (globalThis.hashwasm?.argon2id) { clearInterval(iv); res(); }
      else if (++n > 100) { clearInterval(iv); rej(new Error('ARGON_MISSING')); }
    }, 50);
  });
}

function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner sm"></span> ${esc(label)}`; }
  else { btn.disabled = false; btn.innerHTML = btn.dataset.label; }
}

function strength(pw) {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (pw.length >= 18) s++;
  if (/[a-zа-яіїєґ]/.test(pw) && /[A-ZА-ЯІЇЄҐ]/.test(pw)) s++;
  if (/\d/.test(pw)) s++;
  if (/[^\p{L}\d]/u.test(pw)) s++;
  return Math.min(4, Math.floor(s * 0.7));
}
const STRENGTH = ['Дуже слабкий', 'Слабкий', 'Нормальний', 'Добрий', 'Відмінний'];

function bindStrength(form) {
  const input = form.elements.pw, bar = $('.strength', form);
  input.addEventListener('input', () => {
    const s = input.value ? strength(input.value) : -1;
    bar.dataset.s = s;
    $('span', bar).textContent = s >= 0 ? STRENGTH[s] : '';
  });
}

function showErr(form, msg) {
  const el = $('.form-err', form);
  el.textContent = msg;
  el.hidden = !msg;
  if (msg) { form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
}

function checkNewPassword(pw, pw2) {
  if (pw.length < 10) return 'Пароль має містити щонайменше 10 символів';
  if (pw !== pw2) return 'Паролі не збігаються';
  return null;
}

// ---------------- Монети ----------------

function quote(id) {
  const m = S.market?.byId?.[id];
  if (m && m.price != null) return m;
  const p = S.state?.prices?.[id];
  return p ? { price: p.price, chg24: p.chg24 } : null;
}

function meta(id) {
  const saved = S.state?.coins?.[id] || {};
  const m = S.market?.byId?.[id] || {};
  return {
    id,
    name: saved.name || m.name || id,
    symbol: (saved.symbol || m.symbol || '?').toUpperCase(),
    image: P.safeImg(m.image || saved.image || ''),
  };
}

// Власні логотипи, що замінюють картинки CoinGecko
const LOCAL_LOGOS = { dogecoin: 'icons/coins/dogecoin.svg' };

function logo(id, size = 'xl', c = meta(id)) {
  const src = LOCAL_LOGOS[id] || c.image;
  if (src) return `<img class="logo ${size}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-sym="${esc(c.symbol)}">`;
  return fallbackLogo(c.symbol, size);
}
function fallbackLogo(sym, size) {
  return `<span class="logo ${size} logo-fb">${esc(String(sym).slice(0, 4))}</span>`;
}

// Логотип не завантажився → показуємо літери тікера
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img?.tagName === 'IMG' && img.classList.contains('logo')) {
    const size = [...img.classList].find((c) => c !== 'logo') || 'xl';
    img.outerHTML = fallbackLogo(img.dataset.sym || '?', size);
  }
}, true);

const heldIds = () => [...new Set(S.state.txs.map((t) => t.coinId))];

// ---------------- Ціни ----------------

async function refreshPrices(force = false) {
  if (S.refreshing || !S.state) return;
  S.refreshing = true;
  $('[data-act="refresh"]')?.classList.add('spinning');
  try {
    if (force || !S.market || Date.now() - S.market.ts > 60_000) S.market = await P.fetchMarket();
    const missing = heldIds().filter((id) => !S.market.byId[id]);
    if (missing.length) {
      Object.assign(S.state.prices, await P.fetchSimple(missing));
      save();
    }
    S.priceError = null;
    if (force) toast('Ціни оновлено');
  } catch (e) {
    console.warn(e);
    S.priceError = e.code === 429 ? 'CoinGecko тимчасово обмежив запити — спробуйте за хвилину' : 'Немає з’єднання з CoinGecko, показано останні відомі ціни';
    if (force) toast(S.priceError, 'err');
  } finally {
    S.refreshing = false;
    $('[data-act="refresh"]')?.classList.remove('spinning');
    renderView();
  }
}

// ---------------- Екрани входу ----------------

function authShell(inner) {
  return `<div class="auth"><div class="auth-card">
    <div class="auth-brand">${LOGO}<span>CryptoTracker</span></div>
    ${inner}
    <div class="auth-foot">${icon('shield', 16)} Зашифровано на цьому пристрої · AES-256 + Argon2id</div>
  </div></div>`;
}

const USERNAME_FIELD = '<input class="vh" type="text" name="username" value="CryptoTracker" autocomplete="username" tabindex="-1" aria-hidden="true">';

function renderSetup() {
  app.innerHTML = authShell(`
    <h1>Створіть головний пароль</h1>
    <p class="muted">Він шифрує всі ваші записи. Пароль ніде не зберігається, тому відновити його неможливо — лише ключем відновлення, який ви отримаєте на наступному кроці.</p>
    <form id="setup-form" novalidate>
      ${USERNAME_FIELD}
      <label class="field"><span>Пароль</span><input type="password" name="pw" autocomplete="new-password" required autofocus></label>
      <div class="strength" data-s="-1"><i></i><i></i><i></i><i></i><i></i><span></span></div>
      <label class="field"><span>Повторіть пароль</span><input type="password" name="pw2" autocomplete="new-password" required></label>
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">Створити сховище</button>
    </form>
    <button class="link-btn" id="have-remote">${icon('cloud', 16)} Уже маю портфель на іншому пристрої</button>`);
  const form = $('#setup-form');
  bindStrength(form);
  $('#have-remote').addEventListener('click', renderConnectExisting);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = form.elements.pw.value, pw2 = form.elements.pw2.value;
    const err = checkNewPassword(pw, pw2);
    if (err) return showErr(form, err);
    showErr(form, '');
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Генеруємо ключ шифрування…');
    try {
      await waitArgon();
      const { vault, dek, recoveryKey } = await V.createVault(pw, newState());
      await db.set('vault', vault);
      db.persist();
      S.vault = vault; S.dek = dek; S.state = await V.openData(vault, dek);
      renderRecoveryKey(recoveryKey, enterApp);
    } catch (e2) {
      console.error(e2);
      busy(btn, false);
      showErr(form, 'Не вдалося створити сховище: ' + e2.message);
    }
  });
}

function renderConnectExisting() {
  app.innerHTML = authShell(`
    <h1>Підключити портфель</h1>
    <p class="muted">Завантажимо зашифрований портфель із вашого приватного репозиторію GitHub. Потім введете той самий головний пароль, що й на іншому пристрої.</p>
    <form id="connect-form" novalidate autocomplete="off">
      <label class="field"><span>Репозиторій</span><input name="repo" value="${esc(DEFAULT_REPO)}" placeholder="користувач/cryptotracker-data" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Токен доступу</span><input type="password" name="token" placeholder="github_pat_…" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
      ${TOKEN_HELP}
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">${icon('cloud', 18)} Завантажити портфель</button>
    </form>
    <button class="link-btn" id="back-setup">← Створити новий портфель</button>`);
  const form = $('#connect-form');
  $('#back-setup').addEventListener('click', renderSetup);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = Sync.parseRepo(form.elements.repo.value);
    const token = form.elements.token.value.trim();
    if (!repo) return showErr(form, syncErrText('BAD_REPO'));
    if (!token) return showErr(form, 'Вставте токен доступу');
    const cfg = { repo: repo.full, token };
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Завантажуємо…');
    try {
      await Sync.checkRepo(cfg);
      const remote = await Sync.pull(cfg);
      if (!remote) throw Object.assign(new Error('EMPTY'), { code: 'EMPTY' });
      if (!V.isVault(remote.vault)) throw Object.assign(new Error('BAD_REMOTE'), { code: 'BAD_REMOTE' });
      await db.set('vault', remote.vault);
      db.persist();
      S.vault = remote.vault;
      S.pendingSync = cfg;
      renderUnlock();
      toast('Портфель завантажено. Введіть головний пароль');
    } catch (e2) {
      busy(btn, false);
      showErr(form, e2.code === 'EMPTY'
        ? 'У репозиторії ще немає портфеля. Спочатку увімкніть синхронізацію на пристрої, де портфель уже є.'
        : syncErrText(e2.code || e2.message));
    }
  });
}

function renderRecoveryKey(rk, next, inModal = false) {
  const html = `
    <div class="rk-icon">${icon('key', 28)}</div>
    <h1>Ключ відновлення</h1>
    <p class="muted">Запишіть його <b>на папері</b> і зберігайте окремо від телефона й ноутбука. Це єдиний спосіб повернути доступ, якщо ви забудете пароль. Ключ показується лише один раз.</p>
    <div class="rk-box">${rk.split('-').map((g) => `<span>${esc(g)}</span>`).join('')}</div>
    <label class="check"><input type="checkbox" id="rk-ok"> <span>Я записав ключ і зберігаю його в надійному місці</span></label>
    <button class="btn primary block lg" id="rk-next" disabled>Продовжити</button>`;
  if (inModal) openModal('', `<div class="rk-modal">${html}</div>`, { dismissable: false });
  else app.innerHTML = authShell(html);
  const root = inModal ? modalRoot : app;
  $('#rk-ok', root).addEventListener('change', (e) => ($('#rk-next', root).disabled = !e.target.checked));
  $('#rk-next', root).addEventListener('click', next);
}

function renderUnlock() {
  app.innerHTML = authShell(`
    <h1>З поверненням</h1>
    <p class="muted">Введіть головний пароль, щоб розшифрувати портфель.</p>
    <form id="unlock-form" novalidate>
      ${USERNAME_FIELD}
      <label class="field"><span>Пароль</span><input type="password" name="pw" autocomplete="current-password" required autofocus></label>
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">${icon('lock', 18)} Розблокувати</button>
    </form>
    <button class="link-btn" id="forgot">Забули пароль? Увійти ключем відновлення</button>`);
  const form = $('#unlock-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = form.elements.pw.value;
    if (!pw) return showErr(form, 'Введіть пароль');
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Розшифровуємо…');
    try {
      await waitArgon();
      const { dek, state } = await V.unlockWithPassword(S.vault, pw);
      S.dek = dek; S.state = state;
      enterApp();
    } catch (e2) {
      busy(btn, false);
      form.elements.pw.select();
      showErr(form, e2.message === 'WRONG_PASSWORD' ? 'Невірний пароль' : 'Помилка: ' + e2.message);
    }
  });
  $('#forgot').addEventListener('click', renderRecover);
}

function renderRecover() {
  app.innerHTML = authShell(`
    <h1>Відновлення доступу</h1>
    <p class="muted">Введіть ключ відновлення (32 символи) і задайте новий пароль.</p>
    <form id="recover-form" novalidate>
      ${USERNAME_FIELD}
      <label class="field"><span>Ключ відновлення</span><input type="text" name="rk" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX-XXXX-…" required autofocus></label>
      <label class="field"><span>Новий пароль</span><input type="password" name="pw" autocomplete="new-password" required></label>
      <div class="strength" data-s="-1"><i></i><i></i><i></i><i></i><i></i><span></span></div>
      <label class="field"><span>Повторіть новий пароль</span><input type="password" name="pw2" autocomplete="new-password" required></label>
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">Відновити доступ</button>
    </form>
    <button class="link-btn" id="back-unlock">← Назад до входу паролем</button>`);
  const form = $('#recover-form');
  bindStrength(form);
  $('#back-unlock').addEventListener('click', renderUnlock);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = checkNewPassword(form.elements.pw.value, form.elements.pw2.value);
    if (err) return showErr(form, err);
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Перевіряємо ключ…');
    try {
      await waitArgon();
      const { dek, state } = await V.recoverWithKey(S.vault, form.elements.rk.value, form.elements.pw.value);
      S.dek = dek; S.state = state;
      await db.set('vault', S.vault);
      toast('Пароль змінено');
      enterApp();
    } catch (e2) {
      busy(btn, false);
      showErr(form, e2.message === 'WRONG_RECOVERY' ? 'Невірний ключ відновлення' : 'Помилка: ' + e2.message);
    }
  });
}

function lock() {
  // Перезавантаження сторінки гарантовано стирає ключ і дані з пам'яті.
  S.dek = null; S.state = null;
  app.innerHTML = '';
  location.reload();
}

// ---------------- Основний застосунок ----------------

function enterApp() {
  S.state.settings ??= { autoLockMin: 5, hideValues: false };
  S.state.prices ??= {};
  S.state.coins ??= {};
  S.state.deleted ??= {};
  if (S.pendingSync) {
    S.state.sync = { ...S.pendingSync, since: Date.now() };
    S.pendingSync = null;
    save({ sync: false });
  }
  S.lastActive = Date.now();
  renderShell();
  route();
  refreshPrices();
  syncNow();
  if (S.started) return;
  S.started = true;
  addEventListener('hashchange', route);
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
    addEventListener(ev, () => (S.lastActive = Date.now()), { passive: true }));
  setInterval(checkAutoLock, 10_000);
  setInterval(() => { if (document.visibilityState === 'visible') refreshPrices(); }, 120_000);
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60_000);
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('obscured', document.visibilityState === 'hidden');
    if (document.visibilityState === 'visible') { checkAutoLock(); if (S.dek) { refreshPrices(); syncNow(); } }
  });
}

function checkAutoLock() {
  if (!S.dek) return;
  const min = S.state.settings.autoLockMin;
  if (min > 0 && Date.now() - S.lastActive > min * 60_000) lock();
}

function renderShell() {
  document.body.classList.toggle('hide-values', !!S.state.settings.hideValues);
  app.innerHTML = `
    <header class="topbar"><div class="container topbar-in">
      <a class="brand" href="#/">${LOGO}<span>CryptoTracker</span></a>
      <div class="top-actions">
        <button class="icon-btn" data-act="toggle-hide" title="Сховати / показати суми">${icon(S.state.settings.hideValues ? 'eyeOff' : 'eye')}</button>
        <button class="icon-btn" data-act="refresh" title="Оновити ціни">${icon('refresh')}</button>
        <button class="icon-btn" data-act="settings" title="Налаштування">${icon('settings')}</button>
        <button class="icon-btn" data-act="lock" title="Заблокувати">${icon('lock')}</button>
        <button class="btn primary desk-only" data-act="add-tx">${icon('plus', 18)} Транзакція</button>
      </div>
    </div></header>
    <main id="view" class="container"></main>
    <button class="fab mob-only" data-act="add-tx" aria-label="Додати транзакцію">${icon('plus', 26)}</button>`;
}

function route() {
  if (!S.state) return;
  renderView();
  window.scrollTo(0, 0);
}

function renderView() {
  const view = $('#view');
  if (!view || !S.state) return;
  const m = location.hash.match(/^#\/coin\/(.+)$/);
  view.innerHTML = m ? coinView(decodeURIComponent(m[1])) : dashboardView();
}

function pricesLine() {
  const sync = syncCfg() ? `<span class="status sync-status ${SYNC.err && !SYNC.busy ? 'warn' : ''}">${syncStatusHtml()}</span>` : '';
  let price;
  if (S.priceError) price = `<span class="status warn">${icon('alert', 14)} ${esc(S.priceError)}</span>`;
  else if (S.market) price = `<span class="status"><i class="dot"></i> Ціни CoinGecko · ${time(S.market.ts)}</span>`;
  else price = `<span class="status"><span class="spinner sm"></span> Завантажуємо ціни…</span>`;
  return `<span class="status-line">${price}${sync}</span>`;
}

function pnlChip(v, p) {
  return `<span class="chip ${tone(v)}"><span class="money">${usd(v, { sign: true })}</span>${p != null ? ` · ${pct(p)}` : ''}</span>`;
}

function dashboardView() {
  if (!S.state.txs.length) {
    return `<section class="empty">
      <div class="empty-art">${LOGO}</div>
      <h1>Портфель порожній</h1>
      <p class="muted">Додайте першу транзакцію — купівлю або переказ, і CryptoTracker автоматично порахує середню ціну, прибуток і збиток.</p>
      <button class="btn primary lg" data-act="add-tx">${icon('plus', 18)} Додати транзакцію</button>
      <div class="empty-foot">${pricesLine()}</div>
    </section>`;
  }
  const { holdings, closed, totals: T } = computePortfolio(S.state.txs, quote);

  const segs = holdings.filter((h) => h.value > 0);
  const top = segs.slice(0, 6).map((h, i) => ({ ...h, color: PALETTE[i] }));
  const rest = segs.slice(6).reduce((a, h) => a + h.value, 0);
  const donutSegs = [...top.map((h) => ({ value: h.value, color: h.color })), ...(rest > 0 ? [{ value: rest, color: OTHER }] : [])];

  const legend = top.map((h) => `
    <a class="legend-row" href="#/coin/${encodeURIComponent(h.id)}">
      <i style="background:${h.color}"></i>${logo(h.id, 'xs')}<b>${esc(meta(h.id).symbol)}</b><span>${pct(h.share, { sign: false })}</span>
    </a>`).join('') + (rest > 0 ? `<div class="legend-row"><i style="background:${OTHER}"></i><span class="logo xs logo-fb">…</span><b>Інші</b><span>${pct((rest / T.value) * 100, { sign: false })}</span></div>` : '');

  return `
    <section class="hero card">
      <div class="hero-main">
        <div class="label">Вартість портфеля</div>
        <div class="hero-value money">${usd(T.value)}</div>
        <div class="hero-24">${pnlChip(T.chg24, T.chg24Pct)}<span class="muted">за 24 години</span></div>
        <div class="hero-stats">
          <div class="stat"><span class="label">Загальний P&L</span><span class="money ${tone(T.pnl)}">${usd(T.pnl, { sign: true })}</span><small class="${tone(T.pnl)}">${pct(T.pnlPct)}</small></div>
          <div class="stat"><span class="label">Вкладено</span><span class="money">${usd(T.invested)}</span><small class="muted">усього купівель</small></div>
          <div class="stat"><span class="label">Нереалізований</span><span class="money ${tone(T.unreal)}">${usd(T.unreal, { sign: true })}</span><small class="muted">у монетах зараз</small></div>
          <div class="stat"><span class="label">Реалізований</span><span class="money ${tone(T.realized)}">${usd(T.realized, { sign: true })}</span><small class="muted">з продажів</small></div>
        </div>
      </div>
      <div class="hero-alloc">
        <div class="donut-wrap">${donut(donutSegs)}<div class="donut-center"><b>${holdings.length}</b><span>${plural(holdings.length, 'актив', 'активи', 'активів')}</span></div></div>
        <div class="legend">${legend}</div>
      </div>
    </section>

    <div class="section-head"><h2>Активи</h2>${pricesLine()}</div>
    <div class="coin-grid">${holdings.map(coinCard).join('') || '<div class="muted pad">Немає відкритих позицій</div>'}</div>

    ${closed.length ? `
      <div class="section-head"><h2>Закриті позиції</h2><span class="muted small">монети, які ви повністю продали</span></div>
      <div class="closed-list card">${closed.map((c) => `
        <a class="closed-row" href="#/coin/${encodeURIComponent(c.id)}">
          ${logo(c.id, 'md')}
          <div class="cr-name"><b>${esc(meta(c.id).name)}</b><span class="muted">${esc(meta(c.id).symbol)} · ${c.count} ${plural(c.count, 'транзакція', 'транзакції', 'транзакцій')}</span></div>
          <div class="cr-pnl"><span class="money ${tone(c.realized)}">${usd(c.realized, { sign: true })}</span><small class="muted">реалізовано</small></div>
          ${icon('chevron', 18)}
        </a>`).join('')}
      </div>` : ''}
    <div class="foot-note">${icon('shield', 14)} Усі дані зашифровані й зберігаються лише на цьому пристрої</div>`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function coinCard(h) {
  const c = meta(h.id);
  const q = S.market?.byId?.[h.id];
  const spark = q?.spark ? sparkline(q.spark, { color: (q.chg7 ?? 0) >= 0 ? UP : DOWN }) : '';
  return `
    <a class="coin-card card" href="#/coin/${encodeURIComponent(h.id)}">
      <div class="cc-top">
        ${logo(h.id, 'xl', c)}
        <div class="cc-name">
          <div class="name">${esc(c.name)}</div>
          <div class="sym">${esc(c.symbol)}${h.chg24 != null ? ` <span class="${tone(h.chg24)}">${pct(h.chg24)}</span>` : ''}</div>
        </div>
        <div class="cc-value">
          <div class="money big">${usd(h.value)}</div>
          <div class="muted money">${fq(h.qty)} ${esc(c.symbol)}</div>
        </div>
      </div>
      <div class="cc-spark">${spark || '<div class="no-spark muted small">графік 7 днів недоступний</div>'}${spark ? '<span class="spark-tag">7д</span>' : ''}</div>
      <div class="cc-stats">
        <div><span class="label">Ціна</span><span>${usd(h.price)}</span></div>
        <div><span class="label">Сер. купівля</span><span class="money">${usd(h.avg)}</span></div>
        <div><span class="label">P&L</span><span class="money ${tone(h.pnl)}">${usd(h.pnl, { sign: true })}</span><small class="${tone(h.pnl)}">${pct(h.pnlPct)}</small></div>
      </div>
      <div class="cc-share"><i style="width:${Math.max(h.share, 0.5).toFixed(2)}%"></i></div>
    </a>`;
}

function coinView(id) {
  const txs = S.state.txs.filter((t) => t.coinId === id);
  if (!txs.length) { setTimeout(() => (location.hash = '#/'), 0); return ''; }
  const c = meta(id);
  const k = computeCoin(txs);
  const q = quote(id);
  const mk = S.market?.byId?.[id];
  const price = q?.price ?? null;
  const value = price != null ? k.qty * price : null;
  const unreal = value != null ? value - k.cost : null;
  const pnl = k.realized + (unreal ?? 0);

  const rows = sortTxs(txs).reverse().map((t) => {
    const total = t.type === 'out' ? null : t.qty * (t.price || 0);
    const sign = t.type === 'buy' || t.type === 'in' ? '+' : '−';
    return `
      <div class="tx-row">
        <span class="tx-type t-${t.type}">${TX_TYPES[t.type]}</span>
        <div class="tx-main">
          <div class="money"><b>${sign}${fq(t.qty)}</b> ${esc(c.symbol)}</div>
          <div class="muted small">${dt(t.date)}${t.note ? ' · ' + esc(t.note) : ''}</div>
        </div>
        <div class="tx-num"><span class="money">${t.type === 'out' ? '—' : usd(t.price || 0)}</span><small class="muted">ціна</small></div>
        <div class="tx-num"><span class="money">${total == null ? '—' : usd(total)}</span><small class="muted">${t.fee ? 'комісія ' + usd(t.fee) : 'сума'}</small></div>
        <div class="tx-actions">
          <button class="icon-btn sm" data-act="edit-tx" data-id="${esc(t.id)}" title="Редагувати">${icon('edit', 17)}</button>
          <button class="icon-btn sm danger" data-act="del-tx" data-id="${esc(t.id)}" title="Видалити">${icon('trash', 17)}</button>
        </div>
      </div>`;
  }).join('');

  const tile = (label, val, cls = '', sub = '') =>
    `<div class="tile card"><span class="label">${label}</span><span class="money ${cls}">${val}</span>${sub ? `<small class="${cls || 'muted'}">${sub}</small>` : ''}</div>`;

  return `
    <a class="back" href="#/">${icon('back', 18)} Портфель</a>
    <section class="coin-hero card">
      <div class="ch-head">
        ${logo(id, 'xxl', c)}
        <div class="ch-title">
          <h1>${esc(c.name)} <span class="sym">${esc(c.symbol)}</span></h1>
          <div class="ch-price"><span>${usd(price)}</span>${q?.chg24 != null ? `<span class="chip ${tone(q.chg24)}">${pct(q.chg24)} · 24г</span>` : ''}${mk?.rank ? `<span class="chip flat">#${mk.rank}</span>` : ''}</div>
        </div>
        <button class="btn primary" data-act="add-tx" data-coin="${esc(id)}">${icon('plus', 18)} <span class="desk-only-inline">Транзакція</span></button>
      </div>
      ${mk?.spark ? `<div class="ch-spark">${sparkline(mk.spark, { h: 120, color: (mk.chg7 ?? 0) >= 0 ? UP : DOWN })}<span class="spark-tag">7 днів · ${pct(mk.chg7)}</span></div>` : ''}
    </section>
    ${k.oversold ? `<div class="warn-box">${icon('alert', 18)} Продано або переказано більше монет, ніж було куплено на ту дату. Перевірте дати й кількість у транзакціях.</div>` : ''}
    <div class="tiles">
      ${tile('Кількість', `${fq(k.qty)} ${esc(c.symbol)}`)}
      ${tile('Вартість зараз', usd(value))}
      ${tile('Сер. ціна купівлі', usd(k.avg))}
      ${tile('Собівартість', usd(k.cost), '', 'вкладено в поточні монети')}
      ${tile('Нереалізований P&L', usd(unreal, { sign: true }), tone(unreal), unreal != null && k.cost > 0 ? pct((unreal / k.cost) * 100) : '')}
      ${tile('Реалізований P&L', usd(k.realized, { sign: true }), tone(k.realized), k.sold ? `продано ${fq(k.sold)}` : 'продажів не було')}
      ${tile('Загальний P&L', usd(pnl, { sign: true }), tone(pnl), k.invested > 0 ? pct((pnl / k.invested) * 100) : '')}
      ${tile('Вкладено всього', usd(k.invested), '', `комісії ${usd(k.fees)}`)}
    </div>
    <section class="card tx-card">
      <div class="section-head in"><h2>Транзакції</h2><span class="muted small">${txs.length}</span></div>
      <div class="tx-list">${rows}</div>
    </section>`;
}

// ---------------- Модальні вікна ----------------

function openModal(title, body, { dismissable = true, wide = false } = {}) {
  modalRoot.innerHTML = `
    <div class="modal-wrap">
      <div class="modal-backdrop" ${dismissable ? 'data-act="close-modal"' : ''}></div>
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        ${title ? `<div class="modal-head"><h2>${esc(title)}</h2>${dismissable ? `<button class="icon-btn" data-act="close-modal" aria-label="Закрити">${icon('x')}</button>` : ''}</div>` : ''}
        <div class="modal-body">${body}</div>
      </div>
    </div>`;
  document.body.classList.add('modal-open');
  modalRoot.dataset.dismissable = dismissable ? '1' : '';
  requestAnimationFrame(() => $('.modal-wrap', modalRoot)?.classList.add('in'));
}

function closeModal() {
  modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
}

// ---------------- Форма транзакції ----------------

function openTxModal({ coinId = null, txId = null } = {}) {
  const tx = txId ? S.state.txs.find((t) => t.id === txId) : null;
  const F = {
    coinId: tx?.coinId || coinId,
    coinMeta: null,
    type: tx?.type || 'buy',
    priceTouched: !!tx,
    remote: {},
  };
  if (F.coinId) F.coinMeta = meta(F.coinId);

  openModal(tx ? 'Редагувати транзакцію' : 'Нова транзакція', `
    <form id="tx-form" novalidate autocomplete="off">
      <div class="coin-pick" id="coin-pick"></div>
      <div class="seg" role="radiogroup">
        ${Object.entries(TX_TYPES).map(([k, v]) => `<label><input type="radio" name="type" value="${k}" ${F.type === k ? 'checked' : ''}><span class="t-${k}">${v}</span></label>`).join('')}
      </div>
      <div class="row2">
        <label class="field"><span>Кількість</span><input name="qty" inputmode="decimal" placeholder="0.00" value="${tx ? tx.qty : ''}"></label>
        <label class="field" id="price-field"><span id="price-label">Ціна за монету, $</span><input name="price" inputmode="decimal" placeholder="0.00" value="${tx && tx.type !== 'out' ? tx.price : ''}"></label>
      </div>
      <div class="row2">
        <label class="field"><span>Дата й час</span><input type="datetime-local" name="date" value="${toLocalInput(tx?.date || Date.now())}"></label>
        <label class="field"><span>Комісія, $</span><input name="fee" inputmode="decimal" placeholder="0" value="${tx?.fee || ''}"></label>
      </div>
      <label class="field"><span>Нотатка <em>(необов’язково)</em></span><input name="note" maxlength="140" placeholder="Біржа, гаманець, коментар" value="${esc(tx?.note || '')}"></label>
      <div class="tx-summary" id="tx-summary"></div>
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">${tx ? 'Зберегти зміни' : 'Додати транзакцію'}</button>
    </form>`);

  const form = $('#tx-form');
  const pick = $('#coin-pick');

  function updateType() {
    F.type = form.elements.type.value;
    const pf = $('#price-field');
    pf.hidden = F.type === 'out';
    $('#price-label').textContent = F.type === 'in' ? 'Собівартість за монету, $' : 'Ціна за монету, $';
    form.elements.price.placeholder = F.type === 'in' ? '0 — подарунок / airdrop' : '0.00';
    if (!F.priceTouched && F.coinId && (F.type === 'buy' || F.type === 'sell')) {
      const qp = quote(F.coinId)?.price;
      if (qp != null) form.elements.price.value = String(+qp.toPrecision(8));
    }
    updateSummary();
  }

  function updateSummary() {
    const q = parseNum(form.elements.qty.value), p = parseNum(form.elements.price.value) || 0, f = parseNum(form.elements.fee.value) || 0;
    const sym = F.coinMeta?.symbol || '';
    const el = $('#tx-summary');
    if (!(q > 0)) { el.innerHTML = ''; return; }
    let html = '';
    if (F.type === 'buy') html = `Ви платите <b>${usd(q * p + f)}</b>`;
    else if (F.type === 'sell') html = `Ви отримуєте <b>${usd(q * p - f)}</b>`;
    else if (F.type === 'in') html = `Надходить <b>${fq(q)} ${esc(sym)}</b>${p ? ` із собівартістю ${usd(q * p + f)}` : ''}`;
    else html = `Виходить <b>${fq(q)} ${esc(sym)}</b>${f ? `, комісія ${usd(f)}` : ''}`;
    if ((F.type === 'sell' || F.type === 'out') && F.coinId) {
      const have = computeCoin(S.state.txs.filter((t) => t.coinId === F.coinId && t.id !== tx?.id)).qty;
      if (q > have + 1e-10) html += `<div class="warn-inline">${icon('alert', 14)} У вас лише ${fq(have)} ${esc(sym)}</div>`;
    }
    el.innerHTML = html;
  }

  function renderPick() {
    if (F.coinId) {
      const c = F.coinMeta;
      const qp = quote(F.coinId)?.price;
      pick.innerHTML = `
        <div class="coin-chip">
          ${logo(F.coinId, 'lg', c)}
          <div><b>${esc(c.name)}</b><span class="muted">${esc(c.symbol)}${qp != null ? ' · ' + usd(qp) : ''}</span></div>
          ${tx ? '' : `<button type="button" class="btn ghost sm" data-pick-change>Змінити</button>`}
        </div>`;
      return;
    }
    pick.innerHTML = `
      <label class="field search-field"><span>Монета</span>
        <div class="search-in">${icon('search', 18)}<input id="coin-q" placeholder="Bitcoin, ETH, Solana…" autocomplete="off" spellcheck="false"></div>
      </label>
      <div class="pick-list" id="pick-list"></div>`;
    const qi = $('#coin-q');
    qi.addEventListener('input', () => renderResults(qi.value));
    renderResults('');
    setTimeout(() => qi.focus(), 50);
  }

  function renderResults(qRaw) {
    const q = qRaw.trim().toLowerCase();
    const list = S.market?.list || [];
    let items;
    if (!q) {
      const held = heldIds().map((id) => ({ ...meta(id), held: true }));
      const heldSet = new Set(held.map((h) => h.id));
      items = [...held, ...list.filter((c) => !heldSet.has(c.id)).slice(0, 10)];
    } else {
      const score = (c) => {
        const s = c.symbol.toLowerCase(), n = c.name.toLowerCase();
        if (s === q) return 0;
        if (n === q) return 1;
        if (s.startsWith(q)) return 2;
        if (n.startsWith(q)) return 3;
        if (n.includes(q) || s.includes(q)) return 4;
        return 9;
      };
      items = list.map((c) => [score(c), c]).filter(([s]) => s < 9).sort((a, b) => a[0] - b[0] || (a[1].rank ?? 1e9) - (b[1].rank ?? 1e9)).slice(0, 12).map(([, c]) => c);
    }
    const el = $('#pick-list');
    el.innerHTML = items.map((c) => {
      const m = { id: c.id, name: c.name, symbol: String(c.symbol).toUpperCase(), image: P.safeImg(c.image || '') };
      const qp = quote(c.id)?.price;
      return `<button type="button" class="pick-item" data-pick="${esc(c.id)}">
        ${logo(c.id, 'md', m)}<span class="pi-name"><b>${esc(m.name)}</b><span class="muted">${esc(m.symbol)}${c.held ? ' · у портфелі' : ''}</span></span>
        <span class="pi-price money">${qp != null ? usd(qp) : ''}</span></button>`;
    }).join('') + (q ? `<button type="button" class="pick-remote" data-remote="${esc(qRaw.trim())}">${icon('search', 16)} Шукати «${esc(qRaw.trim())}» у всій базі CoinGecko</button>` : '')
      + (!list.length && !q ? '<div class="muted small pad">Список монет ще завантажується… Введіть назву для пошуку.</div>' : '');
  }

  async function remoteSearch(query, btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner sm"></span> Шукаємо…';
    try {
      const res = await P.search(query);
      res.forEach((c) => (F.remote[c.id] = c));
      $('#pick-list').innerHTML = res.length ? res.map((c) => `
        <button type="button" class="pick-item" data-pick="${esc(c.id)}">
          ${logo(c.id, 'md', { ...c, symbol: c.symbol.toUpperCase() })}<span class="pi-name"><b>${esc(c.name)}</b><span class="muted">${esc(c.symbol.toUpperCase())}${c.rank ? ' · #' + c.rank : ''}</span></span></button>`).join('')
        : '<div class="muted pad">Нічого не знайдено</div>';
    } catch (e) {
      btn.disabled = false;
      btn.textContent = e.code === 429 ? 'CoinGecko обмежив запити, спробуйте пізніше' : 'Помилка пошуку — спробуйте ще раз';
    }
  }

  async function selectCoin(id) {
    const fromMarket = S.market?.byId?.[id];
    const r = F.remote[id];
    const src = fromMarket || r || meta(id);
    F.coinId = id;
    F.coinMeta = { id, name: src.name, symbol: String(src.symbol).toUpperCase(), image: P.safeImg(src.image || '') };
    if (!quote(id)) {
      try { Object.assign(S.state.prices, await P.fetchSimple([id])); } catch { /* ціну можна ввести вручну */ }
    }
    renderPick();
    updateType();
    form.elements.qty.focus();
  }

  pick.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-pick-change')) { F.coinId = null; F.coinMeta = null; F.priceTouched = false; form.elements.price.value = ''; renderPick(); updateSummary(); }
    else if (b.dataset.pick) selectCoin(b.dataset.pick);
    else if (b.dataset.remote) remoteSearch(b.dataset.remote, b);
  });
  form.addEventListener('change', (e) => { if (e.target.name === 'type') updateType(); });
  form.addEventListener('input', (e) => {
    if (e.target.name === 'price') F.priceTouched = true;
    if (['qty', 'price', 'fee'].includes(e.target.name)) updateSummary();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = parseNum(form.elements.qty.value);
    const p = F.type === 'out' ? 0 : parseNum(form.elements.price.value || (F.type === 'in' ? '0' : ''));
    const f = parseNum(form.elements.fee.value || '0');
    const date = new Date(form.elements.date.value).getTime();
    if (!F.coinId) return showErr(form, 'Оберіть монету');
    if (!(q > 0)) return showErr(form, 'Вкажіть кількість більше нуля');
    if ((F.type === 'buy' || F.type === 'sell') && !(p > 0)) return showErr(form, 'Вкажіть ціну за монету');
    if (!(p >= 0)) return showErr(form, 'Невірна ціна');
    if (!(f >= 0)) return showErr(form, 'Невірна комісія');
    if (!isFinite(date)) return showErr(form, 'Вкажіть дату');

    S.state.coins[F.coinId] = { ...F.coinMeta };
    const rec = {
      id: tx?.id || crypto.randomUUID(),
      coinId: F.coinId, type: F.type, qty: q, price: p, fee: f, date,
      note: form.elements.note.value.trim().slice(0, 140),
      created: tx?.created || Date.now(),
      updated: Date.now(),
    };
    if (tx) S.state.txs[S.state.txs.findIndex((t) => t.id === tx.id)] = rec;
    else S.state.txs.push(rec);
    await save();
    closeModal();
    toast(tx ? 'Транзакцію оновлено' : 'Транзакцію додано');
    renderView();
  });

  renderPick();
  updateType();
}

function deleteTx(id) {
  const t = S.state.txs.find((x) => x.id === id);
  if (!t) return;
  const c = meta(t.coinId);
  if (!confirm(`Видалити транзакцію «${TX_TYPES[t.type]} ${fq(t.qty)} ${c.symbol}» від ${dt(t.date)}?`)) return;
  S.state.txs = S.state.txs.filter((x) => x.id !== id);
  (S.state.deleted ??= {})[id] = Date.now();
  save();
  toast('Транзакцію видалено');
  renderView();
}

// ---------------- Налаштування ----------------

function openSettings() {
  const s = S.state.settings;
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] }));
  openModal('Налаштування', `
    <div class="set-group">
      <h3>${icon('lock', 16)} Безпека</h3>
      <label class="set-row"><span>Автоблокування</span>
        <select id="autolock">
          ${[[1, '1 хв'], [5, '5 хв'], [15, '15 хв'], [30, '30 хв'], [60, '1 год'], [0, 'Ніколи']].map(([v, l]) => `<option value="${v}" ${s.autoLockMin === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </label>
      <button class="set-row btn-row" data-act="change-pw"><span>Змінити головний пароль</span>${icon('chevron', 18)}</button>
      <button class="set-row btn-row" data-act="new-rk"><span>Створити новий ключ відновлення</span>${icon('chevron', 18)}</button>
    </div>
    <div class="set-group" id="sync-group">${syncGroupHtml()}</div>
    <div class="set-group">
      <h3>${icon('download', 16)} Резервна копія</h3>
      <p class="muted small">Файл зашифрований тим самим паролем. Зберігайте копії в кількох місцях — у хмарі, на флешці. Без пароля або ключа відновлення файл марний.</p>
      <div class="btn-line">
        <button class="btn" data-act="export">${icon('download', 18)} Завантажити копію</button>
        ${canShare ? `<button class="btn" data-act="share-backup">${icon('share', 18)} Зберегти у Файли</button>` : ''}
        <button class="btn" data-act="import">${icon('upload', 18)} Відновити з файлу</button>
      </div>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </div>
    <div class="set-group">
      <h3>${icon('alert', 16)} Небезпечна зона</h3>
      <button class="btn danger-btn" data-act="wipe">${icon('trash', 18)} Видалити всі дані з цього пристрою</button>
    </div>
    <div class="set-about muted small">
      CryptoTracker ${APP_VERSION} · ${S.state.txs.length} ${plural(S.state.txs.length, 'транзакція', 'транзакції', 'транзакцій')}<br>
      Шифрування: AES-256-GCM, ключ із пароля — Argon2id (64 МБ, 3 проходи).<br>
      Останнє збереження: ${S.vault.updatedAt ? dt(S.vault.updatedAt) : '—'}
    </div>`);
  $('#autolock').addEventListener('change', (e) => {
    s.autoLockMin = +e.target.value;
    save();
    toast('Збережено');
  });
  $('#import-file').addEventListener('change', (e) => importBackup(e.target.files[0]));
  bindSyncGroup();
}

function syncGroupHtml() {
  const cfg = syncCfg();
  const head = `<h3>${icon('cloud', 16)} Синхронізація</h3>`;
  if (cfg) {
    return `${head}
      <div class="set-row"><span>Репозиторій</span><b class="mono">${esc(cfg.repo)}</b></div>
      <div class="set-row"><span>Стан</span><span class="status sync-status">${syncStatusHtml()}</span></div>
      <div class="warn-box" id="sync-diff" ${SYNC.err === 'DIFFERENT_KEY' ? '' : 'hidden'}>${icon('alert', 18)}
        <div>На GitHub лежить портфель, зашифрований іншим ключем (наприклад, після відновлення з файлу або створення нового сховища).
        <button class="btn sm" data-act="sync-overwrite" style="margin-top:10px">Замінити портфель на GitHub даними з цього пристрою</button></div>
      </div>
      <div class="btn-line">
        <button class="btn" data-act="sync-now">${icon('refresh', 18)} Синхронізувати зараз</button>
        <button class="btn" data-act="sync-off">Вимкнути на цьому пристрої</button>
      </div>`;
  }
  return `${head}
    <p class="muted small">Зашифрований портфель зберігатиметься у вашому приватному репозиторії GitHub, і всі ваші пристрої бачитимуть ті самі дані. GitHub отримує лише зашифровані байти.</p>
    <form id="sync-form" novalidate autocomplete="off">
      <label class="field"><span>Репозиторій</span><input name="repo" value="${esc(DEFAULT_REPO)}" placeholder="користувач/cryptotracker-data" spellcheck="false" autocapitalize="off"></label>
      <label class="field"><span>Токен доступу</span><input type="password" name="token" placeholder="github_pat_…" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
      ${TOKEN_HELP}
      <div class="form-err" hidden></div>
      <button class="btn primary block" type="submit">${icon('cloud', 18)} Увімкнути синхронізацію</button>
    </form>`;
}

function bindSyncGroup() {
  const form = $('#sync-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const repo = Sync.parseRepo(form.elements.repo.value);
    const token = form.elements.token.value.trim();
    if (!repo) return showErr(form, syncErrText('BAD_REPO'));
    if (!token) return showErr(form, 'Вставте токен доступу');
    const cfg = { repo: repo.full, token };
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Перевіряємо доступ…');
    try {
      await Sync.checkRepo(cfg);
      const remote = await Sync.pull(cfg);
      let overwrite = false;
      if (remote) {
        let ok = false;
        try { ok = V.isVault(remote.vault) && !!(await V.openData(remote.vault, S.dek)); } catch { ok = false; }
        if (!ok) {
          if (!confirm('У репозиторії вже є портфель, зашифрований іншим ключем.\n\nЗамінити його даними з цього пристрою? Попередня версія залишиться в історії репозиторію на GitHub.\n\nЯкщо хочете навпаки — отримати той портфель сюди — натисніть «Скасувати», видаліть дані на цьому пристрої і оберіть «Уже маю портфель на іншому пристрої».')) {
            busy(btn, false);
            return;
          }
          overwrite = true;
        }
      }
      S.state.sync = { ...cfg, since: Date.now() };
      await save({ sync: false });
      await syncNow({ overwrite });
      $('#sync-group').innerHTML = syncGroupHtml();
      bindSyncGroup();
      if (!SYNC.err) toast('Синхронізацію увімкнено');
    } catch (e2) {
      busy(btn, false);
      showErr(form, syncErrText(e2.code || e2.message));
    }
  });
}

function backupFile() {
  const d = new Date();
  const name = `cryptotracker-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  return new File([JSON.stringify(S.vault)], name, { type: 'application/json' });
}

async function exportBackup() {
  await saveChain;
  const f = backupFile();
  const url = URL.createObjectURL(f);
  const a = Object.assign(document.createElement('a'), { href: url, download: f.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Резервну копію збережено');
}

async function shareBackup() {
  await saveChain;
  try { await navigator.share({ files: [backupFile()], title: 'CryptoTracker backup' }); }
  catch (e) { if (e.name !== 'AbortError') toast('Не вдалося поділитися файлом', 'err'); }
}

async function importBackup(file) {
  if (!file) return;
  let vault;
  try { vault = JSON.parse(await file.text()); } catch { return toast('Це не файл резервної копії', 'err'); }
  if (!V.isVault(vault)) return toast('Це не файл резервної копії CryptoTracker', 'err');
  const when = vault.updatedAt ? dt(vault.updatedAt) : 'невідомо';
  if (!confirm(`Відновити копію від ${when}?\n\nПоточні дані на цьому пристрої буде замінено. Після цього введіть пароль, яким була зашифрована копія.`)) return;
  await saveChain;
  await db.set('vault', vault);
  lock();
}

function openChangePassword() {
  openModal('Змінити пароль', `
    <form id="cp-form" novalidate>
      ${USERNAME_FIELD}
      <label class="field"><span>Поточний пароль</span><input type="password" name="old" autocomplete="current-password" autofocus></label>
      <label class="field"><span>Новий пароль</span><input type="password" name="pw" autocomplete="new-password"></label>
      <div class="strength" data-s="-1"><i></i><i></i><i></i><i></i><i></i><span></span></div>
      <label class="field"><span>Повторіть новий пароль</span><input type="password" name="pw2" autocomplete="new-password"></label>
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">Змінити пароль</button>
    </form>`);
  const form = $('#cp-form');
  bindStrength(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = checkNewPassword(form.elements.pw.value, form.elements.pw2.value);
    if (err) return showErr(form, err);
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Перешифровуємо…');
    try {
      await saveChain;
      await V.changePassword(S.vault, form.elements.old.value, form.elements.pw.value);
      await save();
      closeModal();
      toast('Пароль змінено. Не забудьте оновити резервні копії');
    } catch (e2) {
      busy(btn, false);
      showErr(form, e2.message === 'WRONG_PASSWORD' ? 'Невірний поточний пароль' : 'Помилка: ' + e2.message);
    }
  });
}

function openNewRecovery() {
  openModal('Новий ключ відновлення', `
    <p class="muted">Старий ключ перестане працювати. Резервні копії, створені раніше, і далі відкриватимуться старим ключем.</p>
    <form id="rk-form" novalidate>
      ${USERNAME_FIELD}
      <label class="field"><span>Головний пароль</span><input type="password" name="pw" autocomplete="current-password" autofocus></label>
      <div class="form-err" hidden></div>
      <button class="btn primary block lg" type="submit">Створити ключ</button>
    </form>`);
  const form = $('#rk-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    busy(btn, true, 'Створюємо…');
    try {
      await saveChain;
      const rk = await V.newRecoveryKey(S.vault, form.elements.pw.value);
      await save();
      renderRecoveryKey(rk, closeModal, true);
    } catch (e2) {
      busy(btn, false);
      showErr(form, e2.message === 'WRONG_PASSWORD' ? 'Невірний пароль' : 'Помилка: ' + e2.message);
    }
  });
}

async function wipe() {
  const answer = prompt('Усі транзакції на цьому пристрої буде видалено назавжди. Відновити їх можна лише з резервної копії.\n\nЩоб підтвердити, введіть слово ВИДАЛИТИ');
  if (answer?.trim().toUpperCase() !== 'ВИДАЛИТИ') return;
  await saveChain;
  await db.clear();
  lock();
}

// ---------------- Події ----------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const handlers = {
    'add-tx': () => openTxModal({ coinId: el.dataset.coin || null }),
    'edit-tx': () => openTxModal({ txId: el.dataset.id }),
    'del-tx': () => deleteTx(el.dataset.id),
    'close-modal': closeModal,
    'refresh': () => refreshPrices(true),
    'lock': lock,
    'settings': openSettings,
    'toggle-hide': () => {
      S.state.settings.hideValues = !S.state.settings.hideValues;
      document.body.classList.toggle('hide-values', S.state.settings.hideValues);
      el.innerHTML = icon(S.state.settings.hideValues ? 'eyeOff' : 'eye');
      save();
    },
    'export': exportBackup,
    'share-backup': shareBackup,
    'import': () => $('#import-file').click(),
    'change-pw': openChangePassword,
    'new-rk': openNewRecovery,
    'wipe': wipe,
    'sync-now': () => syncNow({ manual: true }),
    'sync-overwrite': async () => {
      if (!confirm('Замінити портфель на GitHub даними з цього пристрою? Попередня версія залишиться в історії репозиторію.')) return;
      await syncNow({ overwrite: true, manual: true });
      updateSyncUI();
    },
    'sync-off': async () => {
      if (!confirm('Вимкнути синхронізацію на цьому пристрої? Дані на GitHub і на інших пристроях залишаться.')) return;
      delete S.state.sync;
      SYNC.err = null; SYNC.at = null;
      await save({ sync: false });
      $('#sync-group').innerHTML = syncGroupHtml();
      bindSyncGroup();
      renderView();
      toast('Синхронізацію вимкнено');
    },
  };
  if (handlers[act]) { e.preventDefault(); handlers[act](); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalRoot.dataset.dismissable && modalRoot.innerHTML) closeModal();
});

// ---------------- Старт ----------------

async function boot() {
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  if (!window.isSecureContext || !crypto.subtle) {
    app.innerHTML = authShell('<h1>Потрібне захищене з’єднання</h1><p class="muted">Відкрийте CryptoTracker через https:// — інакше браузер не дає доступу до шифрування.</p>');
    return;
  }
  if (location.hostname === 'localhost' && localStorage.getItem('ct-dev-mock-github')) {
    await import('./dev-mock-github.js').catch(() => {});
  }
  try {
    S.market = await P.loadCachedMarket();
    const vault = await db.get('vault');
    if (V.isVault(vault)) { S.vault = vault; renderUnlock(); }
    else renderSetup();
  } catch (e) {
    console.error(e);
    app.innerHTML = authShell(`<h1>Не вдалося відкрити сховище</h1><p class="muted">${esc(e.message)}</p>`);
  }
}

boot();
