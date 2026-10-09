// Денежная модель сделок трейдер-бота (USDT-перпы).
//
// Риск — доля баланса счёта (по умолчанию 1%), а не процент движения цены:
// баланс $300 → риск $3, вырос до $400 → $4, упал — риск меньше. От этого:
//  1. Стоп даёт стратегия (он стоит за структурой) → известна дистанция до стопа.
//  2. Объём позиции подбирается так, чтобы срабатывание стопа стоило ровно
//     риск сделки — вместе с комиссиями за вход и выход.
//  3. Плечо — максимальное, какое даёт биржа по монете, но такое, чтобы цена
//     ликвидации была минимум LIQ_SAFETY раз дальше стопа: стоп срабатывает
//     заметно раньше ликвидации. Чем выше плечо, тем меньше маржи занимает
//     сделка и тем больше сделок помещается в баланс.
//
// Вход и выход — по рынку, поэтому обе стороны считаем по тейкерской комиссии.
// Комиссия — параметр: боты торгуют на разных биржах, а ставка входит в риск.
// Значение по умолчанию — Bybit, под который считались первые боты.

import type { Direction, TradePlan } from "./types";

export const RISK_USD = 3;         // риск сделок, открытых до риска от баланса
export const DEFAULT_RISK_PCT = 1; // риск на сделку, % баланса
export const TAKER_FEE = 0.00055;  // Bybit, тейкер 0.055% (вход/выход по рынку)
export const MAKER_FEE = 0.0001;   // Bybit, мейкер 0.01% (лимитный тейк)
export const MMR = 0.005;          // маинтенанс-маржа, консервативно 0.5%
export const LIQ_SAFETY = 2;       // ликвидация не ближе 2× дистанции до стопа
export const MAX_LEVERAGE = 20;    // потолок, если биржевой не передан

// Потолок плеча BingX по монете. Публичный API его не отдаёт (только приватный
// с ключом), поэтому таблица консервативная: биржа даёт не меньше этого.
// Ниже реального потолка — безопасно: маржи чуть больше, зато ордер встанет.
const LEVERAGE_100 = new Set(["BTCUSDT", "ETHUSDT"]);
const LEVERAGE_50 = new Set([
  "SOLUSDT", "XRPUSDT", "BNBUSDT", "DOGEUSDT", "ADAUSDT", "LTCUSDT", "LINKUSDT",
  "AVAXUSDT", "DOTUSDT", "TRXUSDT", "BCHUSDT", "SUIUSDT", "TONUSDT", "NEARUSDT",
]);
export function leverageCap(symbol: string): number {
  const s = symbol.toUpperCase();
  if (LEVERAGE_100.has(s)) return 100;
  if (LEVERAGE_50.has(s)) return 50;
  return 25;
}

// Риск сделки в $ от текущего баланса
export function riskUsdFor(balance: number, riskPct: number): number {
  if (!(balance > 0) || !(riskPct > 0)) return 0;
  return r2(balance * riskPct / 100);
}

const r2 = (v: number) => Math.round(v * 100) / 100;
// Маржу округляем вверх: залог не должен оказаться меньше нужного под объём
const up2 = (v: number) => Math.ceil(v * 100) / 100;

// PnL по доле w позиции при выходе по цене exit, за вычетом комиссий обеих сторон.
function legPnl(
  qty: number, w: number, entry: number, exit: number, isLong: boolean, fee: number,
): number {
  const q = qty * w;
  const gross = isLong ? q * (exit - entry) : q * (entry - exit);
  return gross - q * (entry + exit) * fee;
}

// Максимальное плечо, при котором ликвидация остаётся за стопом:
// дистанция до ликвидации ≈ 1/L − MMR, требуем её ≥ LIQ_SAFETY × дистанции до стопа.
export function pickLeverage(stopFrac: number, cap = MAX_LEVERAGE): number {
  const max = 1 / (stopFrac * LIQ_SAFETY + MMR);
  return Math.max(1, Math.min(cap, Math.floor(max)));
}

export function buildPlan(
  direction: Direction, entry: number, stop: number, tp1: number,
  feeRate = TAKER_FEE,
  tpFinal: number | null = null, // остаток после TP1 в безубытке идёт до этой цели
  opts: { riskUsd?: number; maxLeverage?: number } = {},
): TradePlan | null {
  const riskUsd = opts.riskUsd ?? RISK_USD;
  if (!(riskUsd > 0)) return null;
  const isLong = direction === "LONG";
  const risk = Math.abs(entry - stop);
  if (!(entry > 0) || !(risk > 0)) return null;

  const stopFrac = risk / entry;
  // Стоп = движение цены + комиссии входа и выхода. Решаем относительно qty.
  const qty = riskUsd / (risk + feeRate * (entry + stop));
  const notional = qty * entry;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const leverage = pickLeverage(stopFrac, opts.maxLeverage ?? MAX_LEVERAGE);
  const liqFrac = 1 / leverage - MMR;
  const liqPrice = isLong ? entry * (1 - liqFrac) : entry * (1 + liqFrac);

  const half1 = legPnl(qty, 0.5, entry, tp1, isLong, feeRate);
  return {
    riskUsd: r2(riskUsd),
    feeRate,
    feeUsd: r2(notional * feeRate * 2),
    leverage,
    qty,
    notional: r2(notional),
    margin: up2(notional / leverage),
    liqPrice,
    stopPct: r2(stopFrac * 100),
    liqPct: r2(liqFrac * 100),
    pnl: {
      tp1: r2(half1),
      // после TP1 стоп на остаток остаётся исходным — это и есть худший исход;
      // при переносе в безубыток худший исход — остаток закрыт по входу
      part: r2(half1 + legPnl(qty, 0.5, entry, tpFinal ? entry : stop, isLong, feeRate)),
      sl: r2(legPnl(qty, 1, entry, stop, isLong, feeRate)),
      tpFull: r2(legPnl(qty, 1, entry, tp1, isLong, feeRate)),
      ...(tpFinal ? { final: r2(half1 + legPnl(qty, 0.5, entry, tpFinal, isLong, feeRate)) } : {}),
    },
  };
}

// Фактический результат в долларах: если TP1 уже сработал, половина зафиксирована
// по TP1, остаток вышел по exit; иначе вся позиция вышла по exit.
// Комиссию берём из плана сетапа — по ставке той биржи, где он открывался.
export function realizedPnl(
  plan: TradePlan, direction: Direction,
  entry: number, tp1: number, exit: number, tp1Done: boolean,
): number {
  const isLong = direction === "LONG";
  const fee = plan.feeRate > 0 ? plan.feeRate : TAKER_FEE;
  return r2(tp1Done
    ? legPnl(plan.qty, 0.5, entry, tp1, isLong, fee)
      + legPnl(plan.qty, 0.5, entry, exit, isLong, fee)
    : legPnl(plan.qty, 1, entry, exit, isLong, fee));
}
