import type { Candle, TF } from "./types";
import { TF_MS } from "./types";

// Основной источник — фьючерсы Binance (fapi), фолбэк — публичное
// спот-зеркало data-api.binance.vision (не требует ключей, меньше гео-блоков).
const FAPI = "https://fapi.binance.com";
const SPOT = "https://data-api.binance.vision";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return res.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseKlines(raw: any[]): Candle[] {
  return raw.map((k) => ({
    openTime: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
    closeTime: Number(k[6]),
  }));
}

export async function fetchKlines(
  symbol: string, tf: TF,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<Candle[]> {
  const q = new URLSearchParams({ symbol: symbol.toUpperCase(), interval: tf });
  q.set("limit", String(Math.min(opts.limit ?? 500, 1000)));
  if (opts.startTime) q.set("startTime", String(opts.startTime));
  if (opts.endTime) q.set("endTime", String(opts.endTime));
  try {
    return parseKlines(await getJson(`${FAPI}/fapi/v1/klines?${q}`));
  } catch {
    return parseKlines(await getJson(`${SPOT}/api/v3/klines?${q}`));
  }
}

// Загрузка длинного диапазона порциями по 1000 свечей
export async function fetchKlinesRange(
  symbol: string, tf: TF, startTime: number, endTime = Date.now(),
): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = startTime;
  const step = TF_MS[tf];
  for (let guard = 0; guard < 60 && cursor < endTime; guard++) {
    const batch = await fetchKlines(symbol, tf, {
      startTime: cursor, endTime, limit: 1000,
    });
    if (!batch.length) break;
    out.push(...batch);
    const last = batch[batch.length - 1].openTime;
    cursor = last + step;
    if (batch.length < 1000) break;
  }
  return out;
}

export async function lastPrice(symbol: string): Promise<number> {
  const s = symbol.toUpperCase();
  try {
    const j = await getJson(`${FAPI}/fapi/v1/ticker/price?symbol=${s}`);
    return Number(j.price);
  } catch {
    const j = await getJson(`${SPOT}/api/v3/ticker/price?symbol=${s}`);
    return Number(j.price);
  }
}

export interface SymbolVolume { symbol: string; quoteVolume: number; lastPrice: number }

// Топ-N USDT-пар по объёму за 24ч
export async function topSymbols(n = 20): Promise<SymbolVolume[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let raw: any[];
  try {
    raw = await getJson(`${FAPI}/fapi/v1/ticker/24hr`);
  } catch {
    raw = await getJson(`${SPOT}/api/v3/ticker/24hr`);
  }
  return raw
    .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT"))
    .map((t) => ({
      symbol: t.symbol as string,
      quoteVolume: Number(t.quoteVolume),
      lastPrice: Number(t.lastPrice),
    }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, n);
}

export async function symbolExists(symbol: string): Promise<boolean> {
  try {
    await lastPrice(symbol);
    return true;
  } catch {
    return false;
  }
}
