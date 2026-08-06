// Стратегия «Пробой по тренду» — трендследящая модель на 4h.
//
// Логика намеренно короткая: чем меньше условий, тем меньше подгонки под прошлое.
//  1. Режим рынка по BTC — торгуем только в его сторону.
//  2. Монета должна быть в том же тренде: EMA50 > EMA200 на 4h и цена выше
//     дневной EMA200 (для шортов зеркально).
//  3. Вход — когда закрытие 4h-свечи обновляет экстремум 20 предыдущих
//     закрытий, то есть цена вышла из диапазона в сторону тренда.
//  4. Подтверждение: ждём час после закрытия пробойной свечи и входим по рынку.
//     Ложные пробои за этот час часто откатываются — на тестах ожидание
//     заметно улучшало результат.
//  5. Стоп 2.5×ATR(14, 4h) от фактического входа.
//  6. Цели широкие: TP1 на 3R (фиксируем половину, стоп в безубыток),
//     TP2 на 6R. Узкие цели режут те самые редкие большие движения, ради
//     которых стратегия и существует, — на тестах они стабильно хуже.
//  7. Если за 30 дней не сработало ни то ни другое — выходим по рынку.
//     Без этого лимита позиции занимают слоты месяцами и результат рушится.
//
// Профиль: винрейт около 34%, медианная сделка отрицательная, весь результат
// дают ~22% сделок, доходящих до целей.

import { atrWilder, lastEma } from "./indicators";
import type { Candle, Direction } from "./types";
import type { RegimeBias } from "./regime";

export const BREAKOUT_PERIOD = 20;  // сколько 4h-закрытий должен пробить сигнал
export const STOP_ATR = 2.5;        // стоп в ATR от входа
export const TP1_R = 3;             // первая цель: фикс 50% + стоп в безубыток
export const TP2_R = 6;             // вторая цель: закрытие остатка
export const MAX_HOLD_HOURS = 30 * 24;        // дальше выходим по рынку
export const CONFIRM_MIN_MS = 3_600_000;      // ждём час после закрытия свечи
export const CONFIRM_MAX_MS = 3 * 3_600_000;  // позже 3 часов не входим — поздно

export interface BreakoutCandidate {
  symbol: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  atr: number;
  score: number;
  reasons: { entry: string; stop: string; tp1: string; tp2: string };
}

function fmt(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return p.toPrecision(4);
}

// Экстремум закрытий за `period` баров, заканчивая баром before (не включая его)
function extremeClose(
  h4: Candle[], before: number, period: number, kind: "max" | "min",
): number {
  let v = kind === "max" ? -Infinity : Infinity;
  for (let i = before - period; i < before; i++) {
    if (i < 0) return NaN;
    v = kind === "max" ? Math.max(v, h4[i].close) : Math.min(v, h4[i].close);
  }
  return v;
}

/**
 * Ищет пробойный сетап. Все свечи — только закрытые.
 * @param livePrice текущая цена: вход по рынку через час после пробоя
 * @param now момент проверки — от него считается возраст пробойной свечи
 */
export function findBreakout(
  symbol: string, d1: Candle[], h4: Candle[],
  bias: RegimeBias, livePrice: number, now = Date.now(),
): BreakoutCandidate | null {
  if (bias === "NEUTRAL") return null;
  if (!Number.isFinite(livePrice) || livePrice <= 0) return null;
  if (h4.length < 210 || d1.length < 200) return null;

  const last = h4[h4.length - 1];
  const age = now - last.closeTime;
  if (age < CONFIRM_MIN_MS || age > CONFIRM_MAX_MS) return null;

  const closes4h = h4.map((c) => c.close);
  const ema50 = lastEma(closes4h, 50);
  const ema200 = lastEma(closes4h, 200);
  const ema200d = lastEma(d1.map((c) => c.close), 200);
  const a = atrWilder(h4);
  if ([ema50, ema200, ema200d, a].some(Number.isNaN) || a <= 0) return null;

  const i = h4.length - 1;
  const up = ema50 > ema200 && last.close > ema200d;
  const down = ema50 < ema200 && last.close < ema200d;

  let direction: Direction | null = null;
  if (bias === "LONG" && up && last.close > extremeClose(h4, i, BREAKOUT_PERIOD, "max")) {
    direction = "LONG";
  } else if (bias === "SHORT" && down && last.close < extremeClose(h4, i, BREAKOUT_PERIOD, "min")) {
    direction = "SHORT";
  }
  if (!direction) return null;

  const isLong = direction === "LONG";
  // Пробой должен быть ещё жив: цена не вернулась в диапазон за час подтверждения
  if (isLong ? livePrice < last.close - a : livePrice > last.close + a) return null;

  const entry = livePrice;
  const stop = isLong ? entry - STOP_ATR * a : entry + STOP_ATR * a;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const at = (r: number) => (isLong ? entry + r * risk : entry - r * risk);
  const tp1 = at(TP1_R);
  const tp2 = at(TP2_R);

  const range = fmt(extremeClose(h4, i, BREAKOUT_PERIOD, isLong ? "max" : "min"));
  const word = isLong ? "выше" : "ниже";
  const reasons = {
    entry: `закрытие 4h ${fmt(last.close)} пробило ${word} экстремума `
      + `${BREAKOUT_PERIOD} предыдущих закрытий (${range}) в сторону тренда: `
      + `EMA50 ${word} EMA200 на 4h, цена ${word} дневной EMA200 ${fmt(ema200d)}. `
      + `Вход по рынку через час после пробоя — подтверждение, что откат не съел движение`,
    stop: `${STOP_ATR}×ATR(14, 4h) = ${fmt(STOP_ATR * a)} от входа — цена там означает, `
      + `что пробой был ложным`,
    tp1: `${TP1_R}R = ${fmt(tp1)}: фиксируем половину и переносим стоп в безубыток`,
    tp2: `${TP2_R}R = ${fmt(tp2)}: цели широкие намеренно — весь заработок стратегии `
      + `дают редкие длинные движения, узкие тейки их срезают`,
  };

  return { symbol, direction, entry, stop, tp1, tp2, atr: a,
    // сила выноса относительно волатильности: чем дальше цена ушла от EMA50, тем выше приоритет
    score: Math.abs(last.close - ema50) / a,
    reasons };
}
