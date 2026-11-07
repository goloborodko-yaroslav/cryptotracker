// Розрахунок P&L методом середньої ціни (як на CryptoRank).
//
// Купівля:        кількість += q; собівартість += q·ціна + комісія
// Переказ (вхід): кількість += q; собівартість += q·ціна(необов'язково) + комісія
// Продаж:         собівартість зменшується пропорційно (за середньою ціною),
//                 реалізований P&L += q·ціна − комісія − списана собівартість
// Переказ (вихід):собівартість зменшується пропорційно, комісія йде у збиток
// Середня ціна купівлі = собівартість / кількість.

export const TX_TYPES = {
  buy: 'Купівля',
  sell: 'Продаж',
  in: 'Переказ (вхід)',
  out: 'Переказ (вихід)',
};

const EPS = 1e-10;

export function sortTxs(txs) {
  return [...txs].sort((a, b) => (a.date - b.date) || ((a.created || 0) - (b.created || 0)));
}

export function computeCoin(txs) {
  let qty = 0, cost = 0, realized = 0, invested = 0, bought = 0, sold = 0, fees = 0, oversold = false;
  for (const t of sortTxs(txs)) {
    const q = +t.qty || 0, p = +t.price || 0, f = +t.fee || 0;
    fees += f;
    if (t.type === 'buy' || t.type === 'in') {
      qty += q;
      cost += q * p + f;
      invested += q * p + f;
      if (t.type === 'buy') bought += q;
    } else if (t.type === 'sell' || t.type === 'out') {
      const take = Math.min(q, qty);
      if (q - take > EPS) oversold = true;
      const avg = qty > 0 ? cost / qty : 0;
      const out = avg * take;
      cost -= out;
      qty -= take;
      if (t.type === 'sell') { realized += q * p - f - out; sold += q; }
      else realized -= f;
    }
    if (qty <= EPS) { qty = 0; cost = 0; }
  }
  return { qty, cost, avg: qty > 0 ? cost / qty : 0, realized, invested, bought, sold, fees, oversold, count: txs.length };
}

// quote(id) → { price, chg24, ... } | null
export function computePortfolio(txs, quote) {
  const byCoin = new Map();
  for (const t of txs) {
    if (!byCoin.has(t.coinId)) byCoin.set(t.coinId, []);
    byCoin.get(t.coinId).push(t);
  }
  const holdings = [], closed = [];
  const T = { value: 0, cost: 0, realized: 0, unreal: 0, invested: 0, chg24: 0, missingPrices: 0 };

  for (const [id, list] of byCoin) {
    const c = computeCoin(list);
    const q = quote(id);
    const price = q?.price ?? null;
    const value = price != null ? c.qty * price : null;
    const unreal = value != null ? value - c.cost : null;
    const chg24 = q?.chg24 ?? null;
    const chg24Value = value != null && chg24 != null ? value - value / (1 + chg24 / 100) : 0;
    const pnl = c.realized + (unreal ?? 0);
    const row = {
      id, ...c, price, value, unreal, chg24, chg24Value, pnl,
      unrealPct: unreal != null && c.cost > 0 ? (unreal / c.cost) * 100 : null,
      pnlPct: c.invested > 0 ? (pnl / c.invested) * 100 : null,
    };
    T.realized += c.realized;
    T.invested += c.invested;
    if (c.qty > 0) {
      holdings.push(row);
      T.cost += c.cost;
      if (value == null) T.missingPrices++;
      else { T.value += value; T.unreal += unreal; T.chg24 += chg24Value; }
    } else {
      closed.push(row);
    }
  }
  holdings.sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  closed.sort((a, b) => b.realized - a.realized);
  T.pnl = T.realized + T.unreal;
  T.pnlPct = T.invested > 0 ? (T.pnl / T.invested) * 100 : null;
  const prev = T.value - T.chg24;
  T.chg24Pct = prev > 0 ? (T.chg24 / prev) * 100 : null;
  for (const h of holdings) h.share = T.value > 0 && h.value != null ? (h.value / T.value) * 100 : 0;
  return { holdings, closed, totals: T };
}
