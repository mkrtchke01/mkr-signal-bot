// Данные для графика одной сделки: свечи вокруг неё, уровни и восстановленный
// путь (вход, TP1, включение трейлинга, лесенка стопа, выход).
//
// Таймфрейм подбирается под длительность сделки: внутридневную рисуем минутками,
// многодневную — часами. Дальше шаг переключает человек кнопками над графиком.

import { botRuntime } from "./botRegistry";
import { BYBIT } from "./market";
import { entryMs, exitMs, replayTrade } from "./replay";
import { TF_MS } from "./types";
import type { Extreme, StopStep, TradeEvent } from "./replay";
import type { BotSetup, Candle, TF } from "./types";

// Сколько свечей стараемся уместить в стартовое окно. Планка высокая нарочно:
// лесенка шагов теперь короткая (её переключает человек), и лучше отдать
// сделку мелкими свечами — крупные всегда в одно нажатие.
const TARGET_BARS = 400;

// Шаги, между которыми можно переключаться на графике: привычная лесенка,
// весь список TIMEFRAMES в переключателе не нужен.
const CHART_TFS: TF[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

// Свеча для отрисовки: короткие имена — окно в сотни баров уходит по сети
export interface ChartCandle {
  t: number; o: number; h: number; l: number; c: number;
}

export type LevelTone = "entry" | "stop" | "tp" | "trail";

export interface ChartLevel {
  price: number;
  label: string;
  tone: LevelTone;
}

export interface TradeChart {
  tf: TF;
  tfs: TF[];      // на какие шаги можно переключиться
  exchange: string;
  candles: ChartCandle[];
  levels: ChartLevel[];
  events: TradeEvent[];
  stops: StopStep[];
  best: Extreme | null;
  worst: Extreme | null;
  entryMs: number;
  exitMs: number | null;
}

function pickTf(spanMs: number, allowed: readonly TF[]): TF {
  for (const tf of allowed) {
    if (spanMs / TF_MS[tf] <= TARGET_BARS) return tf;
  }
  return allowed[allowed.length - 1];
}

// Уровни сетапа. Начальный стоп и подтянутый показываем порознь: в базе
// stop_price уже перетёрт трейлингом, а рисовать надо оба.
function setupLevels(s: BotSetup): ChartLevel[] {
  const out: ChartLevel[] = [
    { price: s.entryPrice, label: "вход", tone: "entry" },
    { price: s.initialStop, label: "стоп", tone: "stop" },
    { price: s.tp1, label: s.tpFull ? "тейк" : `TP1 · ${s.rr1}R`, tone: "tp" },
  ];
  if (!s.tpFull && s.trailAbs > 0 && s.activateAt > 0 && s.activateAt !== s.tp1) {
    out.push({ price: s.activateAt, label: "старт трейлинга", tone: "trail" });
  }
  return out;
}

// Биржа, на которой торгует бот сделки
export function tradeExchange(s: BotSetup): string {
  return (botRuntime(s.bot)?.market ?? BYBIT).name;
}

/**
 * Свечи символа сделки за произвольное окно. Отдельная функция, потому что
 * график можно листать: клиент догружает соседние куски тем же таймфреймом.
 * Границы обязательно целые — дробные миллисекунды биржа молча игнорирует
 * и вместо окна отдаёт свежий кусок истории на весь лимит.
 */
export async function fetchTradeCandles(
  s: BotSetup, tf: TF, from: number, to: number,
): Promise<Candle[]> {
  const start = Math.floor(from);
  const end = Math.ceil(to);
  const bars = Math.min(Math.ceil((end - start) / TF_MS[tf]) + 2, 1000);
  const list = await (botRuntime(s.bot)?.market ?? BYBIT).fetchKlines(s.symbol, tf, {
    startTime: start, endTime: end, limit: bars,
  });
  // Страховка: биржа могла отдать больше, чем просили
  return list.filter((c) => c.closeTime >= start && c.openTime <= end);
}

export async function buildTradeChart(s: BotSetup): Promise<TradeChart> {
  const from = entryMs(s);
  const to = exitMs(s);
  // Совсем короткую сделку растягиваем до получаса, иначе на графике
  // остаётся пара свечей и по нему ничего не прочитать.
  const span = Math.max(to - from, 30 * 60_000);
  const tf = pickTf(span * 1.4, CHART_TFS);
  // Поля по краям: видно, откуда цена пришла к входу и куда ушла после выхода
  const pad = Math.round(Math.max(span * 0.18, TF_MS[tf] * 8));
  const start = from - pad;
  const end = Math.min(to + pad, Date.now());

  const candles = await fetchTradeCandles(s, tf, start, end);
  const replay = replayTrade(s, candles);
  return {
    tf,
    tfs: CHART_TFS,
    exchange: tradeExchange(s),
    candles: candles.map((c) => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close })),
    levels: setupLevels(s),
    events: replay.events,
    stops: replay.stops,
    best: replay.best,
    worst: replay.worst,
    entryMs: from,
    exitMs: s.closedAt ? new Date(s.closedAt).getTime() : null,
  };
}
