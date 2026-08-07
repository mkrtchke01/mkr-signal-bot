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
//  6. TP1 на 1.5R: фиксируем половину. Уровень выбран так, чтобы сделка,
//     дошедшая до цели и потом развернувшаяся, всё равно закрылась в плюс:
//     половина взяла +1.5R, остаток отдал −1R, итог +0.25R. Это вдвое укорачивает
//     серии убытков подряд по сравнению с фиксацией на 3R.
//  7. Трейлинг включается отдельно, на 5R, и ведёт остаток с шагом 3×ATR.
//     Фиксированной второй цели нет: она срезала бы редкие длинные движения,
//     ради которых стратегия и существует.
//  8. Если за 30 дней не сработало ничего — выходим по рынку. Без этого лимита
//     позиции занимают слоты месяцами и результат рушится.
//
// В момент активации трейлинг стоит уже на 9.5×ATR выше входа (5R − 3×ATR),
// то есть переносить стоп в безубыток отдельно не нужно — трейлинг заведомо выше.

import { atrWilder, lastEma } from "./indicators";
import type { Candle, Direction } from "./types";
import type { RegimeBias } from "./regime";

export const BREAKOUT_PERIOD = 20;  // сколько 4h-закрытий должен пробить сигнал
export const STOP_ATR = 2.5;        // стоп в ATR от входа
export const TP1_R = 1.5;           // фикс 50% позиции
export const TRAIL_ACTIVATE_R = 5;  // с этого уровня включается трейлинг
export const TRAIL_ATR = 3;         // шаг трейлинга в ATR
export const MAX_HOLD_HOURS = 30 * 24;        // общий предел жизни сделки
// Пробой, не прошедший 1R за 5 дней, уже неудачный: держать его — значит
// занимать слот и платить фандинг за идею, которая не работает.
export const EARLY_EXIT_HOURS = 5 * 24;
export const EARLY_EXIT_R = 1;
// Три однонаправленные позиции по альтам — это одна ставка тройным размером,
// потому что альты ходят вместе. Больше двух в одну сторону не набираем.
export const MAX_PER_DIRECTION = 2;
export const CONFIRM_MIN_MS = 3_600_000;      // ждём час после закрытия свечи
export const CONFIRM_MAX_MS = 3 * 3_600_000;  // позже 3 часов не входим — поздно

export interface BreakoutCandidate {
  symbol: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;         // фиксация половины
  activateAt: number;  // с этой цены включается трейлинг
  trailAbs: number;
  atr: number;
  score: number;
  reasons: { entry: string; stop: string; tp1: string; trail: string };
}

/**
 * Уровни сопровождения по уже открытой позиции — от входа и исходного стопа.
 * ATR отдельно не нужен: стоп равен STOP_ATR×ATR, поэтому шаг трейлинга
 * выражается через тот же риск. Стоп не трогаем — под него посчитан объём.
 */
export function levelsFromStop(direction: Direction, entry: number, initialStop: number): {
  tp1: number; activateAt: number; trailAbs: number;
} | null {
  const risk = Math.abs(entry - initialStop);
  if (!(entry > 0) || !(risk > 0)) return null;
  const isLong = direction === "LONG";
  const at = (r: number) => (isLong ? entry + r * risk : entry - r * risk);
  return {
    tp1: at(TP1_R),
    activateAt: at(TRAIL_ACTIVATE_R),
    trailAbs: (TRAIL_ATR / STOP_ATR) * risk,
  };
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
  const activateAt = at(TRAIL_ACTIVATE_R);
  const trailAbs = TRAIL_ATR * a;

  const range = fmt(extremeClose(h4, i, BREAKOUT_PERIOD, isLong ? "max" : "min"));
  const word = isLong ? "выше" : "ниже";
  const reasons = {
    entry: `закрытие 4h ${fmt(last.close)} пробило ${word} экстремума `
      + `${BREAKOUT_PERIOD} предыдущих закрытий (${range}) в сторону тренда: `
      + `EMA50 ${word} EMA200 на 4h, цена ${word} дневной EMA200 ${fmt(ema200d)}. `
      + `Вход по рынку через час после пробоя — подтверждение, что откат не съел движение`,
    stop: `${STOP_ATR}×ATR(14, 4h) = ${fmt(STOP_ATR * a)} от входа — цена там означает, `
      + `что пробой был ложным`,
    tp1: `${TP1_R}R = ${fmt(tp1)}: фиксируем половину. Если после этого остаток выбьет `
      + `стопом, сделка всё равно закроется в плюс — половина уже взяла ${TP1_R}R`,
    trail: `с ${TRAIL_ACTIVATE_R}R = ${fmt(activateAt)} остаток подхватывает трейлинг `
      + `с шагом ${TRAIL_ATR}×ATR = ${fmt(trailAbs)}. Фиксированной второй цели нет `
      + `намеренно: весь заработок стратегии дают редкие длинные движения, а тейк их срезает`,
  };

  return { symbol, direction, entry, stop, tp1, activateAt, trailAbs, atr: a,
    // сила выноса относительно волатильности: чем дальше цена ушла от EMA50, тем выше приоритет
    score: Math.abs(last.close - ema50) / a,
    reasons };
}
