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
import { TF_MS, TIMEFRAMES } from "./types";
import type { Extreme, StopStep, TradeEvent } from "./replay";
import type { BotSetup, TF } from "./types";

const TARGET_BARS = 240;

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

export async function buildTradeChart(s: BotSetup): Promise<TradeChart> {
  const dex = Boolean(s.chain && s.poolAddress);
  const from = entryMs(s);
  const to = exitMs(s);
  // Совсем короткую сделку растягиваем до получаса, иначе на графике
  // остаётся пара свечей и по нему ничего не прочитать.
  const span = Math.max(to - from, 30 * 60_000);
  const tf = pickTf(span * 1.4, dex ? GT_TFS : TIMEFRAMES);
  // Поля по краям: видно, откуда цена пришла к входу и куда ушла после выхода.
  // Границы обязательно целые: дробные миллисекунды биржа молча игнорирует
  // и вместо окна отдаёт свежий кусок истории на весь лимит.
  const pad = Math.round(Math.max(span * 0.18, TF_MS[tf] * 8));
  const start = Math.floor(from - pad);
  const end = Math.min(Math.ceil(to + pad), Date.now());
  const bars = Math.ceil((end - start) / TF_MS[tf]) + 2;

  let candles;
  let exchange: string;
  if (dex) {
    exchange = "GeckoTerminal";
    candles = await fetchPoolCandles(s.chain!, s.poolAddress!, tf, bars, end);
  } else {
    const market = botRuntime(s.bot)?.market ?? BYBIT;
    exchange = market.name;
    candles = await market.fetchKlines(s.symbol, tf, {
      startTime: start, endTime: end, limit: Math.min(bars, 1000),
    });
  }
  // Страховка от той же беды: биржа могла отдать больше, чем просили
  candles = candles.filter((c) => c.closeTime >= start && c.openTime <= end);

  const replay = replayTrade(s, candles);
  return {
    tf,
    exchange,
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
