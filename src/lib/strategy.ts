// Стратегия «Трейдер-бот»: лонги/шорты от кластера уровней, вход по рынку.
//
// Методология:
//  1. Режим рынка по BTC (дневные EMA20/50 + 4h-структура) — торгуем только по нему.
//  2. Монета должна быть в тренде режима (цена относительно дневной EMA20,
//     EMA20>EMA50 на 4h, растущие/падающие свинги).
//  3. Сигнал публикуется только когда цена УЖЕ откатилась к кластеру поддержки
//     (4h EMA50 + свинг-лой + дневная EMA20) — вход по рынку по текущей цене,
//     а не лимиткой заранее. Кластер = минимум два уровня рядом.
//  4. Стоп — за кластером и последним свингом (буфер в долях ATR):
//     цена там = структура сломана, идея неправа.
//  5. Тейки только на реальных уровнях (свинг-хаи, дневная EMA50, хай диапазона),
//     а не «просто N×R». Сетап отбрасывается, если RR к TP2 ниже минимума.

import { ema } from "./indicators";
import type { Candle, Direction } from "./types";

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

export interface SetupReasons {
  entry: string;
  stop: string;
  tp1: string;
  tp2: string;
}

export interface SetupCandidate {
  symbol: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  rr1: number;
  rr2: number;
  score: number;
  reasons: SetupReasons;
}

// Минимальные требования к сетапу
const MIN_RR1 = 1.2;
const MIN_RR2 = 2.2;
const TOUCH_ATR = 0.5;        // цена не дальше 0.5 ATR от кластера — «уже у уровня»
const CLUSTER_ATR = 1.2;      // уровни в пределах 1.2 ATR считаем одним кластером
const STOP_BUFFER_ATR = 0.6;  // буфер стопа за структурой

export function lastEma(closes: number[], period: number): number {
  const series = ema(closes, period);
  return series.length ? series[series.length - 1] : NaN;
}

export function atr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    sum += Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return sum / period;
}

export interface SwingPoints { highs: number[]; lows: number[] }

