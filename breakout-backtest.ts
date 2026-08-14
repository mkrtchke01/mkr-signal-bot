// Бэктест бота «Пробой по тренду» на данных Bybit.
//
// Прогоняет боевую логику как есть: режим BTC → пробой 20 закрытий на 4h →
// вход по рынку через час → фикс 50% на 1.5R → трейлинг с 5R, 3 слота,
// сутки кулдауна на монету, выход по рынку через 30 дней.
//
// Что делает его «реальным»:
//  - вселенная динамическая: на каждый день строится топ-30 по обороту за 24ч,
//    как это делает pickUniverse в бою, а не сегодняшний список задним числом;
//  - деньги считаются по money.ts (риск $3, плечо, тейкерская комиссия Bybit),
//    сверху — проскальзывание на каждом исполнении по рынку;
//  - фандинг берётся настоящий, из истории ставок Bybit по каждой монете.
//
// Запуск: npx tsx breakout-backtest.ts
// ENV: STEP=15m|1h   DAYS=1460   POOL=80   SLIP=0.0005
//      UNIVERSE=dynamic|fixed    COMPARE=1 (сравнение правил переноса стопа)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ema } from "./src/lib/indicators";
import { topSymbols } from "./src/lib/bybit";
import { buildPlan, realizedPnl, RISK_USD } from "./src/lib/money";
import {
  BREAKOUT_PERIOD, STOP_ATR, TP1_R, TRAIL_ACTIVATE_R, TRAIL_ATR,
  MAX_HOLD_HOURS, CONFIRM_MIN_MS, CONFIRM_MAX_MS,
} from "./src/lib/strategyBreakout";
import type { Direction } from "./src/lib/types";

// повтор констант из botScan.ts — тот тянет за собой db и postgres
const MIN_QUOTE_VOLUME = 30_000_000;
const EXCLUDED = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "BUSDUSDT", "EURUSDT", "DAIUSDT",
]);

const MAX_ACTIVE = 3;                       // BREAKOUT_DEFAULTS.maxActive
const COOLDOWN_MS = 24 * 3_600_000;         // SYMBOL_COOLDOWN_MS
const HOLD_MS = MAX_HOLD_HOURS * 3_600_000;
const RANK_POOL = 60;                       // pickUniverse ранжирует topSymbols(60)
const SCAN_UNIVERSE = 30;                   // …и берёт из них первые 30

const STEP_TF = (process.env.STEP ?? "1h") as "15m" | "1h";
const STEP_MS = STEP_TF === "1h" ? 3_600_000 : 900_000;
// боевой скан идёт раз в 15 минут; чаще шаговой свечи сканировать смысла нет
const SCAN_MS = Math.max(15 * 60_000, STEP_MS); // BREAKOUT_DEFAULTS.scanMinutes
const DAYS = Number(process.env.DAYS ?? 1460);
const POOL_SIZE = Number(process.env.POOL ?? 80);
const SLIP = Number(process.env.SLIP ?? 0.0005); // проскальзывание на исполнение
const DYNAMIC = (process.env.UNIVERSE ?? "dynamic") !== "fixed";
const COMPARE = process.env.COMPARE === "1";

// Конец окна — граница суток: кэш свечей остаётся валидным весь день
const NOW = Math.floor(Date.now() / 86_400_000) * 86_400_000;
const FROM = NOW - DAYS * 86_400_000;
const WARMUP_MS = 260 * 86_400_000; // запас под EMA200 на 1d

// Запасная статичная вселенная (UNIVERSE=fixed) — ликвидные перпы с полной историей
const FIXED_UNIVERSE = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT",
  "AVAXUSDT", "LINKUSDT", "DOTUSDT", "LTCUSDT", "TRXUSDT", "BCHUSDT", "NEARUSDT",
  "APTUSDT", "ARBUSDT", "OPUSDT", "ATOMUSDT", "FILUSDT", "INJUSDT", "SUIUSDT",
  "XLMUSDT", "UNIUSDT", "AAVEUSDT", "ETCUSDT", "ICPUSDT", "SEIUSDT", "TIAUSDT",
  "WLDUSDT", "1000PEPEUSDT",
];

// ─────────────────────────── загрузка данных ───────────────────────────

interface Bar { t: number; o: number; h: number; l: number; c: number; q: number }
interface Series { t: Float64Array; o: Float64Array; h: Float64Array; l: Float64Array; c: Float64Array; n: number }

