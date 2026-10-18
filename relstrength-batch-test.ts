// «Сила против BTC»: как убрать пачки сделок, которые всем скопом идут за битком.
//
// База — поведение прода: публикуется каждый сигнал скана, лимита позиций нет.
// Четыре правки и все их сочетания:
//   A  бета  — обгон считается сверх беты к BTC: coin − β·BTC, а не coin − BTC.
//            Высокобетовые альты при движении BTC перестают «обгонять» его сами собой.
//   B  ширина — если в одну сторону в скане сигналят ≥ BREADTH монет вселенной,
//            это движение рынка, а не монеты: в эту сторону скан пропускается.
//   C  лимит — не больше 1 новой сделки за скан и не больше 2 открытых в одну сторону.
//   D  хедж  — на каждую сделку встречная позиция BTC на β·номинал; живёт, пока живёт
//            сделка, и уполовинивается вместе с ней на TP1.
//
// ВНИМАНИЕ: правка A с тех пор встроена в боевой findRelStrength, поэтому на
// текущем коде строка «прод» уже считает обгон сверх беты, строка «C лимит» —
// это то, что работает в проде, а «A …» применяет бету второй раз. Таблица до
// внедрения — в README.
//
// Запуск: npx tsx --max-old-space-size=8192 relstrength-batch-test.ts
// ENV: DAYS=1460  POOL=80  SLIP=0.0005  BREADTH=3

import {
  DAYS, FROM, NOW, WARMUP_MS, TF_MS, loadRange, loadFunding, pool, universeByDay,
  type Bar, type Funding,
} from "./backtest-data";
import { topSymbols } from "./src/lib/bybit";
import { buildPlan, realizedPnl, RISK_USD, TAKER_FEE } from "./src/lib/money";
import { findRelStrength, M15_BARS, H1_BARS, MAX_HOLD_HOURS, RS_LOOKBACK }
  from "./src/lib/strategyRelStrength";
import { trackCandle, type TrackState } from "./src/lib/track";
import type { Candle, Direction } from "./src/lib/types";

const SCAN_MS = 15 * 60_000;
const COOLDOWN_MS = 4 * 3_600_000;
const SCAN_UNIVERSE = 20;
const HOLD_MS = MAX_HOLD_HOURS * 3_600_000;
const SLIP = Number(process.env.SLIP ?? 0.0005);
const POOL_SIZE = Number(process.env.POOL ?? 80);
const BREADTH = Number(process.env.BREADTH ?? 3);
const BETA_BARS = M15_BARS - 1; // бета по тем же 300 свечам 15m, что видит сканер

interface Sym {
  symbol: string; m15: Candle[]; h1: Candle[]; funding: Funding;
  m15Ptr: number; h1Ptr: number;
}

function withCloseTime(bars: Bar[], tf: string): Candle[] {
  const s = TF_MS[tf];
  return bars.map((b) => ({
    openTime: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.q, closeTime: b.t + s - 1,
  }));
}

async function loadSym(symbol: string): Promise<Sym | null> {
  const [m15, h1, funding] = await Promise.all([
    loadRange(symbol, "15m", FROM - 5 * 86_400_000, NOW),
    loadRange(symbol, "1h", FROM - 60 * 86_400_000, NOW),
    loadFunding(symbol),
  ]);
  if (m15.length < 5000 || h1.length < 300) return null;
  return { symbol, m15: withCloseTime(m15, "15m"), h1: withCloseTime(h1, "1h"), funding, m15Ptr: -1, h1Ptr: -1 };
}

// ─────────────────────────── бета ───────────────────────────

function beta(coin: Candle[], btc: Candle[]): number {
  const n = Math.min(coin.length, btc.length, BETA_BARS + 1);
  const a = coin.slice(-n), b = btc.slice(-n);
  const x: number[] = [], y: number[] = [];
  for (let i = 1; i < n; i++) {
    x.push(Math.log(b[i].close / b[i - 1].close));
    y.push(Math.log(a[i].close / a[i - 1].close));
  }
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  let cov = 0, vx = 0;
  for (let i = 0; i < x.length; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; }
  const v = vx > 0 ? cov / vx : 1;
  return Math.min(3, Math.max(0.3, v));
}

