// Поиск интрадей-стратегии: сделка живёт часы, максимум неделю.
//
// Перебираются шесть семейств входа × правила выхода. Считается всё как в бою:
// риск $3 на сделку, объём и плечо из money.ts, тейкерская комиссия Bybit,
// проскальзывание на каждом исполнении, реальные ставки фандинга.
//
// Защита от подгонки: период делится пополам. Первая половина — обучающая,
// по ней ранжируем; вторая нужна только чтобы посмотреть, выжила ли стратегия.
// В топ идут только те, у кого обе половины в плюсе и достаточно сделок.
//
// Запуск: npx tsx --max-old-space-size=8192 intraday-search.ts
// ENV: DAYS=1460  TOP=20 (размер вселенной)  POOL=80  SLIP=0.0005

import {
  DAYS, FROM, NOW, WARMUP_MS, TF_MS, loadRange, loadFunding, toSeries, pool,
  emaArr, atrArr, rsiArr, alignIndex, universeByDay,
  type Bar, type Series, type Funding,
} from "./backtest-data";
import { topSymbols } from "./src/lib/bybit";
import { RISK_USD } from "./src/lib/money";

const STEP = "15m";
const STEP_MS = TF_MS[STEP];
const SLIP = Number(process.env.SLIP ?? 0.0005);
// Комиссии Bybit: вход по рынку и стоп — тейкер, лимитная цель и лимитный
// вход — мейкер. Для интрадея разница принципиальная: на коротком стопе
// круговые издержки съедают заметную долю риска.
const FEE_TAKER = 0.00055;
const FEE_MAKER = 0.0001;
const POOL_SIZE = Number(process.env.POOL ?? 80);
const TOP_N = Number(process.env.TOP ?? 20);
const MAX_ACTIVE = 3;
const COOLDOWN_MS = 4 * 3_600_000;  // интрадею сутки паузы ни к чему
const HALF = FROM + (NOW - FROM) / 2;
const MIN_TRADES = 80;              // меньше — статистики нет

// ─────────────────────────── данные по монете ───────────────────────────

interface Sym {
  symbol: string;
  s: Series;              // 15m
  atr: Float32Array;      // ATR(14) на 15m
  rsi: Float32Array;
  ema20: Float32Array;
  ema50: Float32Array;
  atrMean: Float32Array;  // средний ATR за сутки — для детекции сжатия
  trend1h: Int8Array;     // +1 / −1 / 0 по EMA50 vs EMA200 на 1h
  trend4h: Int8Array;
  funding: Funding;
}

// среднее по окну без пересчёта суммы каждый раз
function rollingMean(v: ArrayLike<number>, period: number): Float32Array {
  const out = new Float32Array(v.length).fill(NaN);
  let sum = 0, cnt = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (Number.isFinite(x)) { sum += x; cnt++; }
    if (i >= period) {
      const old = v[i - period];
      if (Number.isFinite(old)) { sum -= old; cnt--; }
    }
    if (cnt > 0 && i >= period) out[i] = sum / cnt;
  }
  return out;
}

