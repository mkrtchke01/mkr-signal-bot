// Общая обвязка бэктестов: загрузка свечей и фандинга с Bybit, кэш на диске,
// восстановление исторической вселенной и векторные индикаторы.
//
// Окно задаётся через ENV и одинаково для всех скриптов, поэтому кэш общий:
// DAYS=1460 — сколько дней истории брать, конец окна округлён до границы суток.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DAYS = Number(process.env.DAYS ?? 1460);
export const NOW = Math.floor(Date.now() / 86_400_000) * 86_400_000;
export const FROM = NOW - DAYS * 86_400_000;
export const WARMUP_MS = 260 * 86_400_000; // запас под EMA200 на 1d

// повтор констант из botScan.ts — тот тянет за собой db и postgres
export const MIN_QUOTE_VOLUME = 30_000_000;
export const EXCLUDED = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "BUSDUSDT", "EURUSDT", "DAIUSDT",
]);

export const TF_MS: Record<string, number> = {
  "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};
const INTERVAL: Record<string, string> = {
  "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240", "1d": "D",
};

export interface Bar { t: number; o: number; h: number; l: number; c: number; q: number }
export interface Series {
  t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number;
}

const CACHE_DIR = path.join(os.tmpdir(), "mkr-breakout-bybit");
fs.mkdirSync(CACHE_DIR, { recursive: true });

const API = "https://api.bybit.com";

// Публичные market-эндпоинты Bybit лимитированы по IP; 10 запросов в секунду
// заведомо внутри лимита и не ловит блокировку на длинных окнах.
let slotAt = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  slotAt = Math.max(slotAt + 100, now);
  const wait = slotAt - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getResult(p: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    await throttle();
    try {
      const res = await fetch(`${API}${p}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const j = await res.json();
      if (j.retCode !== 0) throw new Error(`bybit ${j.retCode}: ${j.retMsg}`);
      return j.result;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

function cached<T>(name: string, build: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE_DIR, `${name}.json`);
  if (fs.existsSync(file)) return Promise.resolve(JSON.parse(fs.readFileSync(file, "utf8")) as T);
  return build().then((v) => { fs.writeFileSync(file, JSON.stringify(v)); return v; });
}

// Bybit отдаёт свечи от новых к старым и отсчитывает окно от `end`,
// поэтому идём назад во времени, а в конце разворачиваем.
export async function loadRange(symbol: string, tf: string, from: number, to: number): Promise<Bar[]> {
  const cols = await cached<number[][]>(`k-${symbol}-${tf}-${from}-${to}`, async () => {
    const step = TF_MS[tf];
    const out: Bar[] = [];
    let cursor = to;
    while (cursor > from) {
      const q = `category=linear&symbol=${symbol}&interval=${INTERVAL[tf]}`
        + `&start=${from}&end=${cursor}&limit=1000`;
      const raw: string[][] = (await getResult(`/v5/market/kline?${q}`)).list ?? [];
      if (!raw.length) break;
      for (const k of raw) {
        const t = Number(k[0]);
        if (t + step > to) continue;         // только закрытые внутри окна
        out.push({ t, o: +k[1], h: +k[2], l: +k[3], c: +k[4], q: +k[6] });
      }
      cursor = Number(raw[raw.length - 1][0]) - 1;
      if (raw.length < 1000) break;
    }
    out.reverse();
    return [out.map((b) => b.t), out.map((b) => b.o), out.map((b) => b.h),
      out.map((b) => b.l), out.map((b) => b.c), out.map((b) => b.q)];
  });
  const [t, o, h, l, c, q] = cols;
  return t.map((_, i) => ({ t: t[i], o: o[i], h: h[i], l: l[i], c: c[i], q: q[i] }));
}

// История ставок фандинга: платится каждые 8 часов, лонг платит при ставке > 0
export interface Funding { t: Float64Array; rate: Float64Array }

export async function loadFunding(symbol: string): Promise<Funding> {
  const cols = await cached<number[][]>(`f-${symbol}-${FROM}-${NOW}`, async () => {
    const rows: [number, number][] = [];
    let cursor = NOW;
    for (let guard = 0; guard < 60 && cursor > FROM; guard++) {
      const q = `category=linear&symbol=${symbol}&startTime=${FROM}&endTime=${cursor}&limit=200`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list: any[] = (await getResult(`/v5/market/funding/history?${q}`)).list ?? [];
      if (!list.length) break;
      for (const r of list) rows.push([Number(r.fundingRateTimestamp), Number(r.fundingRate)]);
      cursor = Number(list[list.length - 1].fundingRateTimestamp) - 1;
      if (list.length < 200) break;
    }
    rows.sort((a, b) => a[0] - b[0]);
    return [rows.map((r) => r[0]), rows.map((r) => r[1])];
  });
  return { t: Float64Array.from(cols[0]), rate: Float64Array.from(cols[1]) };
}

export function toSeries(bars: Bar[]): Series {
  const n = bars.length;
  const s: Series = {
    t: new Float64Array(n), o: new Float64Array(n), h: new Float64Array(n),
    l: new Float64Array(n), c: new Float64Array(n), n,
  };
  for (let i = 0; i < n; i++) {
    s.t[i] = bars[i].t; s.o[i] = bars[i].o; s.h[i] = bars[i].h;
    s.l[i] = bars[i].l; s.c[i] = bars[i].c;
  }
  return s;
}

export async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
}

// ─────────────────────────── индикаторы (ряды) ───────────────────────────

// EMA: сид — SMA первых period значений, дальше рекуррентно. Значение на i
// совпадает с EMA, посчитанной по префиксу до i включительно.
export function emaArr(v: ArrayLike<number>, period: number): Float32Array {
  const out = new Float32Array(v.length).fill(NaN);
  if (v.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += v[i];
  seed /= period;
  out[period - 1] = seed;
  const k = 2 / (period + 1);
  for (let i = period; i < v.length; i++) out[i] = v[i] * k + out[i - 1] * (1 - k);
  return out;
}

// ATR Уайлдера: значение на i совпадает с atrWilder(bars.slice(0, i+1))
export function atrArr(
  h: ArrayLike<number>, l: ArrayLike<number>, c: ArrayLike<number>, period = 14,
): Float32Array {
  const n = c.length;
  const out = new Float32Array(n).fill(NaN);
  if (n < period + 1) return out;
  const tr = (i: number) => Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
  let v = 0;
  for (let i = 1; i <= period; i++) v += tr(i);
  v /= period;
  out[period] = v;
  for (let i = period + 1; i < n; i++) {
    v = (v * (period - 1) + tr(i)) / period;
    out[i] = v;
  }
  return out;
}

// RSI по Уайлдеру
export function rsiArr(c: ArrayLike<number>, period = 14): Float32Array {
  const n = c.length;
  const out = new Float32Array(n).fill(NaN);
  if (n <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = c[i] - c[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < n; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// Скользящий экстремум за period баров ДО i (сам i не входит)
export function rollingExtremes(
  v: ArrayLike<number>, period: number,
): { max: Float32Array; min: Float32Array } {
  const max = new Float32Array(v.length).fill(NaN);
  const min = new Float32Array(v.length).fill(NaN);
  for (let i = period; i < v.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) { hi = Math.max(hi, v[j]); lo = Math.min(lo, v[j]); }
    max[i] = hi; min[i] = lo;
  }
  return { max, min };
}

// Для каждого бара старшего ряда — индекс последнего закрытого бара младшего.
// Нужно, чтобы фильтр со старшего ТФ не заглядывал в будущее.
export function alignIndex(target: ArrayLike<number>, srcOpen: ArrayLike<number>, srcStep: number): Int32Array {
  const out = new Int32Array(target.length).fill(-1);
  let p = -1;
  for (let i = 0; i < target.length; i++) {
    while (p + 1 < srcOpen.length && srcOpen[p + 1] + srcStep <= target[i]) p++;
    out[i] = p;
  }
  return out;
}

// ─────────────────────────── вселенная ───────────────────────────

/**
 * Восстанавливает вселенную на каждый день: топ-N по обороту за прошедшие
 * сутки среди пула кандидатов — то же, что делает pickUniverse в бою.
 * Возвращает карту «начало суток → набор символов» и список всех попавших.
 */
export function universeByDay(
  daily: Map<string, Bar[]>, take: number,
): { byDay: Map<number, Set<string>>; symbols: Set<string> } {
  const byDay = new Map<number, Set<string>>();
  const symbols = new Set<string>();
  const syms = [...daily.keys()];
  const ptr = new Map<string, number>(syms.map((s) => [s, -1]));
  for (let day = FROM; day <= NOW; day += 86_400_000) {
    const row: { sym: string; q: number }[] = [];
    for (const sym of syms) {
      const bars = daily.get(sym)!;
      let p = ptr.get(sym)!;
      while (p + 1 < bars.length && bars[p + 1].t + TF_MS["1d"] <= day) p++;
      ptr.set(sym, p);
      if (p >= 0 && bars[p].q >= MIN_QUOTE_VOLUME && !EXCLUDED.has(sym)) {
        row.push({ sym, q: bars[p].q });
      }
    }
    row.sort((a, b) => b.q - a.q);
    const top = row.slice(0, take).map((x) => x.sym);
    byDay.set(day, new Set(top));
    for (const s of top) symbols.add(s);
  }
  return { byDay, symbols };
}