const CACHE_DIR = path.join(os.tmpdir(), "mkr-breakout-bybit");
fs.mkdirSync(CACHE_DIR, { recursive: true });

const API = "https://api.bybit.com";
const TF_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
const INTERVAL: Record<string, string> = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

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
async function loadRange(symbol: string, tf: string, from: number, to: number): Promise<Bar[]> {
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
interface Funding { t: Float64Array; rate: Float64Array }

async function loadFunding(symbol: string): Promise<Funding> {
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

function toSeries(bars: Bar[]): Series {
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

async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
  }));
  return out;
}

// ─────────────────────────── индикаторы ───────────────────────────

// ATR Уайлдера как ряд: значение на i совпадает с atrWilder(candles.slice(0, i+1))
function atrSeries(bars: Bar[], period = 14): Float64Array {
  const out = new Float64Array(bars.length).fill(NaN);
  if (bars.length < period + 1) return out;
  const tr = (i: number) => {
    const pc = bars[i - 1].c;
    return Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc));
  };
  let v = 0;
  for (let i = 1; i <= period; i++) v += tr(i);
  v /= period;
  out[period] = v;
  for (let i = period + 1; i < bars.length; i++) {
    v = (v * (period - 1) + tr(i)) / period;
    out[i] = v;
  }
  return out;
}

// экстремум закрытий за period баров ДО i (сам i не входит)
function extremes(closes: number[], period: number): { max: Float64Array; min: Float64Array } {
  const max = new Float64Array(closes.length).fill(NaN);
  const min = new Float64Array(closes.length).fill(NaN);
  for (let i = period; i < closes.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) { hi = Math.max(hi, closes[j]); lo = Math.min(lo, closes[j]); }
    max[i] = hi; min[i] = lo;
  }
  return { max, min };
}

// для каждого 4h-бара — индекс последнего закрытого дневного бара
function dailyIndex(h4: Bar[], d1: Bar[]): Int32Array {
  const out = new Int32Array(h4.length).fill(-1);
  let p = -1;
  for (let i = 0; i < h4.length; i++) {
    const closeTime = h4[i].t + TF_MS["4h"];
    while (p + 1 < d1.length && d1[p + 1].t + TF_MS["1d"] <= closeTime) p++;
    out[i] = p;
  }
  return out;
}

interface SymState {
  symbol: string;
  h4: Bar[];
  step: Series;
  funding: Funding;
  ema50: number[]; ema200: number[]; ema200d: number[];
  atr: Float64Array;
  extMax: Float64Array; extMin: Float64Array;
  h4Ptr: number;   // курсор последнего закрытого 4h-бара
  stepPtr: number; // курсор последней закрытой шаговой свечи
}

async function loadSymbol(symbol: string, d1: Bar[]): Promise<SymState | null> {
  const [h4, st, funding] = await Promise.all([
    loadRange(symbol, "4h", FROM - WARMUP_MS, NOW),
    loadRange(symbol, STEP_TF, FROM - 2 * 86_400_000, NOW),
    loadFunding(symbol),
  ]);
  if (h4.length < 260 || d1.length < 210 || st.length < 100) return null;

  const closes4 = h4.map((b) => b.c);
  const dIdx = dailyIndex(h4, d1);
  const ema200dSeries = ema(d1.map((b) => b.c), 200);
  const ext = extremes(closes4, BREAKOUT_PERIOD);
  return {
    symbol, h4, step: toSeries(st), funding,
    ema50: ema(closes4, 50), ema200: ema(closes4, 200),
    ema200d: Array.from(h4, (_, i) => (dIdx[i] >= 0 ? ema200dSeries[dIdx[i]] : NaN)),
    atr: atrSeries(h4), extMax: ext.max, extMin: ext.min,
    h4Ptr: -1, stepPtr: -1,
  };
}

// ─────────────────────────── режим BTC ───────────────────────────

type Bias = "LONG" | "SHORT" | "NEUTRAL";

