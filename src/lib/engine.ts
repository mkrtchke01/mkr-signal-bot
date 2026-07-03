import { ema, macdHistogram, rsi } from "./indicators";
import type { Candle, Direction, ExitRule, Rule, TF, TraderConfig } from "./types";
import { TF_MS } from "./types";

// Сколько свечей истории нужно правилу для прогрева индикатора
export function warmupCandles(rule: Rule): number {
  switch (rule.type) {
    case "rsi": return rule.period * 4 + 10;
    case "macd": return 26 + 9 + rule.candles + 30;
    // EMA сидируется SMA(period), быстро сходится — большой прогрев не нужен
    case "ema": return rule.period + 30;
  }
}

export function exitWarmup(exit: ExitRule): number {
  return exit.type === "rsi" ? exit.period * 4 + 10 : 0;
}

// Все ТФ, которые нужны трейдеру (правила + RSI-выходы)
export function requiredTfs(c: TraderConfig): TF[] {
  const set = new Set<TF>();
  for (const r of c.rules) set.add(r.tf);
  if (c.stopLoss.type === "rsi") set.add(c.stopLoss.tf);
  if (c.takeProfit.type === "rsi") set.add(c.takeProfit.tf);
  if (!set.size) set.add(c.timeframe);
  return [...set];
}

export function smallestTf(c: TraderConfig): TF {
  const tfs = requiredTfs(c);
  tfs.push(c.timeframe);
  return tfs.reduce((a, b) => (TF_MS[a] <= TF_MS[b] ? a : b));
}

// Кэш индикаторных серий: считаем один раз на массив свечей (важно для
// бэктеста, где одно и то же правило проверяется на каждой свече).
const seriesCache = new WeakMap<Candle[], Map<string, number[]>>();

function cachedSeries(candles: Candle[], key: string, compute: (closes: number[]) => number[]): number[] {
  let perArray = seriesCache.get(candles);
  if (!perArray) {
    perArray = new Map();
    seriesCache.set(candles, perArray);
  }
  let series = perArray.get(key);
  if (!series) {
    series = compute(candles.map((c) => c.close));
    perArray.set(key, series);
  }
  return series;
}

export function rsiSeries(candles: Candle[], period: number): number[] {
  return cachedSeries(candles, `rsi:${period}`, (closes) => rsi(closes, period));
}

// Проверка одного правила на закрытой свече с индексом i
export function ruleTriggeredAt(
  rule: Rule, direction: Direction, candles: Candle[], i: number,
): boolean {
  if (i < 1 || i >= candles.length) return false;
  switch (rule.type) {
    case "rsi": {
      const v = rsiSeries(candles, rule.period)[i];
      if (Number.isNaN(v)) return false;
      return rule.op === "lte" ? v <= rule.value : v >= rule.value;
    }
    case "macd": {
      // Разворот гистограммы MACD: для LONG — N подряд растущих баров ниже нуля
      // («красные бары уменьшаются»), для SHORT — N подряд падающих выше нуля.
      const h = cachedSeries(candles, "macd", (closes) => macdHistogram(closes));
      const n = rule.candles;
      if (i - n < 0) return false;
      for (let k = 0; k <= n; k++) {
        if (Number.isNaN(h[i - k])) return false;
      }
      for (let k = 0; k < n; k++) {
        const cur = h[i - k];
        const prev = h[i - k - 1];
        if (direction === "LONG") {
          if (!(cur > prev) || cur >= 0) return false;
        } else {
          if (!(cur < prev) || cur <= 0) return false;
        }
      }
      return true;
    }
    case "ema": {
      const e = cachedSeries(candles, `ema:${rule.period}`, (closes) => ema(closes, rule.period));
      if (Number.isNaN(e[i]) || Number.isNaN(e[i - 1])) return false;
      const price = candles[i].close;
      const prevPrice = candles[i - 1].close;
      switch (rule.condition) {
        case "price_above": return price > e[i];
        case "price_below": return price < e[i];
        case "cross_up": return prevPrice <= e[i - 1] && price > e[i];
        case "cross_down": return prevPrice >= e[i - 1] && price < e[i];
      }
    }
  }
}

// Проверка всех правил на последних закрытых свечах (live).
// candlesByTf должен содержать только ЗАКРЫТЫЕ свечи.
export function allRulesTriggered(
  c: TraderConfig, candlesByTf: Map<TF, Candle[]>,
): boolean {
  if (!c.rules.length) return false;
  for (const rule of c.rules) {
    const candles = candlesByTf.get(rule.tf);
    if (!candles || candles.length < warmupCandles(rule)) return false;
    if (!ruleTriggeredAt(rule, c.direction, candles, candles.length - 1)) return false;
  }
  return true;
}

// Ценовые уровни для процентных SL/TP (для RSI-выходов уровня нет)
export function calcTargets(
  direction: Direction, entry: number, stopLoss: ExitRule, takeProfit: ExitRule,
): { stopPrice: number | null; takePrice: number | null } {
  const sign = direction === "LONG" ? 1 : -1;
  return {
    stopPrice: stopLoss.type === "percent"
      ? entry * (1 - sign * stopLoss.value / 100) : null,
    takePrice: takeProfit.type === "percent"
      ? entry * (1 + sign * takeProfit.value / 100) : null,
  };
}

export function profitPct(
  direction: Direction, entry: number, exit: number, leverage: number,
): number {
  const move = direction === "LONG" ? exit / entry - 1 : 1 - exit / entry;
  return Math.round(move * 100 * leverage * 100) / 100;
}

// Проверка процентных уровней по экстремумам свечи.
// Если в одной свече задеты и стоп и тейк — консервативно считаем стоп.
export function checkPriceExit(
  direction: Direction, candle: Candle,
  stopPrice: number | null, takePrice: number | null,
): { status: "TP" | "SL"; price: number } | null {
  const hitStop = stopPrice !== null &&
    (direction === "LONG" ? candle.low <= stopPrice : candle.high >= stopPrice);
  const hitTake = takePrice !== null &&
    (direction === "LONG" ? candle.high >= takePrice : candle.low <= takePrice);
  if (hitStop) return { status: "SL", price: stopPrice! };
  if (hitTake) return { status: "TP", price: takePrice! };
  return null;
}

// RSI-выход: для LONG тейк срабатывает при RSI >= value (перекупленность),
// стоп — при RSI <= value. Для SHORT зеркально.
// i — индекс свечи, на закрытии которой проверяем (по умолчанию последняя).
export function rsiExitTriggered(
  exit: ExitRule & { type: "rsi" }, kind: "tp" | "sl",
  direction: Direction, candles: Candle[], i = candles.length - 1,
): boolean {
  if (i < exit.period + 1 || i >= candles.length) return false;
  const v = rsiSeries(candles, exit.period)[i];
  if (Number.isNaN(v)) return false;
  const up = (kind === "tp") === (direction === "LONG");
  return up ? v >= exit.value : v <= exit.value;
}