// BTC, чья доходность за окно сравнения — уже β·BTC (в лог-масштабе).
// findRelStrength берёт только две точки окна, так что этого достаточно.
function scaledBtc(btc: Candle[], b: number): Candle[] {
  const b0 = btc[btc.length - 1 - RS_LOOKBACK].close;
  return btc.map((c) => ({ ...c, close: b0 * (c.close / b0) ** b }));
}

// ─────────────────────────── сделка ───────────────────────────

interface Trade {
  symbol: string; direction: Direction; openedAt: number; exitTime: number; open: boolean;
  pnl: number; hedgePnl: number;
}

function btcCloseAt(btc: Sym, t: number): number {
  // последняя свеча 15m, закрытая к моменту t
  let lo = 0, hi = btc.m15.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (btc.m15[mid].closeTime <= t) lo = mid; else hi = mid - 1;
  }
  return btc.m15[lo].close;
}

function fundingCost(f: Funding, from: number, to: number, notional: number, dir: number): number {
  let s = 0;
  for (let i = 0; i < f.t.length; i++) if (f.t[i] >= from && f.t[i] < to) s += f.rate[i] * notional * dir;
  return s;
}

function runTrade(
  x: Sym, btc: Sym, startIdx: number,
  c: { direction: Direction; entry: number; stop: number; tp1: number; activateAt: number; trailAbs: number },
  openedAt: number, hedgeBeta: number | null,
): Trade | null {
  const plan = buildPlan(c.direction, c.entry, c.stop, c.tp1);
  if (!plan) return null;
  const dir = c.direction === "LONG" ? 1 : -1;
  const qty = plan.qty;
  const st: TrackState = { stop: c.stop, best: c.entry, tp1Done: false, trailOn: false, moved: false };
  let funding = 0, fi = 0, tp1At = 0;
  while (fi < x.funding.t.length && x.funding.t[fi] < openedAt) fi++;

  const done = (exitTime: number, exitPrice: number, open: boolean): Trade => {
    const net = realizedPnl(plan, c.direction, c.entry, c.tp1, exitPrice, st.tp1Done);
    const slip = SLIP * qty * (c.entry + (st.tp1Done ? 0.5 * exitPrice : exitPrice));
    const pnl = net - slip - funding;
    let hedgePnl = 0;
    if (hedgeBeta !== null) {
      // встречная позиция BTC: −dir, номинал β·qty·entry, вход/выход по рынку
      const H = hedgeBeta * qty * c.entry;
      const b0 = btcCloseAt(btc, openedAt);
      const cost = (n: number) => n * (TAKER_FEE + SLIP);
      if (st.tp1Done) {
        const bT = btcCloseAt(btc, tp1At), bE = btcCloseAt(btc, exitTime);
        hedgePnl = -dir * H * (0.5 * (bT / b0 - 1) + 0.5 * (bE / b0 - 1))
          - cost(H) - cost(0.5 * H * bT / b0) - cost(0.5 * H * bE / b0)
          - fundingCost(btc.funding, openedAt, tp1At, H, -dir)
          - fundingCost(btc.funding, tp1At, exitTime, 0.5 * H, -dir);
      } else {
        const bE = btcCloseAt(btc, exitTime);
        hedgePnl = -dir * H * (bE / b0 - 1) - cost(H) - cost(H * bE / b0)
          - fundingCost(btc.funding, openedAt, exitTime, H, -dir);
      }
    }
    return { symbol: x.symbol, direction: c.direction, openedAt, exitTime, open, pnl: pnl + hedgePnl, hedgePnl };
  };

  const levels = { ...c, tpFull: false };
  for (let i = startIdx; i < x.m15.length; i++) {
    const bar = x.m15[i];
    const was = st.tp1Done;
    const step = trackCandle(levels, st, bar);
    if (!was && st.tp1Done) tp1At = bar.closeTime + 1;
    if (step.stopped) return done(bar.closeTime + 1, st.stop, false);
    const end = bar.openTime + SCAN_MS;
    while (fi < x.funding.t.length && x.funding.t[fi] < end) {
      funding += x.funding.rate[fi] * qty * (st.tp1Done ? 0.5 : 1) * bar.close * dir;
      fi++;
    }
    if (end - openedAt >= HOLD_MS) return done(end, bar.close, false);
  }
  const last = x.m15[x.m15.length - 1];
  return done(last.closeTime + 1, last.close, true);
}

