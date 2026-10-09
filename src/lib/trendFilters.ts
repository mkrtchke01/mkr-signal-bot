// Вход по тренду для «Пробоя наклонки»: чистые функции без сети и базы,
// их гоняют и сканер, и тесты.
//
//  - htfTrend: тренд старшего ТФ — EMA и структура свингов (HH/HL или LH/LL).
//    Пробой берём только в его сторону.
//  - impulseBefore: импульс, после которого нарисовалась наклонка. Наклонка —
//    это откат против импульса, её пробой — продолжение движения.
//  - findTriangle: вторая, сходящаяся граница отката. Наклонка по хаям плюс
//    растущая поддержка по лоям — треугольник, пробой которого и ловим.

import type { Candle, Direction, TF } from "./types";

// Старший ТФ для каждого рабочего: в 4–24 раза крупнее
export const HTF_OF: Partial<Record<TF, TF>> = { "5m": "1h", "15m": "4h", "1h": "1d" };
export const HTF_BARS = 260;      // хватает на EMA200 с прогревом
export const EMA_FAST = 50;
export const EMA_SLOW = 200;
// Молодым монетам на дневках на EMA200 истории не хватает — тогда 20/50
export const EMA_FAST_SHORT = 20;
export const EMA_SLOW_SHORT = 50;
export const EMA_SLOPE_BARS = 5;  // быстрая EMA должна идти в сторону тренда
export const SWING_SIDE = 2;      // свинг-точка на старшем ТФ: 2 свечи по бокам

export interface Pivot { i: number; p: number }

/** Свинг-экстремумы одного типа: хай/лой с `side` свечами по бокам. */
export function pivots(
  c: Candle[], from: number, to: number, high: boolean, side = SWING_SIDE,
): Pivot[] {
  const out: Pivot[] = [];
  for (let i = Math.max(from, side); i <= to - side; i++) {
    let ok = true;
    for (let j = i - side; j <= i + side && ok; j++) {
      if (j === i) continue;
      if (high ? c[j].high >= c[i].high : c[j].low <= c[i].low) ok = false;
    }
    if (ok) out.push({ i, p: high ? c[i].high : c[i].low });
  }
  return out;
}

function emaLast(values: number[], period: number, back = 0): number {
  const end = values.length - back;
  if (end < period) return NaN;
  const k = 2 / (period + 1);
  let v = 0;
  for (let i = 0; i < period; i++) v += values[i];
  v /= period;
  for (let i = period; i < end; i++) v = values[i] * k + v * (1 - k);
  return v;
}

export type Swing = "up" | "down" | "flat";

export interface HtfTrend {
  dir: Direction | null;  // null — тренда нет или EMA и свинги спорят
  emaDir: Direction | null;
  swing: Swing;
  fast: number; slow: number; fastP: number; slowP: number;
}

/**
 * Тренд по закрытым свечам старшего ТФ.
 *  - EMA: быстрая выше медленной, цена выше быстрой, быстрая растёт за
 *    EMA_SLOPE_BARS свечей (для шорта — зеркально).
 *  - Свинги: два последних хая и два последних лоя — выше предыдущих (up)
 *    или ниже (down). Иначе flat.
 * Тренд есть, когда EMA задаёт направление, а свинги ему не противоречат:
 * flat допускаем — на старшем ТФ откат часто ещё не нарисовал новый свинг.
 */
export function htfTrend(c: Candle[]): HtfTrend {
  const closes = c.map((k) => k.close);
  const long = closes.length >= EMA_SLOW + EMA_SLOPE_BARS;
  const fastP = long ? EMA_FAST : EMA_FAST_SHORT;
  const slowP = long ? EMA_SLOW : EMA_SLOW_SHORT;
  const fast = emaLast(closes, fastP);
  const slow = emaLast(closes, slowP);
  const fastPrev = emaLast(closes, fastP, EMA_SLOPE_BARS);
  const price = closes[closes.length - 1];

  let emaDir: Direction | null = null;
  if ([fast, slow, fastPrev, price].every(Number.isFinite)) {
    if (fast > slow && price > fast && fast > fastPrev) emaDir = "LONG";
    else if (fast < slow && price < fast && fast < fastPrev) emaDir = "SHORT";
  }

  const e = c.length - 1;
  const hs = pivots(c, 0, e, true);
  const ls = pivots(c, 0, e, false);
  let swing: Swing = "flat";
  if (hs.length >= 2 && ls.length >= 2) {
    const [h1, h2] = hs.slice(-2);
    const [l1, l2] = ls.slice(-2);
    if (h2.p > h1.p && l2.p > l1.p) swing = "up";
    else if (h2.p < h1.p && l2.p < l1.p) swing = "down";
  }

  const against = (emaDir === "LONG" && swing === "down")
    || (emaDir === "SHORT" && swing === "up");
  return { dir: against ? null : emaDir, emaDir, swing, fast, slow, fastP, slowP };
}