function btcBiasByH4(h4: Bar[], d1: Bar[]): Map<number, Bias> {
  const closes4 = h4.map((b) => b.c);
  const closes1 = d1.map((b) => b.c);
  const e20d = ema(closes1, 20);
  const e20h = ema(closes4, 20), e50h = ema(closes4, 50);
  const dIdx = dailyIndex(h4, d1);
  const out = new Map<number, Bias>();
  for (let i = 0; i < h4.length; i++) {
    const d = dIdx[i];
    let bias: Bias = "NEUTRAL";
    if (d >= 0) {
      const price = closes4[i];
      if (price > e20d[d] && e20h[i] > e50h[i]) bias = "LONG";
      else if (price < e20d[d] && e20h[i] < e50h[i]) bias = "SHORT";
    }
    out.set(h4[i].t, bias);
  }
  return out;
}

// ─────────────────────────── сделка ───────────────────────────

interface Entry {
  symbol: string; direction: Direction; openedAt: number; stepIdx: number;
  entry: number; stop: number; tp1: number; activateAt: number; trailAbs: number; score: number;
}

type Status = "SL" | "PART" | "TRAIL" | "TIME" | "OPEN";

interface Outcome {
  status: Status; exitTime: number; exitPrice: number; tp1Done: boolean;
  gross: number; fees: number; slip: number; funding: number; pnlUsd: number; r: number;
}

interface Variant { key: string; label: string; beR: number | null; activateR?: number }

// beR: null — стоп после TP1 не двигаем (текущее поведение бота);
// число — стоп переносится на entry + beR × risk в сторону прибыли.
// activateR — если задано, трейлинг включается не на 5R, а на другом уровне.
function simulateTrade(s: SymState, e: Entry, v: Variant): Outcome {
  const isLong = e.direction === "LONG";
  const sign = isLong ? 1 : -1;
  const risk = Math.abs(e.entry - e.stop);
  const plan = buildPlan(e.direction, e.entry, e.stop, e.tp1);
  const qty = plan?.qty ?? 0;
  const st = s.step;
  const activateAt = v.activateR === undefined
    ? e.activateAt
    : e.entry + sign * v.activateR * risk;

  let stop = e.stop;
  let best = e.entry;
  let tp1Done = false;
  let trailOn = false;
  let funding = 0;

  // фандинг платится каждые 8 часов; до TP1 в позиции весь объём, после — половина
  let fi = 0;
  while (fi < s.funding.t.length && s.funding.t[fi] < e.openedAt) fi++;

  const done = (status: Status, exitTime: number, exitPrice: number): Outcome => {
    const gross = tp1Done
      ? qty * 0.5 * sign * (e.tp1 - e.entry) + qty * 0.5 * sign * (exitPrice - e.entry)
      : qty * sign * (exitPrice - e.entry);
    const afterFees = plan
      ? realizedPnl(plan, e.direction, e.entry, e.tp1, exitPrice, tp1Done) : 0;
    // проскальзывание на каждом исполнении по рынку: вход, частичный тейк, выход
    const slip = SLIP * qty * (e.entry + (tp1Done ? 0.5 * e.tp1 + 0.5 * exitPrice : exitPrice));
    return {
      status, exitTime, exitPrice, tp1Done,
      gross, fees: gross - afterFees, slip, funding,
      pnlUsd: afterFees - slip - funding,
      r: (afterFees - slip - funding) / RISK_USD,
    };
  };

  for (let i = e.stepIdx; i < st.n; i++) {
    // порядок как в bot.ts: сначала стоп, потом цели
    if (isLong ? st.l[i] <= stop : st.h[i] >= stop) {
      return done(trailOn ? "TRAIL" : tp1Done ? "PART" : "SL", st.t[i], stop);
    }
    if (!tp1Done && (isLong ? st.h[i] >= e.tp1 : st.l[i] <= e.tp1)) {
      tp1Done = true;
      if (v.beR !== null) {
        const be = e.entry + sign * v.beR * risk;
        stop = isLong ? Math.max(stop, be) : Math.min(stop, be);
      }
    }
    if (!trailOn && (isLong ? st.h[i] >= activateAt : st.l[i] <= activateAt)) {
      trailOn = true;
      best = isLong ? st.h[i] : st.l[i];
    }
    if (trailOn) {
      best = isLong ? Math.max(best, st.h[i]) : Math.min(best, st.l[i]);
      const trail = best - sign * e.trailAbs;
      stop = isLong ? Math.max(stop, trail) : Math.min(stop, trail);
    }
    // выплаты фандинга, попавшие в эту свечу
    const end = st.t[i] + STEP_MS;
    while (fi < s.funding.t.length && s.funding.t[fi] < end) {
      funding += s.funding.rate[fi] * qty * (tp1Done ? 0.5 : 1) * st.c[i] * sign;
      fi++;
    }
    if (end - e.openedAt >= HOLD_MS) return done("TIME", end, st.c[i]);
  }
  return done("OPEN", st.t[st.n - 1] + STEP_MS, st.c[st.n - 1]);
}

