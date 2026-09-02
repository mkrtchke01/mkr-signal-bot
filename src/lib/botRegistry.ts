// Связка «slug бота → его сканер, биржа и настройки по умолчанию».
// Серверный модуль: тянет за собой доступ к бирже и БД.

import { runBotTick } from "./bot";
import type { BotConfig, BotScanner, BotTickReport } from "./bot";
import { BREAKOUT_DEFAULTS, BREAKOUT_SLUG, scanBreakout } from "./botBreakout";
import { BTC_INTRADAY_DEFAULTS, BTC_INTRADAY_SLUG, scanBtcIntraday } from "./botBtcIntraday";
import { RELSTRENGTH_DEFAULTS, RELSTRENGTH_SLUG, scanRelStrength } from "./botRelStrength";
import { TRENDLINE_DEFAULTS, TRENDLINE_SLUG, scanTrendline } from "./botTrendline";
import { BINGX, BYBIT } from "./market";
import type { MarketData } from "./market";

export interface BotRuntime {
  slug: string;
  defaults: BotConfig;
  scan: BotScanner;
  market: MarketData; // где бот торгует: свечи сопровождения и комиссии оттуда
}

export const BOT_RUNTIMES: BotRuntime[] = [
  { slug: BREAKOUT_SLUG, defaults: BREAKOUT_DEFAULTS, scan: scanBreakout, market: BYBIT },
  {
    slug: RELSTRENGTH_SLUG, defaults: RELSTRENGTH_DEFAULTS,
    scan: scanRelStrength, market: BYBIT,
  },
  {
    slug: BTC_INTRADAY_SLUG, defaults: BTC_INTRADAY_DEFAULTS,
    scan: scanBtcIntraday, market: BYBIT,
  },
  {
    slug: TRENDLINE_SLUG, defaults: TRENDLINE_DEFAULTS,
    scan: scanTrendline, market: BINGX,
  },
];

export function botRuntime(slug: string): BotRuntime | null {
  return BOT_RUNTIMES.find((b) => b.slug === slug) ?? null;
}

export async function tickBot(
  slug: string, opts: { forceScan?: boolean } = {},
): Promise<BotTickReport> {
  const rt = botRuntime(slug);
  if (!rt) throw new Error(`Неизвестный бот: ${slug}`);
  return runBotTick(rt.slug, rt.defaults, rt.scan, rt.market, opts);
}

// Тик всех ботов: падение одного не должно останавливать остальных
export async function tickAllBots(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const rt of BOT_RUNTIMES) {
    try {
      out[rt.slug] = await tickBot(rt.slug);
    } catch (e) {
      out[rt.slug] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}