export interface Impulse {
  startIdx: number;  // откуда пошёл импульс
  endIdx: number;    // его вершина (лонг) или дно (шорт)
  start: number;
  end: number;
  size: number;      // длина в цене
  bars: number;
  share: number;     // доля свечей, закрывшихся в сторону импульса
}

/**
 * Импульс, который закончился у основания наклонки. Ищем экстремум
 * в окне `lookback` свечей до основания включительно (для лонга — максимум)
 * и самую дальнюю противоположную точку перед ним — там импульс начался.
 */
export function impulseBefore(
  c: Candle[], baseIdx: number, long: boolean, lookback: number,
): Impulse | null {
  const from = Math.max(0, baseIdx - lookback);
  if (baseIdx - from < 3) return null;
  let endIdx = from;
  for (let x = from; x <= baseIdx; x++) {
    if (long ? c[x].high > c[endIdx].high : c[x].low < c[endIdx].low) endIdx = x;
  }
  let startIdx = from;
  for (let x = from; x <= endIdx; x++) {
    if (long ? c[x].low < c[startIdx].low : c[x].high > c[startIdx].high) startIdx = x;
  }
  const bars = endIdx - startIdx;
  if (bars < 2) return null;
  const end = long ? c[endIdx].high : c[endIdx].low;
  const start = long ? c[startIdx].low : c[startIdx].high;
  let withDir = 0;
  for (let x = startIdx + 1; x <= endIdx; x++) {
    if (long ? c[x].close > c[x].open : c[x].close < c[x].open) withDir++;
  }
  return { startIdx, endIdx, start, end, size: Math.abs(end - start), bars, share: withDir / bars };
}

/** Какую долю импульса съел откат: от вершины импульса до свечи `to`. */
export function retraceOf(c: Candle[], imp: Impulse, to: number, long: boolean): number {
  let deep = imp.end;
  for (let x = imp.endIdx + 1; x <= to; x++) {
    deep = long ? Math.min(deep, c[x].low) : Math.max(deep, c[x].high);
  }
  return imp.size > 0 ? Math.abs(imp.end - deep) / imp.size : Infinity;
}

export interface Triangle {
  touches: number;         // касаний второй границы
  supportAtBreak: number;  // вторая граница на пробойной свече
  apexBars: number;        // сколько свечей от пробоя до вершины
}

export const TRI_MIN_SPAN = 6;  // свечей между крайними касаниями второй границы

/**
 * Вторая граница отката. Для лонга наклонка идёт по хаям вниз, а здесь ищем
 * растущую линию по лоям (для шорта — зеркально): границы сходятся, пробой
 * случается до вершины. Линия держала: ни одного закрытия за ней.
 * @param lineAt наклонка — первая граница
 * @param from основание наклонки, @param e последняя закрытая свеча
 */
export function findTriangle(
  c: Candle[], from: number, e: number, long: boolean,
  lineAt: (x: number) => number, tol: number, pivotSide: number,
): Triangle | null {
  const bi = e + 1;
  const pts = pivots(c, from + 1, e, !long, pivotSide);
  let best: Triangle | null = null;
  for (let a = 0; a < pts.length - 1; a++) {
    for (let b = a + 1; b < pts.length; b++) {
      const span = pts[b].i - pts[a].i;
      if (span < TRI_MIN_SPAN) continue;
      const slope = (pts[b].p - pts[a].p) / span;
      if (long ? slope <= 0 : slope >= 0) continue; // поддержка растёт / сопротивление падает
      const supAt = (x: number) => pts[a].p + slope * (x - pts[a].i);
      const width = (x: number) => (long ? lineAt(x) - supAt(x) : supAt(x) - lineAt(x));
      if (!(width(bi) > 0) || !(width(pts[a].i) > width(bi))) continue;
      // Где границы сойдутся: ширина убывает линейно
      const shrink = (width(pts[a].i) - width(bi)) / (bi - pts[a].i);
      const apexBars = width(bi) / shrink;
      let held = true;
      for (let x = pts[a].i; x <= e && held; x++) {
        if (long ? c[x].close < supAt(x) - tol : c[x].close > supAt(x) + tol) held = false;
      }
      if (!held) continue;
      const touches = pts.filter((q) => q.i >= pts[a].i && Math.abs(q.p - supAt(q.i)) <= tol).length;
      if (touches < 2) continue;
      if (!best || touches > best.touches) {
        best = { touches, supportAtBreak: supAt(bi), apexBars };
      }
    }
  }
  return best;
}

/**
 * Цель по проекции импульса (measured move): длина импульса, отложенная
 * от границы на пробое. Не ближе основания наклонки и не дальше `maxReward`
 * от входа — иначе сделка упрётся в лимит удержания.
 */
export function measuredTarget(
  long: boolean, entry: number, line: number, base: number,
  impulseSize: number, maxReward: number,
): number {
  const sign = long ? 1 : -1;
  const mm = line + sign * impulseSize;
  const far = long ? Math.max(base, mm) : Math.min(base, mm);
  const cap = entry + sign * maxReward;
  // Если за потолком уже само основание, сетап отсеивает вызывающий
  return long ? Math.min(far, cap) : Math.max(far, cap);
}
