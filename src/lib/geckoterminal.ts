// Данные по DEX-мемкоинам с GeckoTerminal (CoinGecko) — бесплатно и без ключа.
// Нужны три вещи:
//   1. Фид свежих пулов (new_pools) и импульсных (trending_pools) — откуда берём
//      кандидатов в наблюдение.
//   2. Пакетное обновление метрик по списку пулов (pools/multi) — так следим
//      сразу за всем watchlist-ом и открытыми позициями, не упираясь в лимит.
//   3. Богатая гранулярность m5/m15/m30/h1 по цене, объёму и сделкам (с делением
//      на покупки/продажи) — на ней строится сигнал «разгон прямо сейчас».
//
// Лимит бесплатного тарифа ~30 запросов в минуту, поэтому запросы разнесены
// небольшими паузами, а список наблюдения ограничен по размеру (см. botPrepump).

const BASE = "https://api.geckoterminal.com/api/v2";
// Версию API GeckoTerminal просит указывать в Accept — без неё ответы нестабильны
const HEADERS = { accept: "application/json;version=20230302" };

export const GT_PAGE_SLEEP_MS = 1100; // пауза между запросами, чтобы не ловить 429

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// GeckoTerminal отдаёт числа строками — аккуратно приводим, мусор → 0
function num(v: unknown): number {
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

// Разбивка показателя по окнам времени. У свежих пулов дальние окна пустые.
export interface Window {
  m5: number; m15: number; m30: number; h1: number; h6: number; h24: number;
}
export interface TxCount { buys: number; sells: number; buyers: number; sellers: number }
export interface TxWindow {
  m5: TxCount; m15: TxCount; m30: TxCount; h1: TxCount; h6: TxCount; h24: TxCount;
}

// Пул в удобном для стратегии виде — только то, что реально используем.
export interface Pool {
  net: string;          // сеть GeckoTerminal, напр. "solana"
  pool: string;         // адрес пары (он же pairAddress для ссылки DexScreener)
  token: string;        // адрес базового токена (мемкоина)
  name: string;         // "PEPE / SOL"
  symbol: string;       // тикер базового токена
  dex: string;          // на каком DEX торгуется
  priceUsd: number;     // текущая цена базового токена
  createdMs: number;    // когда создан пул
  liqUsd: number;       // ликвидность пула, $
  marketCap: number;    // капитализация (или FDV, если mc нет)
  priceChange: Window;  // изменение цены, %
  volume: Window;       // объём, $
  txns: TxWindow;       // сделки с делением на покупки/продажи
}

function emptyWindow(): Window { return { m5: 0, m15: 0, m30: 0, h1: 0, h6: 0, h24: 0 }; }

function parseWindow(o: Record<string, unknown> | undefined): Window {
  const w = o ?? {};
  return {
    m5: num(w.m5), m15: num(w.m15), m30: num(w.m30),
    h1: num(w.h1), h6: num(w.h6), h24: num(w.h24),
  };
}

function parseTx(o: Record<string, unknown> | undefined): TxWindow {
  const w = (o ?? {}) as Record<string, Record<string, unknown>>;
  const one = (x: Record<string, unknown> | undefined): TxCount => ({
    buys: num(x?.buys), sells: num(x?.sells),
    buyers: num(x?.buyers), sellers: num(x?.sellers),
  });
  return {
    m5: one(w.m5), m15: one(w.m15), m30: one(w.m30),
    h1: one(w.h1), h6: one(w.h6), h24: one(w.h24),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPool(net: string, raw: any): Pool | null {
  const a = raw?.attributes;
  if (!a?.address) return null;
  // Адрес базового токена лежит в relationships как "<net>_<mint>"
  const rel = raw.relationships?.base_token?.data?.id as string | undefined;
  const token = rel?.startsWith(`${net}_`) ? rel.slice(net.length + 1) : (rel ?? "");
  const name = String(a.name ?? "");
  return {
    net,
    pool: String(a.address),
    token,
    name,
    symbol: name.split("/")[0]?.trim() || name,
    dex: raw.relationships?.dex?.data?.id ?? "",
    priceUsd: num(a.base_token_price_usd),
    createdMs: a.pool_created_at ? Date.parse(a.pool_created_at) : 0,
    liqUsd: num(a.reserve_in_usd),
    marketCap: num(a.market_cap_usd) || num(a.fdv_usd),
    priceChange: parseWindow(a.price_change_percentage),
    volume: parseWindow(a.volume_usd),
    txns: parseTx(a.transactions),
  };
}

async function getData(path: string): Promise<unknown[]> {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, cache: "no-store" });
  if (res.status === 429) throw new Error("GeckoTerminal 429: превышен лимит запросов");
  if (!res.ok) throw new Error(`GeckoTerminal ${res.status} ${res.statusText}: ${path}`);
  const j = await res.json();
  return Array.isArray(j.data) ? j.data : [];
}

// Одна страница ленты (new_pools | trending_pools), 20 пулов
export async function fetchFeed(
  net: string, feed: "new_pools" | "trending_pools", page = 1,
): Promise<Pool[]> {
  const data = await getData(`/networks/${net}/${feed}?page=${page}`);
  return data.map((d) => toPool(net, d)).filter((p): p is Pool => p !== null);
}

// Актуальные метрики по списку адресов пулов. GeckoTerminal берёт до 30 адресов
// за раз, но возвращает не больше ~20 пулов — поэтому режем на порции по 20.
export async function fetchPoolsMulti(net: string, addresses: string[]): Promise<Pool[]> {
  const out: Pool[] = [];
  for (let i = 0; i < addresses.length; i += 20) {
    const slice = addresses.slice(i, i + 20);
    const data = await getData(`/networks/${net}/pools/multi/${slice.join(",")}`);
    for (const d of data) {
      const p = toPool(net, d);
      if (p) out.push(p);
    }
    if (i + 20 < addresses.length) await sleep(GT_PAGE_SLEEP_MS);
  }
  return out;
}

// Ссылка на график в DexScreener — привычный интерфейс для ручной торговли
export function dexScreenerUrl(p: { net: string; pool: string }): string {
  return `https://dexscreener.com/${p.net}/${p.pool}`;
}
