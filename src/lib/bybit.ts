import type { Candle, TF } from "./types";
import { TF_MS } from "./types";

// Котировки берём с той же биржи, где исполняются сделки: цена в сигнале и цена
// в терминале — одна и та же, без расхождений базиса и фандинга.
// Основной хост api.bybit.com, фолбэк — зеркало api.bytick.com (тот же API).
const HOSTS = ["https://api.bybit.com", "https://api.bytick.com"];

// Бессрочные USDT-контракты
const CATEGORY = "linear";

// Bybit задаёт интервал числом минут, дневки/недели/месяцы — буквой
const INTERVAL: Record<TF, string> = {
  "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720", "1d": "D",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getResult(path: string): Promise<any> {
  let lastErr: unknown = null;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${path}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const j = await res.json();
      // Ошибки уровня API приходят с HTTP 200 и ненулевым retCode
      if (j.retCode !== 0) throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
      return j.result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${lastErr instanceof Error ? lastErr.message : String(lastErr)}: ${path}`);
}

// Bybit отдаёт свечи от новых к старым и без времени закрытия — разворачиваем
// и достраиваем closeTime, чтобы формат совпадал с остальным кодом.
function parseKlines(raw: string[][], tf: TF): Candle[] {
  const step = TF_MS[tf];
  const out: Candle[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const k = raw[raw.length - 1 - i];
    const openTime = Number(k[0]);
    out[i] = {
      openTime,
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: openTime + step - 1,
    };
  }
  return out;
}

/**
 * Свечи одного символа.
 * Внимание: если задать одновременно startTime и endTime, Bybit вернёт
 * `limit` свежих свечей окна (отсчёт от конца), а не первых от начала.
 * Для длинных диапазонов используй fetchKlinesRange — он это учитывает.
 */
export async function fetchKlines(
  symbol: string, tf: TF,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<Candle[]> {
  const q = new URLSearchParams({
    category: CATEGORY,
    symbol: symbol.toUpperCase(),
    interval: INTERVAL[tf],
    limit: String(Math.min(opts.limit ?? 500, 1000)),
  });
  if (opts.startTime) q.set("start", String(opts.startTime));
  if (opts.endTime) q.set("end", String(opts.endTime));
  const r = await getResult(`/v5/market/kline?${q}`);
  return parseKlines(r.list ?? [], tf);
}

// Загрузка длинного диапазона порциями по 1000 свечей.
// Идём от конца к началу: с заданным `end` Bybit отдаёт последние свечи окна.
export async function fetchKlinesRange(
  symbol: string, tf: TF, startTime: number, endTime = Date.now(),
): Promise<Candle[]> {
  const parts: Candle[][] = [];
  let cursor = endTime;
  for (let guard = 0; guard < 60 && cursor > startTime; guard++) {
    const batch = await fetchKlines(symbol, tf, { startTime, endTime: cursor, limit: 1000 });
    if (!batch.length) break;
    parts.unshift(batch);
    cursor = batch[0].openTime - 1;
    if (batch.length < 1000) break;
  }
  return parts.flat();
}

export async function lastPrice(symbol: string): Promise<number> {
  const r = await getResult(`/v5/market/tickers?category=${CATEGORY}&symbol=${symbol.toUpperCase()}`);
  const t = r.list?.[0];
  if (!t) throw new Error(`нет тикера ${symbol}`);
  return Number(t.lastPrice);
}

export interface SymbolVolume { symbol: string; quoteVolume: number; lastPrice: number }

// Bybit размечает инструменты полем symbolType: пусто — обычная крипта,
// "stock" — токенизированные акции (AAPL, AMD, SanDisk), "commodity" — золото,
// серебро, нефть, "innovation" — зона свежих и рискованных листингов.
// Ботам нужна только первая группа: на акциях Nasdaq и металлах крипто-модели
// бессмысленны (там ещё и разрывы по выходным), а в innovation-зоне цена живёт
// разовыми выносами, а не движениями, на которых стратегии проверялись.
async function cryptoSymbols(): Promise<Set<string>> {
  const out = new Set<string>();
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const q = `category=${CATEGORY}&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await getResult(`/v5/market/instruments-info?${q}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const i of (r.list ?? []) as any[]) {
      if (!i.symbolType) out.add(i.symbol as string);
    }
    cursor = r.nextPageCursor ?? "";
    if (!cursor) break;
  }
  if (!out.size) throw new Error("Bybit вернул пустой список инструментов");
  return out;
}

// Топ-N крипто-перпов USDT по обороту за 24ч (turnover24h — оборот в USDT).
// Дефис в тикере — срочные контракты с датой экспирации, они нам не нужны.
export async function topSymbols(n = 20): Promise<SymbolVolume[]> {
  const [r, crypto] = await Promise.all([
    getResult(`/v5/market/tickers?category=${CATEGORY}`),
    cryptoSymbols(),
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (r.list as any[])
    .filter((t) => typeof t.symbol === "string" && t.symbol.endsWith("USDT")
      && !t.symbol.includes("-") && crypto.has(t.symbol))
    .map((t) => ({
      symbol: t.symbol as string,
      quoteVolume: Number(t.turnover24h),
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
