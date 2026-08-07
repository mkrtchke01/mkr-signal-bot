// Денежная модель сделок трейдер-бота (Bybit USDT-перпы).
//
// Риск фиксирован в долларах, а не в процентах движения цены. От этого пляшет всё:
//  1. Стоп даёт стратегия (он стоит за структурой) → известна дистанция до стопа.
//  2. Объём позиции подбирается так, чтобы срабатывание стопа стоило ровно
//     RISK_USD — вместе с комиссиями за вход и выход.
//  3. Плечо подбирается так, чтобы цена ликвидации была минимум LIQ_SAFETY раз
//     дальше стопа: стоп всегда срабатывает заметно раньше ликвидации.
//
// Вход и выход — по рынку, поэтому обе стороны считаем по тейкерской комиссии.

import type { Direction, TradePlan } from "./types";

export const RISK_USD = 3;         // потеря на стопе, включая комиссии
export const TAKER_FEE = 0.00055;  // Bybit, тейкер 0.055% (вход/выход по рынку)
export const MMR = 0.005;          // маинтенанс-маржа, консервативно 0.5%
export const LIQ_SAFETY = 2;       // ликвидация не ближе 2× дистанции до стопа
export const MAX_LEVERAGE = 20;    // потолок даже на очень узких стопах

const r2 = (v: number) => Math.round(v * 100) / 100;
// Маржу округляем вверх: залог не должен оказаться меньше нужного под объём
const up2 = (v: number) => Math.ceil(v * 100) / 100;

// PnL по доле w позиции при выходе по цене exit, за вычетом комиссий обеих сторон.
function legPnl(
  qty: number, w: number, entry: number, exit: number, isLong: boolean,
): number {
  const q = qty * w;
  const gross = isLong ? q * (exit - entry) : q * (entry - exit);
  return gross - q * (entry + exit) * TAKER_FEE;
}

// Максимальное плечо, при котором ликвидация остаётся за стопом:
// дистанция до ликвидации ≈ 1/L − MMR, требуем её ≥ LIQ_SAFETY × дистанции до стопа.
export function pickLeverage(stopFrac: number): number {
  const max = 1 / (stopFrac * LIQ_SAFETY + MMR);
  return Math.max(1, Math.min(MAX_LEVERAGE, Math.floor(max)));
}

export function buildPlan(
  direction: Direction, entry: number, stop: number, tp1: number,
): TradePlan | null {
  const isLong = direction === "LONG";
  const risk = Math.abs(entry - stop);
  if (!(entry > 0) || !(risk > 0)) return null;

  const stopFrac = risk / entry;
  // Стоп = движение цены + комиссии входа и выхода. Решаем относительно qty.
  const qty = RISK_USD / (risk + TAKER_FEE * (entry + stop));
  const notional = qty * entry;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const leverage = pickLeverage(stopFrac);
  const liqFrac = 1 / leverage - MMR;
  const liqPrice = isLong ? entry * (1 - liqFrac) : entry * (1 + liqFrac);

  const half1 = legPnl(qty, 0.5, entry, tp1, isLong);
  return {
    riskUsd: RISK_USD,
    feeRate: TAKER_FEE,
    feeUsd: r2(notional * TAKER_FEE * 2),
    leverage,
    qty,
    notional: r2(notional),
    margin: up2(notional / leverage),
    liqPrice,
    stopPct: r2(stopFrac * 100),
    liqPct: r2(liqFrac * 100),
    pnl: {
      tp1: r2(half1),
      // после TP1 стоп на остаток остаётся исходным — это и есть худший исход
      part: r2(half1 + legPnl(qty, 0.5, entry, stop, isLong)),
      sl: r2(legPnl(qty, 1, entry, stop, isLong)),
    },
  };
}

// Фактический результат в долларах: если TP1 уже сработал, половина зафиксирована
// по TP1, остаток вышел по exit; иначе вся позиция вышла по exit.
export function realizedPnl(
  plan: TradePlan, direction: Direction,
  entry: number, tp1: number, exit: number, tp1Done: boolean,
): number {
  const isLong = direction === "LONG";
  return r2(tp1Done
    ? legPnl(plan.qty, 0.5, entry, tp1, isLong) + legPnl(plan.qty, 0.5, entry, exit, isLong)
    : legPnl(plan.qty, 1, entry, exit, isLong));
}
