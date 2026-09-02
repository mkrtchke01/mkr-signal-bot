// Котировки BingX — бессрочные USDT-контракты (`open-api.bingx.com`, swap v2/v3).
// Нужны боту «Пробой наклонки»: он торгуется на BingX, а цена в сигнале должна
// совпадать с ценой в терминале — базис и фандинг у бирж разные.
//
// Символы внутри проекта пишутся без дефиса («ARBUSDT»), как на Bybit: так их
// хранит база и так их показывает интерфейс. Наружу уходит формат биржи
// («ARB-USDT»), преобразование — в toBingx/fromBingx.

import type { Candle, TF } from "./types";
import { TF_MS } from "./types";

const HOST = "https://open-api.bingx.com";

// Комиссии бессрочных контрактов BingX: одинаковы для всех символов
// (проверено по /quote/contracts — takerFeeRate 0.0005, makerFeeRate 0.0002).
export const TAKER_FEE = 0.0005;  // 0.05%, вход и выход по рынку
export const MAKER_FEE = 0.0002;  // 0.02%, лимитный тейк

// BingX задаёт интервал строкой, как на графике
const INTERVAL: Record<TF, string> = {
  "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h", "1d": "1d",
};

const MAX_LIMIT = 1440; // жёсткий предел API

export function toBingx(symbol: string): string {
  const s = symbol.toUpperCase();
  if (s.includes("-")) return s;
  return s.endsWith("USDT") ? `${s.slice(0, -4)}-USDT` : s;
}

export function fromBingx(symbol: string): string {
  return symbol.toUpperCase().replace("-", "");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getData(path: string): Promise<any> {
  const res = await fetch(`${HOST}${path}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`bingx ${res.status} ${res.statusText}: ${path}`);
  const j = await res.json();
  // Ошибки уровня API приходят с HTTP 200 и ненулевым code
  if (j.code !== 0) throw new Error(`bingx ${j.code}: ${j.msg} (${path})`);
  return j.data;
}

// BingX отдаёт свечи от новых к старым и без времени закрытия — разворачиваем
// и достраиваем closeTime, чтобы формат совпадал с остальным кодом.
// Порядок на всякий случай подтверждаем сортировкой: он не задокументирован.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseKlines(raw: any[], tf: TF): Candle[] {
  const step = TF_MS[tf];
  return raw
    .map((k) => {
      const openTime = Number(k.time);
      return {
        openTime,
        open: Number(k.open),
        high: Number(k.high),
        low: Number(k.low),
        close: Number(k.close),
        volume: Number(k.volume),
        closeTime: openTime + step - 1,
      };
    })
    .sort((a, b) => a.openTime - b.openTime);
}

/**
 * Свечи одного символа, от старых к новым. Последняя может быть незакрытой.
 * `startTime` работает как нижняя граница: биржа отдаёт всё от неё до сейчас
 * (не больше `limit` свечей, считая от конца).
 */
export async function fetchKlines(
  symbol: string, tf: TF,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<Candle[]> {
  const q = new URLSearchParams({
    symbol: toBingx(symbol),
    interval: INTERVAL[tf],
    limit: String(Math.min(opts.limit ?? 500, MAX_LIMIT)),
  });
  if (opts.startTime) q.set("startTime", String(opts.startTime));
  if (opts.endTime) q.set("endTime", String(opts.endTime));
  return parseKlines((await getData(`/openApi/swap/v3/quote/klines?${q}`)) ?? [], tf);
}

// Загрузка длинного диапазона порциями: идём от конца к началу, потому что
// с заданным endTime биржа отдаёт последние свечи окна.
export async function fetchKlinesRange(
  symbol: string, tf: TF, startTime: number, endTime = Date.now(),
): Promise<Candle[]> {
  const parts: Candle[][] = [];
  let cursor = endTime;
  for (let guard = 0; guard < 60 && cursor > startTime; guard++) {
    const batch = await fetchKlines(symbol, tf, {
      startTime, endTime: cursor, limit: MAX_LIMIT,
    });
    if (!batch.length) break;
    parts.unshift(batch);
    cursor = batch[0].openTime - 1;
    if (batch.length < MAX_LIMIT) break;
  }
  return parts.flat();
}

export async function lastPrice(symbol: string): Promise<number> {
  const d = await getData(`/openApi/swap/v1/ticker/price?symbol=${toBingx(symbol)}`);
  const p = Number(d?.price);
  if (!(p > 0)) throw new Error(`нет цены ${symbol} на BingX`);
  return p;
}

export interface SymbolVolume { symbol: string; quoteVolume: number; lastPrice: number }

// Не крипта: BingX помечает такие контракты префиксом в тикере —
// NCFX (валютные пары), NCCO (золото, нефть), NCSK (токенизированные акции),
// NCSI (индексы). Отображаемое имя при этом обычное («EURUSD-USDT»,
// «GOLD(XAU)-USDT»), поэтому фильтруем именно по префиксу символа.
// Крипто-моделям там делать нечего: другая природа движения и разрывы
// по выходным.
const NOT_CRYPTO = /^NC(FX|CO|SK|SI)/;

/**
 * Крипто-перпы USDT с оборотом за 24ч не меньше minQuoteVolume, от большего
 * оборота к меньшему. Тикер BingX отдаёт только торгуемые контракты, поэтому
 * отдельная проверка статуса не нужна.
 */
export async function symbolsByVolume(minQuoteVolume = 0): Promise<SymbolVolume[]> {
  const list = await getData("/openApi/swap/v2/quote/ticker");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((list ?? []) as any[])
    .filter((t) => typeof t.symbol === "string"
      && t.symbol.endsWith("-USDT") && !NOT_CRYPTO.test(t.symbol))
    .map((t) => ({
      symbol: fromBingx(t.symbol as string),
      quoteVolume: Number(t.quoteVolume),
      lastPrice: Number(t.lastPrice),
    }))
    .filter((t) => Number.isFinite(t.quoteVolume) && t.quoteVolume >= minQuoteVolume
      && t.lastPrice > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
}
