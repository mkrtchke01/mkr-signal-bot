// Общие детали сканирования рынка для кастомных ботов:
// какие монеты берём и как грузим закрытые свечи.

import { fetchKlines, topSymbols } from "./binance";
import { activeBotSetups, listBotSetups } from "./db";
import type { Candle, TF } from "./types";

export const MIN_QUOTE_VOLUME = 30_000_000; // фильтр ликвидности, USDT за 24ч
export const EXCLUDED = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "BUSDUSDT", "EURUSDT", "DAIUSDT",
]);

// Только закрытые свечи: последняя может ещё формироваться
export async function closedKlines(
  symbol: string, tf: TF, limit: number,
): Promise<Candle[]> {
  const raw = await fetchKlines(symbol, tf, { limit: Math.min(limit + 1, 1000) });
  if (raw.length && raw[raw.length - 1].closeTime > Date.now()) raw.pop();
  return raw;
}

export function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Ликвидные монеты, по которым сейчас нет позиции и не действует кулдаун.
// Кулдаун нужен, чтобы бот не перезаходил в ту же монету сразу после стопа.
export async function pickUniverse(
  slug: string, cooldownMs: number, take: number,
): Promise<{ symbols: string[]; livePrices: Map<string, number> }> {
  const active = await activeBotSetups(slug);
  const busy = new Set(active.map((s) => s.symbol));
  const cutoff = Date.now() - cooldownMs;
  const cooling = new Set((await listBotSetups(slug, 60))
    .filter((s) => new Date(s.createdAt).getTime() >= cutoff)
    .map((s) => s.symbol));

  const top = await topSymbols(60);
  const livePrices = new Map(top.map((t) => [t.symbol, t.lastPrice]));
  const symbols = top
    .filter((t) => t.quoteVolume >= MIN_QUOTE_VOLUME && !EXCLUDED.has(t.symbol))
    .filter((t) => !busy.has(t.symbol) && !cooling.has(t.symbol))
    .slice(0, take)
    .map((t) => t.symbol);
  return { symbols, livePrices };
}