// ─────────────────────────── портфельный прогон ───────────────────────────

interface Trade { entry: Entry; out: Outcome }

function runPortfolio(
  syms: SymState[], bias: Map<number, Bias>,
  universeByDay: Map<number, Set<string>> | null,
  v: Variant, maxActive = MAX_ACTIVE,
): Trade[] {
  for (const s of syms) { s.h4Ptr = -1; s.stepPtr = -1; }

  const trades: Trade[] = [];
  const openUntil = new Map<string, number>();  // symbol → exitTime активной позиции
  const lastEntry = new Map<string, number>();  // symbol → время последнего входа
  const byName = new Map(syms.map((s) => [s.symbol, s]));

  for (let t = FROM; t <= NOW; t += SCAN_MS) {
    for (const [sym, until] of openUntil) if (until <= t) openUntil.delete(sym);
    const slots = maxActive - openUntil.size;
    const universe = universeByDay?.get(Math.floor(t / 86_400_000) * 86_400_000);

    const cands: Entry[] = [];
    for (const s of syms) {
      // курсоры двигаем всегда, даже когда слотов нет
      while (s.h4Ptr + 1 < s.h4.length && s.h4[s.h4Ptr + 1].t + TF_MS["4h"] <= t) s.h4Ptr++;
      while (s.stepPtr + 1 < s.step.n && s.step.t[s.stepPtr + 1] + STEP_MS <= t) s.stepPtr++;
      if (slots <= 0) continue;
      if (universe && !universe.has(s.symbol)) continue;

      const i = s.h4Ptr;
      if (i < 210) continue;
      const bar = s.h4[i];
      const age = t - (bar.t + TF_MS["4h"] - 1);
      if (age < CONFIRM_MIN_MS || age > CONFIRM_MAX_MS) continue;
      if (openUntil.has(s.symbol)) continue;
      const last = lastEntry.get(s.symbol);
      if (last !== undefined && t - last < COOLDOWN_MS) continue;

      const b = bias.get(bar.t) ?? "NEUTRAL";
      if (b === "NEUTRAL") continue;

      const a = s.atr[i], e50 = s.ema50[i], e200 = s.ema200[i], e200d = s.ema200d[i];
      if (!(a > 0) || [e50, e200, e200d].some(Number.isNaN)) continue;

      const up = e50 > e200 && bar.c > e200d;
      const down = e50 < e200 && bar.c < e200d;
      let direction: Direction | null = null;
      if (b === "LONG" && up && bar.c > s.extMax[i]) direction = "LONG";
      else if (b === "SHORT" && down && bar.c < s.extMin[i]) direction = "SHORT";
      if (!direction) continue;

      // цена входа — последняя известная на момент скана
      const j = s.stepPtr;
      if (j < 0 || s.step.t[j] + 2 * STEP_MS < t) continue; // нет свежих данных
      const live = s.step.c[j];
      if (!(live > 0)) continue;

      const isLong = direction === "LONG";
      if (isLong ? live < bar.c - a : live > bar.c + a) continue; // пробой уже съеден

      const sign = isLong ? 1 : -1;
      const stop = live - sign * STOP_ATR * a;
      const risk = Math.abs(live - stop);
      if (!(risk > 0)) continue;
      cands.push({
        symbol: s.symbol, direction, openedAt: t, stepIdx: j + 1,
        entry: live, stop,
        tp1: live + sign * TP1_R * risk,
        activateAt: live + sign * TRAIL_ACTIVATE_R * risk,
        trailAbs: TRAIL_ATR * a, score: Math.abs(bar.c - e50) / a,
      });
    }

    if (!cands.length) continue;
    cands.sort((x, y) => y.score - x.score);
    for (const c of cands.slice(0, slots)) {
      const s = byName.get(c.symbol)!;
      if (c.stepIdx >= s.step.n) continue;
      const out = simulateTrade(s, c, v);
      trades.push({ entry: c, out });
      openUntil.set(c.symbol, out.exitTime);
      lastEntry.set(c.symbol, t);
    }
  }
  return trades;
}

