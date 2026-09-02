// Сканер бота «Пробой наклонки»: вселенная BingX по обороту → наклонки
// на 5m / 15m / 1h → публикация лучшего пробоя.
//
// Особенность против остальных ботов: вход ловится внутри свечи, а не по её
// закрытию (см. strategyTrendline). Поэтому скан не привязан к закрытию свечей
// и на каждом проходе смотрит все три ТФ по каждой монете: один запрос свечей
// на монету и ТФ, последняя свеча в ответе — незакрытая, она и пробойная.

import { lastPrice, symbolsByVolume } from "./bingx";
import { BINGX } from "./market";
import { activeBotSetups, listBotSetups } from "./db";
import { botSetupCaption } from "./botFormat";
import {
  BARS, findTrendlineBreak, MAX_CORR, MAX_HOLD_HOURS, MIN_QUOTE_VOLUME,
  MIN_RR, MIN_TOUCHES, TRENDLINE_TFS,
} from "./strategyTrendline";
import { publishSetup } from "./bot";
import { chunks } from "./botScan";
import type { BotConfig, BotTickReport } from "./bot";
import type { TrendlineCandidate } from "./strategyTrendline";
import type { BotSetup, Candle, TF } from "./types";

export const TRENDLINE_SLUG = "trendline-break";

export const TRENDLINE_DEFAULTS: BotConfig = {
  enabled: false,
  enabledAt: null,
  maxActive: 3,
  // Пробой ловится в моменте, поэтому чем чаще скан, тем ближе вход к границе.
  // Пять минут — компромисс: столько же длится самая короткая свеча бота,
  // а один проход это ~120 запросов к BingX.
  scanMinutes: 5,
  maxHoldHours: MAX_HOLD_HOURS,
};

// Условие пробоя держится всю пробойную свечу и часто ещё несколько следующих,
// поэтому без паузы бот заходил бы в ту же монету на каждом скане. Четыре часа
// перекрывают и 1h-сетапы.
const SYMBOL_COOLDOWN_MS = 4 * 3_600_000;
// Монет с оборотом выше порога на BingX обычно 50–60. Берём верхние по обороту:
// каждая монета — три запроса свечей, и в лимит времени функции надо уложиться.
// 40 монет + BTC — это 123 запроса, по шесть монет за раз это ~10 секунд.
const SCAN_UNIVERSE = 40;
const BATCH = 6;

const CAPTION = {
  head: "📐 ПРОБОЙ НАКЛОНКИ",
  note: "⚠️ Вход в моменте пробоя, поэтому цена в сигнале живёт недолго: "
    + "заходить имеет смысл сразу, а если цена уже вернулась за границу уровня — "
    + "сигнал пропустить. Цель далёкая (от 3R), в плюс закрывается меньшая часть "
    + "сделок — смысл есть только на дистанции.",
  exchange: BINGX,
};

/**
 * Ликвидные монеты BingX, по которым сейчас нет позиции и не действует кулдаун.
 * Оборот и корреляция — правила отбора самого трейдера; корреляция считается
 * уже в стратегии, по свечам того ТФ, на котором ищется сетап.
 */
async function universe(slug: string): Promise<{
  symbols: string[]; livePrices: Map<string, number>;
}> {
  const active = await activeBotSetups(slug);
  const busy = new Set(active.map((s) => s.symbol));
  const cutoff = Date.now() - SYMBOL_COOLDOWN_MS;
  const cooling = new Set((await listBotSetups(slug, 60))
    .filter((s) => new Date(s.createdAt).getTime() >= cutoff)
    .map((s) => s.symbol));

  const top = await symbolsByVolume(MIN_QUOTE_VOLUME);
  const livePrices = new Map(top.map((t) => [t.symbol, t.lastPrice]));
  const symbols = top
    .filter((t) => t.symbol !== "BTCUSDT") // сам с собой скоррелирован на 1.0
    .filter((t) => !busy.has(t.symbol) && !cooling.has(t.symbol))
    .slice(0, SCAN_UNIVERSE)
    .map((t) => t.symbol);
  return { symbols, livePrices };
}

// Свечи одного ТФ: закрытые + текущая незакрытая (она же пробойная).
// BingX отдаёт формирующуюся свечу последней — именно она нужна стратегии.
async function tfCandles(symbol: string, tf: TF): Promise<{
  closed: Candle[]; forming: Candle | null;
}> {
  const raw = await BINGX.fetchKlines(symbol, tf, { limit: BARS + 1 });
  const forming = raw.length && raw[raw.length - 1].closeTime > Date.now()
    ? raw.pop() ?? null
    : null;
  return { closed: raw, forming };
}

export async function scanTrendline(
  slug: string, cfg: BotConfig, report: BotTickReport,
): Promise<void> {
  const active = await activeBotSetups(slug);
  const slots = cfg.maxActive - active.length;
  if (slots <= 0) return;

  // Эталон корреляции — один на все монеты, по одному запросу на ТФ
  const btc = new Map<TF, Candle[]>();
  for (const tf of TRENDLINE_TFS) {
    btc.set(tf, (await tfCandles("BTCUSDT", tf)).closed);
  }

  const { symbols, livePrices } = await universe(slug);
  report.scanned = symbols.length;
  const now = Date.now();

  const candidates: TrendlineCandidate[] = [];
  for (const batch of chunks(symbols, BATCH)) {
    await Promise.all(batch.map(async (sym) => {
      try {
        const live = livePrices.get(sym) ?? await lastPrice(sym);
        for (const tf of TRENDLINE_TFS) {
          const { closed, forming } = await tfCandles(sym, tf);
          if (!forming) continue; // без текущей свечи пробой не поймать
          const c = findTrendlineBreak(
            sym, tf, closed, forming, btc.get(tf) ?? [], live, now,
          );
          if (c) candidates.push(c);
        }
      } catch (e) {
        report.errors.push(`scan ${sym}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }

  // Сначала линии с большим числом касаний, при равных — те, что точнее легли
  // на них. Дальше — как решил перебор внутри стратегии.
  candidates.sort((a, b) => (b.touches - a.touches) || (a.fit - b.fit));

  const taken = new Set<string>();
  let published = 0;
  for (const c of candidates) {
    if (published >= slots) break;
    // Одна монета — один сигнал за скан, даже если пробой виден на двух ТФ
    if (taken.has(c.symbol)) continue;
    const ok = await publishSetup({
      bot: slug, symbol: c.symbol, direction: c.direction,
      entry: c.entry, stop: c.stop, tp1: c.tp, rr1: Math.round(c.rr * 10) / 10,
      // трейлинга у стратегии нет: на цели выходим целиком
      activateAt: 0, trailAbs: 0, tpFull: true,
      feeRate: BINGX.takerFee,
      reasons: c.reasons,
      regime: `наклонка на ${c.tf}: ${c.touches} касания (минимум ${MIN_TOUCHES}) `
        + `за ${c.spanBars} свечей, наторговка ${c.consolBars} свечей у границы, `
        + `объём на пробое ×${c.volMult.toFixed(1)}, корреляция с BTC `
        + `${c.corr.toFixed(2)} (порог ${MAX_CORR}), до основания `
        + `${c.rr.toFixed(1)}R (минимум ${MIN_RR}R)`,
    }, report, (s: BotSetup) => botSetupCaption(s, CAPTION));
    if (ok) {
      taken.add(c.symbol);
      published++;
    }
  }
}
