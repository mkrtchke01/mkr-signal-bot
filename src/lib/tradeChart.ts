// Данные для графика одной сделки: свечи вокруг неё, уровни и восстановленный
// путь (вход, TP1, включение трейлинга, лесенка стопа, выход).
//
// Таймфрейм подбирается под длительность сделки: внутридневную рисуем минутками,
// многодневную — часами. Ориентир — около 240 свечей в окне: меньше — картинка
// пустая, больше — свечи сливаются в кашу и ответ распухает.

import { botRuntime } from "./botRegistry";
import { fetchPoolCandles, GT_TFS } from "./geckoterminal";
import { BYBIT } from "./market";
import { entryMs, exitMs, replayTrade } from "./replay";
import { TF_MS } from "./types";
import type { Extreme, StopStep, TradeEvent } from "./replay";
import type { BotSetup, Candle, TF } from "./types";

// Сколько свечей стараемся уместить в стартовое окно. Планка высокая нарочно:
// лесенка шагов теперь короткая (её переключает человек), и лучше отдать
// сделку мелкими свечами — крупные всегда в одно нажатие.
const TARGET_BARS = 400;

// Шаги, между которыми можно переключаться на графике. У биржевых ботов берём
// привычную лесенку (весь список TIMEFRAMES в переключателе не нужен), у
// мемкоинов — то, что вообще отдаёт GeckoTerminal.
const CHART_TFS: TF[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

// Свеча для отрисовки: короткие имена — окно на 240 баров уходит по сети
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

// Уровни фьючерсного сетапа. Начальный стоп и подтянутый показываем порознь:
// в базе stop_price уже перетёрт трейлингом, а рисовать надо оба.
function futuresLevels(s: BotSetup): ChartLevel[] {
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

// У мемкоин-бота те же колонки значат другое: цель ×2, инвалидация вместо
// стопа, отметка +50% и цена включения выхода по откату.
function dexLevels(s: BotSetup): ChartLevel[] {
  const out: ChartLevel[] = [
    { price: s.entryPrice, label: "покупка", tone: "entry" },
    { price: s.stopPrice, label: "идея не сыграла", tone: "stop" },
    { price: s.entryPrice * 1.5, label: "+50%", tone: "trail" },
    { price: s.tp1, label: "ориентир +100%", tone: "tp" },
  ];
  if (s.activateAt > 0) {
    out.push({ price: s.activateAt, label: "выход по откату включён", tone: "trail" });
  }
  return out;
}

// Где торгует бот: мемкоины — на DEX через GeckoTerminal, остальные — на бирже
export function tradeExchange(s: BotSetup): string {
  if (s.chain && s.poolAddress) return "GeckoTerminal";
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
  const list = s.chain && s.poolAddress
    ? await fetchPoolCandles(s.chain, s.poolAddress, tf, bars, end)
    : await (botRuntime(s.bot)?.market ?? BYBIT).fetchKlines(s.symbol, tf, {
      startTime: start, endTime: end, limit: bars,
    });
  // Страховка: биржа могла отдать больше, чем просили
  return list.filter((c) => c.closeTime >= start && c.openTime <= end);
}

export async function buildTradeChart(s: BotSetup): Promise<TradeChart> {
  const dex = Boolean(s.chain && s.poolAddress);
  const from = entryMs(s);
  const to = exitMs(s);
  // Совсем короткую сделку растягиваем до получаса, иначе на графике
  // остаётся пара свечей и по нему ничего не прочитать.
  const span = Math.max(to - from, 30 * 60_000);
  const tfs = dex ? GT_TFS : CHART_TFS;
  const tf = pickTf(span * 1.4, tfs);
  // Поля по краям: видно, откуда цена пришла к входу и куда ушла после выхода
  const pad = Math.round(Math.max(span * 0.18, TF_MS[tf] * 8));
  const start = from - pad;
  const end = Math.min(to + pad, Date.now());

  const candles = await fetchTradeCandles(s, tf, start, end);
  const replay = replayTrade(s, candles);
  return {
    tf,
    tfs,
    exchange: tradeExchange(s),
    candles: candles.map((c) => ({ t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close })),
    levels: dex ? dexLevels(s) : futuresLevels(s),
    events: replay.events,
    stops: replay.stops,
    best: replay.best,
    worst: replay.worst,
    entryMs: from,
    exitMs: s.closedAt ? new Date(s.closedAt).getTime() : null,
  };
}