// ─────────────────────────── прогон ───────────────────────────

interface Variant { key: string; A: boolean; B: boolean; C: boolean; D: boolean; maxActive?: number }

type RsC = NonNullable<ReturnType<typeof findRelStrength>>;
interface Sig { x: Sym; idx: number; b: number; plain: RsC | null; adj: RsC | null }

// Сигналы не зависят от варианта (кроме того, считать ли обгон сверх беты),
// поэтому один проход по истории даёт их сразу для всех вариантов.
function collectSignals(syms: Sym[], btc: Sym, byDay: Map<number, Set<string>>): Map<number, Sig[]> {
  for (const x of syms) { x.m15Ptr = -1; x.h1Ptr = -1; }
  const out = new Map<number, Sig[]>();
  for (let t = FROM; t <= NOW; t += SCAN_MS) {
    for (const x of syms) {
      while (x.m15Ptr + 1 < x.m15.length && x.m15[x.m15Ptr + 1].closeTime <= t) x.m15Ptr++;
      while (x.h1Ptr + 1 < x.h1.length && x.h1[x.h1Ptr + 1].closeTime <= t) x.h1Ptr++;
    }
    const universe = byDay.get(Math.floor(t / 86_400_000) * 86_400_000);
    if (!universe) continue;
    const btcWindow = btc.m15.slice(Math.max(0, btc.m15Ptr + 1 - M15_BARS), btc.m15Ptr + 1);
    if (btcWindow.length < M15_BARS) continue;
    const row: Sig[] = [];
    for (const x of syms) {
      if (x.symbol === "BTCUSDT" || !universe.has(x.symbol)) continue;
      if (x.m15Ptr < M15_BARS || x.h1Ptr < H1_BARS) continue;
      const m15 = x.m15.slice(x.m15Ptr + 1 - M15_BARS, x.m15Ptr + 1);
      if (m15[m15.length - 1].openTime !== btcWindow[btcWindow.length - 1].openTime) continue;
      const h1 = x.h1.slice(x.h1Ptr + 1 - H1_BARS, x.h1Ptr + 1);
      const live = m15[m15.length - 1].close;
      const b = beta(m15, btcWindow);
      const plain = findRelStrength(x.symbol, m15, h1, btcWindow, live);
      const adj = findRelStrength(x.symbol, m15, h1, scaledBtc(btcWindow, b), live);
      if (plain || adj) row.push({ x, idx: x.m15Ptr + 1, b, plain, adj });
    }
    if (row.length) out.set(t, row);
  }
  return out;
}

function runVariant(signals: Map<number, Sig[]>, btc: Sym, v: Variant): Trade[] {
  const trades: Trade[] = [];
  const openUntil = new Map<string, { until: number; dir: Direction }>();
  const lastEntry = new Map<string, number>();

  for (const [t, row] of signals) {
    for (const [sym, o] of openUntil) if (o.until <= t) openUntil.delete(sym);
    // Ширина рынка считается и по монетам, в которые войти сейчас нельзя
    const all = row.map((s) => ({ s, c: v.A ? s.adj : s.plain }))
      .filter((k): k is { s: Sig; c: RsC } => k.c !== null);
    if (!all.length) continue;
    let cands = all.filter(({ s }) => {
      const last = lastEntry.get(s.x.symbol);
      return !openUntil.has(s.x.symbol) && !(last !== undefined && t - last < COOLDOWN_MS);
    });
    if (v.B) {
      const longs = all.filter((k) => k.c.direction === "LONG").length;
      const shorts = all.length - longs;
      cands = cands.filter((k) => (k.c.direction === "LONG" ? longs : shorts) < BREADTH);
    }
    cands.sort((a, b) => b.c.score - a.c.score);

    let opened = 0;
    for (const { s, c } of cands) {
      if (v.maxActive !== undefined && openUntil.size >= v.maxActive) break;
      if (v.C) {
        if (opened >= 1) break;
        const same = [...openUntil.values()].filter((o) => o.dir === c.direction).length;
        if (same >= 2) continue;
      }
      const tr = runTrade(s.x, btc, s.idx, c, t, v.D ? s.b : null);
      if (!tr) continue;
      trades.push(tr);
      opened++;
      openUntil.set(s.x.symbol, { until: tr.exitTime, dir: c.direction });
      lastEntry.set(s.x.symbol, t);
    }
  }
  return trades;
}

