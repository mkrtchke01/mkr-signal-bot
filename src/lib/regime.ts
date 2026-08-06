// Режим рынка по BTC: боты торгуют только в сторону краткосрочного тренда биткоина.
// Когда BTC болтается между уровнями, режим нейтральный и новые сетапы не ищутся.

import { lastEma } from "./indicators";
import type { Candle } from "./types";

export type RegimeBias = "LONG" | "SHORT" | "NEUTRAL";

export interface RegimeInfo {
  bias: RegimeBias;
  price: number;
  ema20d: number;
  ema50d: number;
  ema20h4: number;
  ema50h4: number;
  note: string;
  updatedMs: number;
}

export function detectRegime(d1: Candle[], h4: Candle[]): RegimeInfo {
  const closes1d = d1.map((c) => c.close);
  const closes4h = h4.map((c) => c.close);
  const price = closes4h[closes4h.length - 1];
  const ema20d = lastEma(closes1d, 20);
  const ema50d = lastEma(closes1d, 50);
  const ema20h4 = lastEma(closes4h, 20);
  const ema50h4 = lastEma(closes4h, 50);

  let bias: RegimeBias = "NEUTRAL";
  let note = "BTC между уровнями — новые сетапы не ищем, ждём определённости.";
  if (price > ema20d && ema20h4 > ema50h4) {
    bias = "LONG";
    note = price > ema50d
      ? "BTC в аптренде: выше дневных EMA20 и EMA50."
      : "BTC в отскоке: выше дневной EMA20, но под дневной EMA50 — лонги с повышенной осторожностью.";
  } else if (price < ema20d && ema20h4 < ema50h4) {
    bias = "SHORT";
    note = price < ema50d
      ? "BTC в даунтренде: ниже дневных EMA20 и EMA50."
      : "BTC в откате вниз: под дневной EMA20, но над дневной EMA50 — шорты с повышенной осторожностью.";
  }
  return { bias, price, ema20d, ema50d, ema20h4, ema50h4, note, updatedMs: Date.now() };
}