// Скользящий экстремум за period баров ДО i через монотонную очередь: O(n)
function rollMax(v: ArrayLike<number>, period: number): Float32Array {
  const out = new Float32Array(v.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (i >= period) out[i] = v[dq[0]];
    while (dq.length && v[dq[dq.length - 1]] <= v[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - period) dq.shift();
  }
  return out;
}
function rollMin(v: ArrayLike<number>, period: number): Float32Array {
  const out = new Float32Array(v.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (i >= period) out[i] = v[dq[0]];
    while (dq.length && v[dq[dq.length - 1]] >= v[i]) dq.pop();
    dq.push(i);
    if (dq[0] <= i - period) dq.shift();
  }
  return out;
}

function trendFrom(bars: Bar[], targetT: Float64Array, step: number): Int8Array {
  const c = bars.map((b) => b.c);
  const e50 = emaArr(c, 50), e200 = emaArr(c, 200);
  const idx = alignIndex(targetT, bars.map((b) => b.t), step);
  const out = new Int8Array(targetT.length);
  for (let i = 0; i < targetT.length; i++) {
    const j = idx[i];
    if (j < 0 || Number.isNaN(e200[j])) continue;
    out[i] = e50[j] > e200[j] ? 1 : e50[j] < e200[j] ? -1 : 0;
  }
  return out;
}

async function loadSym(symbol: string): Promise<Sym | null> {
  const [m15, h1, h4, funding] = await Promise.all([
    loadRange(symbol, STEP, FROM - 5 * 86_400_000, NOW),
    loadRange(symbol, "1h", FROM - 40 * 86_400_000, NOW),
    loadRange(symbol, "4h", FROM - WARMUP_MS, NOW),
    loadFunding(symbol),
  ]);
  if (m15.length < 5000 || h1.length < 300 || h4.length < 260) return null;
  const s = toSeries(m15);
  const atr = atrArr(s.h, s.l, s.c, 14);
  return {
    symbol, s, atr,
    rsi: rsiArr(s.c, 14),
    ema20: emaArr(s.c, 20),
    ema50: emaArr(s.c, 50),
    atrMean: rollingMean(atr, 96),
    trend1h: trendFrom(h1, s.t, TF_MS["1h"]),
    trend4h: trendFrom(h4, s.t, TF_MS["4h"]),
    funding,
  };
}

// ─────────────────────────── сигналы ───────────────────────────

interface Sig { sym: number; i: number; t: number; dir: 1 | -1; score: number }

interface EntryCfg {
  key: string;
  family: string;
  note: string;
  /** уровень входа известен заранее → можно встать лимиткой и платить мейкера */
  maker?: boolean;
  scan: (x: Sym, si: number, out: Sig[]) => void;
}

const push = (out: Sig[], x: Sym, si: number, i: number, dir: 1 | -1) => {
  const a = x.atr[i];
  if (!(a > 0) || !Number.isFinite(x.ema50[i])) return;
  out.push({ sym: si, i, t: x.s.t[i], dir, score: Math.abs(x.s.c[i] - x.ema50[i]) / a });
};

// A. Откат в тренде: RSI ушёл в перепроданность и вернулся, тренд старшего ТФ за нас
function pullback(rsiLo: number, ctx: "1h" | "4h"): EntryCfg {
  return {
    key: `PB-rsi${rsiLo}-${ctx}`, family: "Откат в тренде",
    note: `RSI(14,15m) пересекает ${rsiLo}/${100 - rsiLo} обратно, тренд ${ctx} за нас`,
    scan: (x, si, out) => {
      const tr = ctx === "1h" ? x.trend1h : x.trend4h;
      for (let i = 210; i < x.s.n; i++) {
        if (tr[i] > 0 && x.rsi[i - 1] < rsiLo && x.rsi[i] >= rsiLo) push(out, x, si, i, 1);
        else if (tr[i] < 0 && x.rsi[i - 1] > 100 - rsiLo && x.rsi[i] <= 100 - rsiLo) push(out, x, si, i, -1);
      }
    },
  };
}

// B. Пробой N-барового диапазона (импульс)
function breakout(n: number, withTrend: boolean): EntryCfg {
  return {
    key: `BO-${n}b${withTrend ? "-tr" : ""}`, family: "Пробой диапазона",
    note: `закрытие 15m выше/ниже экстремума ${n} баров (${n / 4}ч)`
      + (withTrend ? ", по тренду 1h" : ", без фильтра тренда"),
    scan: (x, si, out) => {
      const hi = rollMax(x.s.h, n), lo = rollMin(x.s.l, n);
      for (let i = 210; i < x.s.n; i++) {
        const t = x.trend1h[i];
        if (x.s.c[i] > hi[i] && (!withTrend || t > 0)) push(out, x, si, i, 1);
        else if (x.s.c[i] < lo[i] && (!withTrend || t < 0)) push(out, x, si, i, -1);
      }
    },
  };
}

// C. Пробой утреннего диапазона: первые R часов сессии задают коридор
function orb(startH: number, rangeH: number): EntryCfg {
  return {
    key: `ORB-${startH}h-${rangeH}h`, family: "Пробой диапазона сессии",
    note: `диапазон первых ${rangeH}ч после ${String(startH).padStart(2, "0")}:00 UTC, вход на выходе из него`,
    scan: (x, si, out) => {
      let sid = -1, hi = -Infinity, lo = Infinity, fired = false;
      for (let i = 210; i < x.s.n; i++) {
        const shifted = x.s.t[i] - startH * 3_600_000;
        const cur = Math.floor(shifted / 86_400_000);
        if (cur !== sid) { sid = cur; hi = -Infinity; lo = Infinity; fired = false; }
        const inRange = shifted - cur * 86_400_000 < rangeH * 3_600_000;
        if (inRange) { hi = Math.max(hi, x.s.h[i]); lo = Math.min(lo, x.s.l[i]); continue; }
        if (fired || !Number.isFinite(hi)) continue;
        if (x.s.c[i] > hi) { fired = true; push(out, x, si, i, 1); }
        else if (x.s.c[i] < lo) { fired = true; push(out, x, si, i, -1); }
      }
    },
  };
}

// D. Сжатие волатильности и выход из него
function squeeze(ratio: number, n: number): EntryCfg {
  return {
    key: `SQ-${ratio}-${n}b`, family: "Выход из сжатия",
    note: `ATR ниже ${ratio} от суточного среднего, затем пробой ${n} баров`,
    scan: (x, si, out) => {
      const hi = rollMax(x.s.h, n), lo = rollMin(x.s.l, n);
      for (let i = 210; i < x.s.n; i++) {
        const m = x.atrMean[i - 1];
        if (!(m > 0) || x.atr[i - 1] > ratio * m) continue;
        if (x.s.c[i] > hi[i]) push(out, x, si, i, 1);
        else if (x.s.c[i] < lo[i]) push(out, x, si, i, -1);
      }
    },
  };
}

// E. Возврат к средней: цену унесло от EMA50 — заходим против движения
function fade(dev: number, onlyWithTrend: boolean): EntryCfg {
  return {
    key: `FD-${dev}atr${onlyWithTrend ? "-tr" : ""}`, family: "Возврат к средней",
    maker: true, // уровень отклонения от EMA известен заранее — ставим лимитку
    note: `цена ${dev}×ATR от EMA50(15m), вход против движения`
      + (onlyWithTrend ? ", только по тренду 1h (покупка провалов)" : ", без фильтра"),
    scan: (x, si, out) => {
      for (let i = 210; i < x.s.n; i++) {
        const a = x.atr[i], e = x.ema50[i];
        if (!(a > 0) || Number.isNaN(e)) continue;
        const d = (x.s.c[i] - e) / a;
        const t = x.trend1h[i];
        if (d <= -dev && (!onlyWithTrend || t > 0)) push(out, x, si, i, 1);
        else if (d >= dev && (!onlyWithTrend || t < 0)) push(out, x, si, i, -1);
      }
    },
  };
}

// F. Импульсная свеча: широкий бар с закрытием у края — продолжение
function ignition(k: number): EntryCfg {
  return {
    key: `IG-${k}atr`, family: "Импульсная свеча",
    note: `бар шире ${k}×ATR с закрытием в верхней/нижней пятой части, вход по направлению`,
    scan: (x, si, out) => {
      for (let i = 210; i < x.s.n; i++) {
        const a = x.atr[i - 1];
        const rng = x.s.h[i] - x.s.l[i];
        if (!(a > 0) || rng < k * a || rng <= 0) continue;
        const pos = (x.s.c[i] - x.s.l[i]) / rng;
        if (pos >= 0.8) push(out, x, si, i, 1);
        else if (pos <= 0.2) push(out, x, si, i, -1);
      }
    },
  };
}

// G. Относительная сила: монета обгоняет BTC на том же горизонте.
// Классический кросс-секционный импульс, сведённый к паре «монета против BTC».
let btcRet: Map<number, Float32Array> | null = null; // n → доходность BTC за n баров, по времени
let btcIdx: Map<number, number> | null = null;       // время бара → индекс в рядах BTC

function relStrength(n: number, thr: number): EntryCfg {
  return {
    key: `RS-${n}b-${thr}`, family: "Сила против BTC",
    note: `монета обгоняет BTC за ${n} баров (${n / 4}ч) более чем на ${thr}%, вход по направлению`,
    scan: (x, si, out) => {
      const rets = btcRet!.get(n)!;
      for (let i = 210; i < x.s.n; i++) {
        const bi = btcIdx!.get(x.s.t[i]);
        if (bi === undefined || bi < n) continue;
        const br = rets[bi];
        if (!Number.isFinite(br)) continue;
        const sr = (x.s.c[i] / x.s.c[i - n] - 1) * 100;
        const d = sr - br;
        if (d > thr && x.trend1h[i] > 0) push(out, x, si, i, 1);
        else if (d < -thr && x.trend1h[i] < 0) push(out, x, si, i, -1);
      }
    },
  };
}

// Первый проход показал: возврат к средней, откат по RSI, сжатие и импульсная
// свеча не выживают ни при каких выходах — оставлены по одному представителю
// для протокола. Сетка уплотнена вокруг двух семейств, которые выжили.
const ENTRIES: EntryCfg[] = [
  ...[24, 48, 96].flatMap((n) => [1, 2, 3, 4].map((thr) => relStrength(n, thr))),
  ...[24, 48, 96].flatMap((n) => [true, false].map((t) => breakout(n, t))),
  ...[0, 8].flatMap((h) => [2, 4].map((r) => orb(h, r))),
  pullback(30, "1h"), squeeze(0.7, 24), fade(2.5, true), ignition(2),
];

// ─────────────────────────── выход ───────────────────────────

interface ExitCfg { key: string; stopAtr: number; mode: "R" | "trail" | "part"; rr: number; holdH: number }

// Стопы шире 6×ATR добавлены намеренно: в первом проходе оптимум упирался
// в край сетки, а это обычно значит, что вершина ещё дальше.
const EXITS: ExitCfg[] = [];
for (const stopAtr of [2.5, 4, 6, 8, 10]) {
  for (const holdH of [12, 24, 48, 168]) {
    for (const rr of [1.5, 2.5]) EXITS.push({ key: `sl${stopAtr}-tp${rr}R-${holdH}h`, stopAtr, mode: "R", rr, holdH });
    EXITS.push({ key: `sl${stopAtr}-trail-${holdH}h`, stopAtr, mode: "trail", rr: 1, holdH });
    EXITS.push({ key: `sl${stopAtr}-half+trail-${holdH}h`, stopAtr, mode: "part", rr: 1.5, holdH });
  }
}

type Status = "SL" | "TP" | "PART" | "TRAIL" | "TIME";

interface Outcome {
  status: Status; exitTime: number; pnl: number; gross: number; costs: number;
  r: number; grossR: number; hours: number; tp1: boolean;
}

function simulate(x: Sym, sig: Sig, ex: ExitCfg, maker: boolean): Outcome | null {
  const i0 = sig.i;
  const dir = sig.dir;
  const entry = x.s.c[i0];
  const a = x.atr[i0];
  const risk = ex.stopAtr * a;
  if (!(entry > 0) || !(risk > 0)) return null;
  const stop0 = entry - dir * risk;
  const tp = entry + dir * ex.rr * risk;

  // Объём подбирается так, чтобы срабатывание стопа стоило ровно RISK_USD
  // вместе с комиссиями и проскальзыванием — как в money.ts, но со своими
  // ставками: вход бывает лимитный, стоп всегда по рынку.
  const feeIn = maker ? FEE_MAKER : FEE_TAKER;
  const slipIn = maker ? 0 : SLIP;
  const perUnit = risk + entry * (feeIn + slipIn) + stop0 * (FEE_TAKER + SLIP);
  if (!(perUnit > 0)) return null;
  const qty = RISK_USD / perUnit;
  const openedAt = x.s.t[i0] + STEP_MS;
  const holdMs = ex.holdH * 3_600_000;
  const trailAbs = 2 * a;

  let stop = stop0;
  let best = entry;
  let tp1 = false;
  let trailed = false;   // стоп уже подтягивался трейлингом
  let funding = 0;
  let fi = 0;
  while (fi < x.funding.t.length && x.funding.t[fi] < openedAt) fi++;

  const done = (status: Status, exitTime: number, exitPrice: number): Outcome => {
    // Цель — лимитка (мейкер, без проскальзывания), стоп и трейлинг — рынок.
    const byTarget = status === "TP";
    const feeOut = byTarget ? FEE_MAKER : FEE_TAKER;
    const slipOut = byTarget ? 0 : SLIP;
    const wTp = tp1 ? 0.5 : 0;               // доля, вышедшая по частичной цели
    const wRest = 1 - wTp;
    const gross = qty * dir * (wTp * (tp - entry) + wRest * (exitPrice - entry));
    const costIn = qty * entry * (feeIn + slipIn);
    const costOut = qty * (wTp * tp * FEE_MAKER + wRest * exitPrice * (feeOut + slipOut));
    const costs = costIn + costOut + funding;
    const pnl = gross - costs;
    return {
      status, exitTime, pnl, gross, costs,
      r: pnl / RISK_USD, grossR: gross / RISK_USD,
      hours: (exitTime - openedAt) / 3_600_000, tp1,
    };
  };

  for (let i = i0 + 1; i < x.s.n; i++) {
    // консервативно: в одной свече сначала стоп, потом цель
    if (dir === 1 ? x.s.l[i] <= stop : x.s.h[i] >= stop) {
      return done(trailed ? "TRAIL" : tp1 ? "PART" : "SL", x.s.t[i], stop);
    }
    if (ex.mode === "R") {
      if (dir === 1 ? x.s.h[i] >= tp : x.s.l[i] <= tp) return done("TP", x.s.t[i], tp);
    } else if (ex.mode === "part" && !tp1) {
      if (dir === 1 ? x.s.h[i] >= tp : x.s.l[i] <= tp) { tp1 = true; best = dir === 1 ? x.s.h[i] : x.s.l[i]; }
    }
    // трейлинг: сразу (mode=trail) либо после частичной фиксации (mode=part)
    if (ex.mode === "trail" || (ex.mode === "part" && tp1)) {
      best = dir === 1 ? Math.max(best, x.s.h[i]) : Math.min(best, x.s.l[i]);
      const tr = best - dir * trailAbs;
      const next = dir === 1 ? Math.max(stop, tr) : Math.min(stop, tr);
      if (next !== stop) { stop = next; trailed = true; }
    }
    const end = x.s.t[i] + STEP_MS;
    while (fi < x.funding.t.length && x.funding.t[fi] < end) {
      funding += x.funding.rate[fi] * qty * (tp1 ? 0.5 : 1) * x.s.c[i] * dir;
      fi++;
    }
    if (end - openedAt >= holdMs) return done("TIME", end, x.s.c[i]);
  }
  // данные кончились — закрываем по последней цене, чтобы сделка не потерялась
  const last = x.s.n - 1;
  return done("TIME", x.s.t[last] + STEP_MS, x.s.c[last]);
}

// ─────────────────────────── портфель ───────────────────────────

interface Trade { t: number; out: Outcome; sym: number; dir: 1 | -1 }

function runPortfolio(
  syms: Sym[], sigs: Sig[], ex: ExitCfg, byDay: Map<number, Set<string>>,
  maker: boolean, regime: Map<number, number> | null,
): Trade[] {
  const trades: Trade[] = [];
  const openUntil: { sym: number; until: number }[] = [];
  const lastEntry = new Map<number, number>();

  for (const sig of sigs) {
    for (let k = openUntil.length - 1; k >= 0; k--) if (openUntil[k].until <= sig.t) openUntil.splice(k, 1);
    if (openUntil.length >= MAX_ACTIVE) continue;
    if (openUntil.some((o) => o.sym === sig.sym)) continue;
    const last = lastEntry.get(sig.sym);
    if (last !== undefined && sig.t - last < COOLDOWN_MS) continue;
    const uni = byDay.get(Math.floor(sig.t / 86_400_000) * 86_400_000);
    if (uni && !uni.has(syms[sig.sym].symbol)) continue;
    // фильтр режима BTC — тот же, что у боевого бота: торгуем только в его сторону
    if (regime && regime.get(sig.t) !== sig.dir) continue;

    const out = simulate(syms[sig.sym], sig, ex, maker);
    if (!out) continue;
    trades.push({ t: sig.t, out, sym: sig.sym, dir: sig.dir });
    openUntil.push({ sym: sig.sym, until: out.exitTime });
    lastEntry.set(sig.sym, sig.t);
  }
  return trades;
}

// ─────────────────────────── статистика ───────────────────────────

interface Res {
  entry: EntryCfg; exit: ExitCfg; regime: boolean;
  n: number; net: number; avgR: number; grossR: number; costR: number;
  pf: number; win: number; maxDD: number;
  netTrain: number; netTest: number; nTrain: number; nTest: number;
  avgH: number; within24: number; perMonth: number;
}

function evaluate(entry: EntryCfg, exit: ExitCfg, regime: boolean, trades: Trade[]): Res {
  const n = trades.length;
  const sum = (a: Trade[]) => a.reduce((s, x) => s + x.out.pnl, 0);
  const g = trades.reduce((s, x) => s + Math.max(x.out.pnl, 0), 0);
  const l = trades.reduce((s, x) => s + Math.max(-x.out.pnl, 0), 0);
  let eq = 0, peak = 0, dd = 0;
  for (const x of trades) { eq += x.out.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const train = trades.filter((x) => x.t < HALF);
  const test = trades.filter((x) => x.t >= HALF);
  return {
    entry, exit, regime, n,
    net: sum(trades),
    avgR: n ? trades.reduce((s, x) => s + x.out.r, 0) / n : 0,
    grossR: n ? trades.reduce((s, x) => s + x.out.grossR, 0) / n : 0,
    costR: n ? trades.reduce((s, x) => s + x.out.costs, 0) / n / RISK_USD : 0,
    pf: l > 0 ? g / l : Infinity,
    win: n ? trades.filter((x) => x.out.pnl > 0).length / n * 100 : 0,
    maxDD: dd,
    netTrain: sum(train), netTest: sum(test), nTrain: train.length, nTest: test.length,
    avgH: n ? trades.reduce((s, x) => s + x.out.hours, 0) / n : 0,
    within24: n ? trades.filter((x) => x.out.hours <= 24).length / n * 100 : 0,
    perMonth: n / (DAYS / 30.44),
  };
}

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "∞");
const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(0)}`;
const pad = (s: string, n: number) => s.padEnd(n);

function table(title: string, rows: Res[]): void {
  console.log(`\n${title}`);
  console.log(pad("вход", 16) + pad("выход", 21) + pad("BTC", 5)
    + ["сделок", "итог $", "обуч.", "провер.", "R до", "R после", "изд.R", "PF", "win%", "ч", "<24ч%"]
      .map((h) => h.padStart(8)).join(""));
  for (const r of rows) {
    console.log(pad(r.entry.key, 16) + pad(r.exit.key, 21) + pad(r.regime ? "да" : "—", 5) + [
      String(r.n), money(r.net), money(r.netTrain), money(r.netTest),
      f(r.grossR, 3), f(r.avgR, 3), f(r.costR, 3), f(r.pf), f(r.win, 1),
      f(r.avgH, 1), f(r.within24, 0),
    ].map((v) => v.padStart(8)).join(""));
  }
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  console.error(`Окно ${new Date(FROM).toISOString().slice(0, 10)} … ${new Date(NOW).toISOString().slice(0, 10)}`
    + ` | обучение до ${new Date(HALF).toISOString().slice(0, 10)}`
    + ` | вселенная топ-${TOP_N} | риск $${RISK_USD} | проскальзывание ${(SLIP * 10000).toFixed(1)} б.п.`);

  const poolSymbols = (await topSymbols(POOL_SIZE)).map((t) => t.symbol);
  const daily = new Map<string, Bar[]>();
  await pool(poolSymbols, 6, async (sym) => {
    try { daily.set(sym, await loadRange(sym, "1d", FROM - WARMUP_MS, NOW)); } catch { /* нет истории */ }
  });
  const { byDay, symbols } = universeByDay(daily, TOP_N);
  console.error(`Пул ${poolSymbols.length}, хоть раз в топ-${TOP_N}: ${symbols.size}. Гружу 15m/1h/4h/фандинг…`);

  let done = 0;
  const list = [...symbols];
  const syms = (await pool(list, 5, async (s) => {
    try {
      const x = await loadSym(s);
      if (++done % 10 === 0) console.error(`  ${done}/${list.length}`);
      return x;
    } catch (e) {
      console.error(`  ${s}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  })).filter((x): x is Sym => x !== null);
  // Ряды BTC: относительная сила считается против него, режим — им же задаётся
  const btc = syms.find((x) => x.symbol === "BTCUSDT");
  if (!btc) throw new Error("нет данных по BTCUSDT");
  btcIdx = new Map();
  for (let i = 0; i < btc.s.n; i++) btcIdx.set(btc.s.t[i], i);
  btcRet = new Map();
  for (const n of [12, 24, 48, 96]) {
    const r = new Float32Array(btc.s.n).fill(NaN);
    for (let i = n; i < btc.s.n; i++) r[i] = (btc.s.c[i] / btc.s.c[i - n] - 1) * 100;
    btcRet.set(n, r);
  }
  // Режим как в regime.ts: цена BTC против EMA20 на 1d и EMA20/50 на 4h.
  // Здесь приближаем тем же по смыслу условием на его собственных рядах 15m.
  const regime = new Map<number, number>();
  for (let i = 0; i < btc.s.n; i++) {
    const t4 = btc.trend4h[i], t1 = btc.trend1h[i];
    regime.set(btc.s.t[i], t4 > 0 && t1 > 0 ? 1 : t4 < 0 && t1 < 0 ? -1 : 0);
  }

  console.error(`Готово: ${syms.length} монет.`
    + ` Перебираю ${ENTRIES.length}×${EXITS.length}×2 комбинаций…`);

  const all: Res[] = [];
  for (const entry of ENTRIES) {
    const sigs: Sig[] = [];
    for (let si = 0; si < syms.length; si++) entry.scan(syms[si], si, sigs);
    sigs.sort((a, b) => a.t - b.t || b.score - a.score);
    for (const exit of EXITS) {
      for (const useRegime of [false, true]) {
        const trades = runPortfolio(syms, sigs, exit, byDay, entry.maker === true,
          useRegime ? regime : null);
        all.push(evaluate(entry, exit, useRegime, trades));
      }
    }
    console.error(`  ${entry.key}: сигналов ${sigs.length}`);
  }

  // Отбор: обе половины в плюсе и хватает сделок. Ранжируем по обучающей
  // половине — проверочная в ранжировании не участвует, иначе это подгонка.
  const robust = all
    .filter((r) => r.n >= MIN_TRADES && r.netTrain > 0 && r.netTest > 0)
    .sort((a, b) => b.netTrain - a.netTrain);

  table(`ТОП: устойчивые (обе половины в плюсе, ≥${MIN_TRADES} сделок) — ${robust.length} шт`,
    robust.slice(0, 20));
  table("Для сравнения: лучшие по всему периоду без фильтра устойчивости",
    [...all].filter((r) => r.n >= MIN_TRADES).sort((a, b) => b.net - a.net).slice(0, 10));

  // Главный диагностический вопрос: преимущества нет вовсе или его съедают
  // издержки? Смотрим лучшие по средней сделке ДО издержек.
  table("Лучшие по преимуществу ДО издержек (есть ли что защищать)",
    [...all].filter((r) => r.n >= MIN_TRADES).sort((a, b) => b.grossR - a.grossR).slice(0, 10));

  // Плато важнее пика: смотрим, как себя ведёт семейство целиком
  console.log("\nПо семействам (все комбинации с достаточным числом сделок):");
  console.log(pad("семейство", 26)
    + ["комбо", "прибыльных", "медиана $", "лучший $", "устойчивых"].map((h) => h.padStart(12)).join(""));
  const byFamily = new Map<string, Res[]>();
  for (const r of all.filter((x) => x.n >= MIN_TRADES)) {
    const k = r.entry.family;
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k)!.push(r);
  }
  for (const [fam, rows] of [...byFamily.entries()].sort((a, b) => {
    const m = (r: Res[]) => [...r].sort((x, y) => x.net - y.net)[Math.floor(r.length / 2)].net;
    return m(b[1]) - m(a[1]);
  })) {
    const sorted = [...rows].sort((a, b) => a.net - b.net);
    const med = sorted[Math.floor(sorted.length / 2)].net;
    console.log(pad(fam, 26) + [
      String(rows.length),
      `${rows.filter((r) => r.net > 0).length}`,
      money(med),
      money(sorted[sorted.length - 1].net),
      String(rows.filter((r) => r.netTrain > 0 && r.netTest > 0).length),
    ].map((v) => v.padStart(12)).join(""));
  }

  // Строгий интрадей: лимит удержания сутки, то есть сделка гарантированно
  // не переезжает в следующий день.
  const intraday = robust.filter((r) => r.exit.holdH <= 24);
  table(`ТОП строго внутри дня (лимит удержания ≤24ч) — ${intraday.length} шт`, intraday.slice(0, 10));

  // Разбор финалистов: по годам и по сторонам — чтобы отличить преимущество
  // от простой бычьей беты на росте альткоинов.
  const finalists = [...intraday.slice(0, 2), ...robust.slice(0, 3)];
  console.log("\n════════ РАЗБОР ФИНАЛИСТОВ ════════");
  for (const r of finalists) {
    const sigs: Sig[] = [];
    for (let si = 0; si < syms.length; si++) r.entry.scan(syms[si], si, sigs);
    sigs.sort((a, b) => a.t - b.t || b.score - a.score);
    const trades = runPortfolio(syms, sigs, r.exit, byDay, r.entry.maker === true,
      r.regime ? regime : null);

    console.log(`\n${r.entry.key} + ${r.exit.key}${r.regime ? " + фильтр BTC" : ""}`);
    console.log(`  вход: ${r.entry.note}`);
    console.log(`  выход: стоп ${r.exit.stopAtr}×ATR(15m), `
      + `${r.exit.mode === "R" ? `цель ${r.exit.rr}R лимиткой`
        : r.exit.mode === "trail" ? "трейлинг 2×ATR"
          : `половина на ${r.exit.rr}R + трейлинг 2×ATR`}`
      + `, принудительный выход через ${r.exit.holdH}ч`);
    console.log(`  ${r.n} сделок (${f(r.perMonth, 1)}/мес), итог ${money(r.net)}, `
      + `средняя ${f(r.avgR, 3)}R, PF ${f(r.pf)}, просадка $${f(r.maxDD, 0)}`);
    console.log(`  живёт ${f(r.avgH, 1)}ч в среднем, внутри суток закрывается ${f(r.within24, 0)}%`);

    const byYear = new Map<number, Trade[]>();
    for (const t of trades) {
      const y = new Date(t.t).getUTCFullYear();
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push(t);
    }
    const sum = (a: Trade[]) => a.reduce((s, x) => s + x.out.pnl, 0);
    console.log("  по годам: " + [...byYear.keys()].sort()
      .map((y) => `${y} ${money(sum(byYear.get(y)!))} (${byYear.get(y)!.length})`).join(", "));
    const longs = trades.filter((t) => t.dir === 1);
    const shorts = trades.filter((t) => t.dir === -1);
    console.log(`  лонги ${money(sum(longs))} (${longs.length}), `
      + `шорты ${money(sum(shorts))} (${shorts.length})`);
  }
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