// ─────────────────────────── отчёт ───────────────────────────

interface Row {
  key: string; n: number; perMonth: number; total: number; pf: number; dd: number; ratio: number;
  h1: number; h2: number; worstDay: number; bestDay: number; worstBatch: number; bestBatch: number;
  maxSame: number; batchShare: number; hedge: number;
}

function summarize(key: string, trades: Trade[]): Row {
  const closed = trades.filter((x) => !x.open).sort((a, b) => a.exitTime - b.exitTime);
  const sum = (a: Trade[]) => a.reduce((s, x) => s + x.pnl, 0);
  const gross = closed.reduce((s, x) => s + Math.max(x.pnl, 0), 0);
  const loss = closed.reduce((s, x) => s + Math.max(-x.pnl, 0), 0);
  let eq = 0, peak = 0, dd = 0;
  for (const x of closed) { eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }

  // Итог по дням закрытия: насколько крупно бьёт один день
  const byDay = new Map<number, number>();
  for (const x of closed) {
    const d = Math.floor(x.exitTime / 86_400_000);
    byDay.set(d, (byDay.get(d) ?? 0) + x.pnl);
  }
  // Пачка — сделки, открытые в одном скане
  const byScan = new Map<number, Trade[]>();
  for (const x of closed) {
    if (!byScan.has(x.openedAt)) byScan.set(x.openedAt, []);
    byScan.get(x.openedAt)!.push(x);
  }
  const batches = [...byScan.values()].map(sum);
  const inBatch = [...byScan.values()].filter((g) => g.length >= 3).reduce((s, g) => s + g.length, 0);

  // Пик одновременно открытых в одну сторону
  const ev: { t: number; d: number; dir: Direction }[] = [];
  for (const x of trades) {
    ev.push({ t: x.openedAt, d: 1, dir: x.direction }, { t: x.exitTime, d: -1, dir: x.direction });
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d);
  let L = 0, S = 0, maxSame = 0;
  for (const e of ev) {
    if (e.dir === "LONG") L += e.d; else S += e.d;
    maxSame = Math.max(maxSame, L, S);
  }

  const half = FROM + (NOW - FROM) / 2;
  const total = sum(closed);
  return {
    key, n: closed.length, perMonth: closed.length / (DAYS / 30.44), total, pf: gross / loss, dd,
    ratio: total / dd,
    h1: sum(closed.filter((x) => x.openedAt < half)), h2: sum(closed.filter((x) => x.openedAt >= half)),
    worstDay: Math.min(...byDay.values()), bestDay: Math.max(...byDay.values()),
    worstBatch: Math.min(...batches), bestBatch: Math.max(...batches),
    maxSame, batchShare: closed.length ? inBatch / closed.length : 0,
    hedge: closed.reduce((s, x) => s + x.hedgePnl, 0),
  };
}

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "∞");
const money = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`;

function printTable(rows: Row[]): void {
  const cols: [string, (r: Row) => string, number][] = [
    ["вариант", (r) => r.key, 22],
    ["сделок", (r) => String(r.n), 7],
    ["/мес", (r) => f(r.perMonth, 0), 5],
    ["итог$", (r) => money(r.total), 7],
    ["PF", (r) => f(r.pf), 5],
    ["DD$", (r) => f(r.dd, 0), 6],
    ["итог/DD", (r) => f(r.ratio), 8],
    ["1пол$", (r) => money(r.h1), 7],
    ["2пол$", (r) => money(r.h2), 7],
    ["худш.день", (r) => money(r.worstDay), 10],
    ["лучш.день", (r) => money(r.bestDay), 10],
    ["худш.пачка", (r) => money(r.worstBatch), 11],
    ["лучш.пачка", (r) => money(r.bestBatch), 11],
    ["макс.в1стор", (r) => String(r.maxSame), 12],
    ["в пачках≥3", (r) => `${f(r.batchShare * 100, 0)}%`, 11],
    ["хедж$", (r) => money(r.hedge), 7],
  ];
  console.log(cols.map(([h, , w]) => h.padStart(w)).join(" "));
  for (const r of rows) console.log(cols.map(([, g, w]) => g(r).padStart(w)).join(" "));
}

async function main() {
  console.error(`Окно ${new Date(FROM).toISOString().slice(0, 10)} … ${new Date(NOW).toISOString().slice(0, 10)}`
    + ` | риск $${RISK_USD} на сделку | проскальзывание ${(SLIP * 10000).toFixed(1)} б.п. | ширина ≥${BREADTH}`);
  const poolSymbols = (await topSymbols(POOL_SIZE)).map((t) => t.symbol);
  const daily = new Map<string, Bar[]>();
  await pool(poolSymbols, 6, async (s) => {
    try { daily.set(s, await loadRange(s, "1d", FROM - WARMUP_MS, NOW)); } catch { /* нет истории */ }
  });
  const { byDay, symbols } = universeByDay(daily, SCAN_UNIVERSE);
  symbols.add("BTCUSDT");
  console.error(`Пул ${poolSymbols.length}, хоть раз в топ-${SCAN_UNIVERSE}: ${symbols.size}. Гружу свечи…`);
  let n = 0;
  const list = [...symbols];
  const syms = (await pool(list, 5, async (s) => {
    try {
      const x = await loadSym(s);
      if (++n % 10 === 0) console.error(`  ${n}/${list.length}`);
      return x;
    } catch (e) {
      console.error(`  ${s}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  })).filter((x): x is Sym => x !== null);
  const btc = syms.find((x) => x.symbol === "BTCUSDT");
  if (!btc) throw new Error("нет данных по BTCUSDT");
  console.error(`Готово: ${syms.length} монет.`);

  const variants: Variant[] = [
    { key: "прод (без лимита)", A: false, B: false, C: false, D: false },
    { key: "справка: макс 3 позиции", A: false, B: false, C: false, D: false, maxActive: 3 },
  ];
  for (let m = 1; m < 16; m++) {
    const A = !!(m & 1), B = !!(m & 2), C = !!(m & 4), D = !!(m & 8);
    const key = [A && "A бета", B && "B ширина", C && "C лимит", D && "D хедж"].filter(Boolean).join(" + ");
    variants.push({ key, A, B, C, D });
  }
  // по числу правок: сначала одиночные, потом пары и т.д.
  variants.sort((a, b) => (a.maxActive !== undefined || (!a.A && !a.B && !a.C && !a.D) ? -1 : 0)
    - (b.maxActive !== undefined || (!b.A && !b.B && !b.C && !b.D) ? -1 : 0)
    || [a.A, a.B, a.C, a.D].filter(Boolean).length - [b.A, b.B, b.C, b.D].filter(Boolean).length);

  const t1 = Date.now();
  const signals = collectSignals(syms, btc, byDay);
  console.error(`Сигналы собраны за ${((Date.now() - t1) / 1000).toFixed(0)}с, сканов с сигналом: ${signals.size}`);
  const rows: Row[] = [];
  for (const v of variants) {
    const t0 = Date.now();
    rows.push(summarize(v.key, runVariant(signals, btc, v)));
    console.error(`  ${v.key}: ${((Date.now() - t0) / 1000).toFixed(0)}с`);
  }
  console.log();
  printTable(rows);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