// ─────────────────────────── статистика ───────────────────────────

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "∞");
const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(1)}`;
const pad = (s: string, n: number) => s.padEnd(n);

interface Stats {
  n: number; closed: number; open: number; winRate: number; totalUsd: number;
  avgR: number; sdR: number; pf: number; maxDD: number; retDD: number;
  sl: number; part: number; trail: number; time: number; tp1: number;
  worstStreak: number; avgDays: number; top10: number;
  gross: number; fees: number; slip: number; funding: number;
}

function stats(rows: Trade[]): Stats {
  const closed = rows.filter((x) => x.out.status !== "OPEN")
    .sort((a, b) => a.out.exitTime - b.out.exitTime);
  const wins = closed.filter((x) => x.out.pnlUsd > 0);
  const gross = closed.reduce((s, x) => s + Math.max(x.out.pnlUsd, 0), 0);
  const loss = closed.reduce((s, x) => s + Math.max(-x.out.pnlUsd, 0), 0);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const x of closed) {
    eq += x.out.pnlUsd; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    streak = x.out.pnlUsd > 0 ? 0 : streak + 1;
    worst = Math.max(worst, streak);
  }
  const total = closed.reduce((s, x) => s + x.out.pnlUsd, 0);
  const avgR = closed.length ? closed.reduce((s, x) => s + x.out.r, 0) / closed.length : 0;
  const sdR = closed.length > 1
    ? Math.sqrt(closed.reduce((s, x) => s + (x.out.r - avgR) ** 2, 0) / (closed.length - 1)) : 0;
  const cnt = (st: Status) => rows.filter((x) => x.out.status === st).length;
  const top10 = [...closed].sort((a, b) => b.out.pnlUsd - a.out.pnlUsd).slice(0, 10)
    .reduce((s, x) => s + x.out.pnlUsd, 0);
  return {
    n: rows.length, closed: closed.length, open: cnt("OPEN"),
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    totalUsd: total, avgR, sdR,
    pf: loss > 0 ? gross / loss : Infinity,
    maxDD: dd, retDD: dd > 0 ? total / dd : Infinity,
    sl: cnt("SL"), part: cnt("PART"), trail: cnt("TRAIL"), time: cnt("TIME"),
    tp1: rows.filter((x) => x.out.tp1Done).length,
    worstStreak: worst,
    avgDays: closed.length
      ? closed.reduce((s, x) => s + (x.out.exitTime - x.entry.openedAt), 0) / closed.length / 86_400_000 : 0,
    top10: total !== 0 ? (top10 / total) * 100 : 0,
    gross: closed.reduce((s, x) => s + x.out.gross, 0),
    fees: closed.reduce((s, x) => s + x.out.fees, 0),
    slip: closed.reduce((s, x) => s + x.out.slip, 0),
    funding: closed.reduce((s, x) => s + x.out.funding, 0),
  };
}

function report(trades: Trade[]): void {
  const s = stats(trades);
  const months = DAYS / 30.44;
  console.log("\n════════ ИТОГ (текущий код, без изменений) ════════");
  console.log(`Сделок: ${s.closed} закрытых${s.open ? ` + ${s.open} в позиции на конец периода` : ""}`
    + ` (${f(s.closed / months, 1)} в месяц), средняя живёт ${f(s.avgDays, 1)} дн`);
  console.log(`Итог: ${money(s.totalUsd)} при риске $${RISK_USD}/сделку`
    + `  |  профит-фактор ${f(s.pf)}  |  в плюс ${f(s.winRate, 1)}%`);
  console.log(`Средняя сделка: ${f(s.avgR, 3)}R (σ ${f(s.sdR)})`
    + `  |  макс. просадка $${f(s.maxDD, 1)}  |  итог/просадка ${f(s.retDD)}`);
  console.log(`Худшая серия убытков подряд: ${s.worstStreak}`
    + `  |  топ-10 сделок дают ${f(s.top10, 1)}% всей прибыли`);
  console.log(`Исходы: SL ${s.sl} · PART ${s.part} · TRAIL ${s.trail} · TIME ${s.time}`
    + `  |  до TP1 дошли ${s.tp1} (${f(s.tp1 / s.closed * 100, 1)}%)`);

  console.log("\nИздержки (уже вычтены из итога):");
  console.log(`  движение цены        ${money(s.gross)}`);
  console.log(`  комиссии Bybit       ${money(-s.fees)}`);
  console.log(`  проскальзывание      ${money(-s.slip)}  (${(SLIP * 10000).toFixed(1)} б.п. на исполнение)`);
  console.log(`  фандинг              ${money(-s.funding)}  (реальные ставки Bybit)`);
  console.log(`  ─────────────────────────────`);
  console.log(`  чистыми              ${money(s.totalUsd)}`);

  // по годам — прибыль относим к моменту закрытия сделки
  const byYear = new Map<number, Trade[]>();
  for (const t of trades) {
    if (t.out.status === "OPEN") continue;
    const y = new Date(t.out.exitTime).getUTCFullYear();
    (byYear.get(y) ?? byYear.set(y, []).get(y)!).push(t);
  }
  console.log("\nПо годам (по дате закрытия):");
  console.log(pad("  год", 10) + ["сделок", "итог $", "win%", "PF", "maxDD $"].map((h) => h.padStart(10)).join(""));
  for (const y of [...byYear.keys()].sort()) {
    const q = stats(byYear.get(y)!);
    console.log(pad(`  ${y}`, 10) + [String(q.closed), money(q.totalUsd), f(q.winRate, 1), f(q.pf), f(q.maxDD, 1)]
      .map((v) => v.padStart(10)).join(""));
  }

  const half = FROM + (NOW - FROM) / 2;
  const h1 = stats(trades.filter((t) => t.entry.openedAt < half));
  const h2 = stats(trades.filter((t) => t.entry.openedAt >= half));
  console.log(`\nПо половинам периода: ${money(h1.totalUsd)} (${h1.closed} сделок)`
    + ` / ${money(h2.totalUsd)} (${h2.closed} сделок)`);

  // по монетам
  const bySym = new Map<string, Trade[]>();
  for (const t of trades) (bySym.get(t.entry.symbol) ?? bySym.set(t.entry.symbol, []).get(t.entry.symbol)!).push(t);
  const rank = [...bySym.entries()].map(([sym, r]) => ({ sym, s: stats(r) }))
    .sort((a, b) => b.s.totalUsd - a.s.totalUsd);
  const plus = rank.filter((x) => x.s.totalUsd > 0).length;
  console.log(`\nМонет в работе: ${rank.length}, из них прибыльных ${plus}`);
  console.log(`  лучшие:  ${rank.slice(0, 5).map((x) => `${x.sym} ${money(x.s.totalUsd)}`).join(", ")}`);
  console.log(`  худшие:  ${rank.slice(-5).reverse().map((x) => `${x.sym} ${money(x.s.totalUsd)}`).join(", ")}`);
  const best = rank[0];
  console.log(`  без лучшей монеты (${best.sym}): ${money(s.totalUsd - best.s.totalUsd)}`);
}

// ─────────────────────────── main ───────────────────────────

const VARIANTS: Variant[] = [
  { key: "none", label: "как сейчас (стоп не трогаем)", beR: null },
  { key: "be", label: "стоп в безубыток (0R)", beR: 0 },
  { key: "be+0.25", label: "стоп в +0.25R", beR: 0.25 },
  { key: "be+0.5", label: "стоп в +0.5R", beR: 0.5 },
  { key: "trail3", label: "трейлинг с 3R, без БУ", beR: null, activateR: 3 },
];

async function main() {
  console.error(`Окно: ${new Date(FROM).toISOString().slice(0, 10)} … ${new Date(NOW).toISOString().slice(0, 10)}`
    + ` | шаг ${STEP_TF} | вселенная ${DYNAMIC ? "динамическая" : "фиксированная"}`
    + ` | риск $${RISK_USD} | проскальзывание ${(SLIP * 10000).toFixed(1)} б.п.`);

  // 1. Пул кандидатов и дневные свечи по ним (дёшево: 2 запроса на монету)
  const poolSymbols = DYNAMIC
    ? (await topSymbols(POOL_SIZE)).map((t) => t.symbol)
    : FIXED_UNIVERSE;
  if (!poolSymbols.includes("BTCUSDT")) poolSymbols.push("BTCUSDT");
  console.error(`Пул кандидатов: ${poolSymbols.length} монет, гружу дневки…`);

  const daily = new Map<string, Bar[]>();
  await pool(poolSymbols, 6, async (sym) => {
    try { daily.set(sym, await loadRange(sym, "1d", FROM - WARMUP_MS, NOW)); } catch { /* нет истории */ }
  });

  // 2. Вселенная на каждый день: топ-30 по обороту за прошедшие сутки —
  //    то же, что делает pickUniverse в бою, но по историческим данным.
  let universeByDay: Map<number, Set<string>> | null = null;
  let traded = new Set(poolSymbols);
  if (DYNAMIC) {
    universeByDay = new Map();
    traded = new Set();
    const ptr = new Map<string, number>(poolSymbols.map((s) => [s, -1]));
    for (let day = FROM; day <= NOW; day += 86_400_000) {
      const row: { sym: string; q: number }[] = [];
      for (const sym of poolSymbols) {
        const bars = daily.get(sym);
        if (!bars) continue;
        let p = ptr.get(sym)!;
        while (p + 1 < bars.length && bars[p + 1].t + TF_MS["1d"] <= day) p++;
        ptr.set(sym, p);
        if (p >= 0 && bars[p].q >= MIN_QUOTE_VOLUME && !EXCLUDED.has(sym)) {
          row.push({ sym, q: bars[p].q });
        }
      }
      row.sort((a, b) => b.q - a.q);
      const top = row.slice(0, RANK_POOL).slice(0, SCAN_UNIVERSE).map((x) => x.sym);
      universeByDay.set(day, new Set(top));
      for (const s of top) traded.add(s);
    }
    console.error(`Хоть раз попадали в топ-${SCAN_UNIVERSE}: ${traded.size} монет`);
  }
  traded.add("BTCUSDT");

  // 3. Свечи и фандинг только по монетам, которые реально могли торговаться
  console.error(`Гружу 4h/${STEP_TF}/фандинг по ${traded.size} монетам…`);
  let n = 0;
  const list = [...traded];
  const states = (await pool(list, 5, async (sym) => {
    try {
      const d1 = daily.get(sym);
      const s = d1 ? await loadSymbol(sym, d1) : null;
      if (++n % 10 === 0) console.error(`  ${n}/${list.length}`);
      return s;
    } catch (e) {
      console.error(`  ${sym} — ошибка: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  })).filter((x): x is SymState => x !== null);

  const btc = states.find((s) => s.symbol === "BTCUSDT");
  if (!btc) throw new Error("нет данных по BTCUSDT");
  const bias = btcBiasByH4(btc.h4, daily.get("BTCUSDT")!);
  console.error(`Готово: ${states.length} монет. Считаю…`);

  // 4. Основной прогон — боевые правила как есть
  const base = runPortfolio(states, bias, universeByDay, VARIANTS[0]);
  report(base);

  if (!COMPARE) return;

  // 5. Сравнение правил переноса стопа на одном и том же наборе входов
  const byName = new Map(states.map((s) => [s.symbol, s]));
  console.log("\n════════ ЕСЛИ МЕНЯТЬ ПРАВИЛО СТОПА (те же входы) ════════");
  console.log(pad("вариант", 30)
    + ["итог $", "ср. R", "PF", "maxDD $", "итог/DD", "TRAIL", "PART"].map((h) => h.padStart(9)).join(""));
  const baseRows = base.map(({ entry }) => ({ entry, out: simulateTrade(byName.get(entry.symbol)!, entry, VARIANTS[0]) }));
  for (const v of VARIANTS) {
    const rows = base.map(({ entry }) => ({ entry, out: simulateTrade(byName.get(entry.symbol)!, entry, v) }));
    const q = stats(rows);
    console.log(pad(v.label, 30) + [money(q.totalUsd), f(q.avgR, 3), f(q.pf), f(q.maxDD, 1),
      f(q.retDD), String(q.trail), String(q.part)].map((x) => x.padStart(9)).join(""));
    if (v.key === "none") continue;
    const d = rows.map((r, i) => r.out.pnlUsd - baseRows[i].out.pnlUsd);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(d.length - 1, 1));
    console.log(pad(`  → разница с текущим`, 30)
      + `${money(mean * d.length)}, t=${f(sd > 0 ? mean / (sd / Math.sqrt(d.length)) : 0)}`);
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