// Свинг = экстремум среди lb свечей слева и справа. Возвращаем в хронологическом порядке.
export function findSwings(candles: Candle[], lb = 3): SwingPoints {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = lb; i < candles.length - lb; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = i - lb; k <= i + lb; k++) {
      if (candles[k].high > candles[i].high) isHigh = false;
      if (candles[k].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  return { highs, lows };
}

// Режим рынка по BTC: торгуем только в сторону краткосрочного тренда.
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

// Зеркалим свечи по цене — позволяет искать SHORT той же логикой, что и LONG.
function mirrorCandle(c: Candle): Candle {
  return { ...c, open: -c.open, high: -c.low, low: -c.high, close: -c.close };
}

interface RawSetup {
  entry: number; stop: number; tp1: number; tp2: number;
  rr1: number; rr2: number; score: number;
  cluster: number[]; swingRef: number; hi30: number;
  tp1Src: string; tp2Src: string;
}

// Логика LONG (для SHORT вызывается на зеркальных свечах).
// livePrice — актуальная цена тикера: вход по рынку, поэтому нельзя опираться
// на close последней закрытой 4h-свечи (ей может быть несколько часов).
function findLongRaw(d1: Candle[], h4: Candle[], livePrice: number): RawSetup | null {
  if (d1.length < 60 || h4.length < 80) return null;
  const closes1d = d1.map((c) => c.close);
  const closes4h = h4.map((c) => c.close);
  const price = livePrice;
  const ema20d = lastEma(closes1d, 20);
  const ema50d = lastEma(closes1d, 50);
  const ema20h4 = lastEma(closes4h, 20);
  const ema50h4 = lastEma(closes4h, 50);
  const a = atr(h4);
  if ([ema20d, ema50d, ema20h4, ema50h4, a].some(Number.isNaN)) return null;

  // Тренд монеты совпадает с режимом
  if (!(price > ema20d && ema20h4 > ema50h4)) return null;

  const { highs, lows } = findSwings(h4);
  if (lows.length < 2 || highs.length < 2) return null;
  // Восходящая структура: последний свинг-лой выше предыдущего
  const lastLow = lows[lows.length - 1];
  if (!(lastLow > lows[lows.length - 2])) return null;

  // Кластер поддержки: верхний уровень возле цены и всё в пределах CLUSTER_ATR под ним
  const supports = [ema50h4, lastLow, ema20d].filter((s) => s < price + TOUCH_ATR * a);
  if (!supports.length) return null;
  const clusterTop = Math.max(...supports);
  const cluster = supports.filter((s) => clusterTop - s <= CLUSTER_ATR * a);
  if (cluster.length < 2) return null;

  // Цена УЖЕ у кластера: не дальше TOUCH_ATR над его верхом и не под его дном —
  // иначе либо вход вдогонку, либо структура уже сломана
  if (price - clusterTop > TOUCH_ATR * a) return null;
  if (price < Math.min(...cluster, lastLow)) return null;

  // Вход по рынку по текущей цене
  const entry = price;
  const stop = Math.min(...cluster, lastLow) - STOP_BUFFER_ATR * a;
  const risk = entry - stop;
  if (risk <= 0) return null;

  // Сопротивления: свинг-хаи 4h, дневная EMA50, 30-дневный хай
  const hi30 = Math.max(...d1.slice(-30).map((c) => c.high));
  const resist: { level: number; src: string }[] = highs
    .filter((h) => h > entry)
    .map((h) => ({ level: h, src: "свинг-хай 4h" }));
  if (ema50d > entry) resist.push({ level: ema50d, src: "дневная EMA50" });
  if (hi30 > entry) resist.push({ level: hi30, src: "30-дневный хай" });
  resist.sort((x, y) => x.level - y.level);

  const t1 = resist.find((r) => (r.level - entry) / risk >= MIN_RR1);
  if (!t1) return null;
  const t2 = resist.find((r) => r.level > t1.level * 1.004 && (r.level - entry) / risk >= MIN_RR2);
  if (!t2) return null;

  const rr1 = (t1.level - entry) / risk;
  const rr2 = (t2.level - entry) / risk;
  // Скоринг: качество RR + сила тренда монеты
  const score = rr2 + (ema20h4 / ema50h4 - 1) * 50 + (price / ema20d - 1) * 10;

  return {
    entry, stop, tp1: t1.level, tp2: t2.level, rr1, rr2, score,
    cluster, swingRef: lastLow, hi30, tp1Src: t1.src, tp2Src: t2.src,
  };
}

function fmt(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return p.toPrecision(4);
}

export function findSetup(
  symbol: string, d1: Candle[], h4: Candle[], bias: RegimeBias, livePrice: number,
): SetupCandidate | null {
  if (bias === "NEUTRAL" || !Number.isFinite(livePrice) || livePrice <= 0) return null;
  const direction: Direction = bias;
  const raw = direction === "LONG"
    ? findLongRaw(d1, h4, livePrice)
    : findLongRaw(d1.map(mirrorCandle), h4.map(mirrorCandle), -livePrice);
  if (!raw) return null;

  // Для SHORT возвращаем цены из зеркала обратно
  const un = (v: number) => (direction === "LONG" ? v : -v);
  const entry = un(raw.entry);
  const stop = un(raw.stop);
  const tp1 = un(raw.tp1);
  const tp2 = un(raw.tp2);
  const cluster = raw.cluster.map(un);
  const swingRef = un(raw.swingRef);
  const hi30 = un(raw.hi30);

  const long = direction === "LONG";
  const clusterWord = long ? "кластеру поддержки" : "кластеру сопротивления";
  const swingWord = long ? "свинг-лоем" : "свинг-хаем";
  const tpSrc = (src: string) => (long ? src : src
    .replace("свинг-хай", "свинг-лой")
    .replace("30-дневный хай", "30-дневный лой"));

  const reasons: SetupReasons = {
    entry: `цена уже откатилась к ${clusterWord}: ${cluster.map(fmt).join(" + ")} `
      + `(4h EMA50 / ${long ? "свинг-лой" : "свинг-хай"} 4h / дневная EMA20 — минимум два уровня рядом), `
      + `вход по рынку по текущей цене`,
    stop: `за ${swingWord} ${fmt(swingRef)} и кластером с буфером 0.6×ATR — `
      + `цена там означает слом структуры, идея неправа`,
    tp1: `${tpSrc(raw.tp1Src)} ${fmt(tp1)} — первое реальное сопротивление, `
      + `фиксация 50% и стоп в безубыток`,
    tp2: `${tpSrc(raw.tp2Src)} ${fmt(tp2)} (30-дн. экстремум: ${fmt(hi30)})`,
  };

  return {
    symbol, direction, entry, stop, tp1, tp2,
    rr1: Math.round(raw.rr1 * 100) / 100,
    rr2: Math.round(raw.rr2 * 100) / 100,
    score: raw.score, reasons,
  };
}
