// Бэктест бота «Сила против BTC» на боевом коде.
//
// Здесь нет своей копии стратегии: вход ищет тот же findRelStrength, позицию
// ведёт тот же trackCandle, объём и деньги считает тот же money.ts, что и бот
// в проде. Скрипт добавляет только то, чего в боте нет по определению —
// историю, портфельные ограничения и издержки исполнения.
//
// Запуск: npx tsx --max-old-space-size=8192 relstrength-backtest.ts
// ENV: DAYS=1460  POOL=80  SLIP=0.0005  STEP=15m|1h (шаг сопровождения)

import {
  DAYS, FROM, NOW, WARMUP_MS, TF_MS, loadRange, loadFunding, pool, universeByDay,
  type Bar, type Funding,
} from "./backtest-data";
import { topSymbols } from "./src/lib/bybit";
import { buildPlan, realizedPnl, RISK_USD } from "./src/lib/money";
import { findRelStrength, M15_BARS, H1_BARS, MAX_HOLD_HOURS, RS_LOOKBACK, TP1_R }
  from "./src/lib/strategyRelStrength";
import { trackCandle, type TrackState } from "./src/lib/track";
import type { Candle, Direction } from "./src/lib/types";

const SCAN_MS = 15 * 60_000;          // RELSTRENGTH_DEFAULTS.scanMinutes
const MAX_ACTIVE = 3;                 // RELSTRENGTH_DEFAULTS.maxActive
const COOLDOWN_MS = 4 * 3_600_000;    // SYMBOL_COOLDOWN_MS в botRelStrength
const SCAN_UNIVERSE = 20;
const HOLD_MS = MAX_HOLD_HOURS * 3_600_000;
const SLIP = Number(process.env.SLIP ?? 0.0005);
const POOL_SIZE = Number(process.env.POOL ?? 80);
const STEP_TF = (process.env.STEP ?? "15m") as "15m" | "1h";
const STEP_MS = TF_MS[STEP_TF];

// Варианты для диагностики расхождения с поисковым прогоном: границы
// применимости и глубина прогрева EMA200 на часовом ряде.
interface Variant { key: string; maxEdgePp: number; maxStopPct: number; h1: number }
const VARIANTS: Variant[] = [
  // то, что лежит в main после исправления
  { key: "как сейчас в коде (стоп 25%, обгон 60 п.п.)", maxEdgePp: 60, maxStopPct: 25, h1: H1_BARS },
  // соседние значения порога — проверка, что рядом не обрыв
  { key: "порог стопа 22%", maxEdgePp: 60, maxStopPct: 22, h1: H1_BARS },
  { key: "порог стопа 30%", maxEdgePp: 60, maxStopPct: 30, h1: H1_BARS },
];

// ─────────────────────────── данные ───────────────────────────

interface Sym {
  symbol: string;
  m15: Candle[];    // сигнальный ряд — его же видит боевой сканер
  h1: Candle[];
  step: Candle[];   // ряд сопровождения
  funding: Funding;
  m15Ptr: number; h1Ptr: number; stepPtr: number;
}


function withCloseTime(bars: Bar[], tf: string): Candle[] {
  const s = TF_MS[tf];
  return bars.map((b) => ({
    openTime: b.t, open: b.o, high: b.h, low: b.l, close: b.c,
    volume: b.q, closeTime: b.t + s - 1,
  }));
}

async function loadSym(symbol: string): Promise<Sym | null> {
  const [m15, h1, step, funding] = await Promise.all([
    loadRange(symbol, "15m", FROM - 5 * 86_400_000, NOW),
    loadRange(symbol, "1h", FROM - 60 * 86_400_000, NOW),
    STEP_TF === "15m"
      ? Promise.resolve<Bar[] | null>(null)
      : loadRange(symbol, STEP_TF, FROM - 5 * 86_400_000, NOW),
    loadFunding(symbol),
  ]);
  if (m15.length < 5000 || h1.length < 300) return null;
  const m15c = withCloseTime(m15, "15m");
  return {
    symbol, m15: m15c, h1: withCloseTime(h1, "1h"),
    step: step ? withCloseTime(step, STEP_TF) : m15c,
    funding, m15Ptr: -1, h1Ptr: -1, stepPtr: -1,
  };
}

// ─────────────────────────── сделка ───────────────────────────

type Status = "SL" | "PART" | "TRAIL" | "TIME" | "OPEN";

interface Trade {
  symbol: string; direction: Direction; openedAt: number; exitTime: number;
  status: Status; entry: number; exit: number; tp1Done: boolean;
  pnl: number; r: number; hours: number; leverage: number; stopPct: number;
}

/** Ведёт позицию боевым trackCandle до стопа, лимита удержания или конца данных. */
function runTrade(
  x: Sym, startIdx: number,
  c: { direction: Direction; entry: number; stop: number; tp1: number; activateAt: number; trailAbs: number },
  openedAt: number,
): Trade | null {
  const plan = buildPlan(c.direction, c.entry, c.stop, c.tp1);
  if (!plan) return null;
  const dir = c.direction === "LONG" ? 1 : -1;
  const qty = plan.qty;

  const st: TrackState = {
    stop: c.stop, best: c.entry, tp1Done: false, trailOn: false, moved: false,
  };
  let funding = 0;
  let fi = 0;
  while (fi < x.funding.t.length && x.funding.t[fi] < openedAt) fi++;

  const done = (status: Status, exitTime: number, exitPrice: number): Trade => {
    // Вход и стоп — по рынку (тейкер + проскальзывание), TP1 — лимиткой.
    // realizedPnl уже вычел тейкерские комиссии обеих сторон.
    const net = realizedPnl(plan, c.direction, c.entry, c.tp1, exitPrice, st.tp1Done);
    const slip = SLIP * qty * (c.entry + (st.tp1Done ? 0.5 * exitPrice : exitPrice));
    const pnl = net - slip - funding;
    return {
      symbol: x.symbol, direction: c.direction, openedAt, exitTime, status,
      entry: c.entry, exit: exitPrice, tp1Done: st.tp1Done,
      pnl, r: pnl / RISK_USD, hours: (exitTime - openedAt) / 3_600_000,
      leverage: plan.leverage, stopPct: plan.stopPct,
    };
  };

  for (let i = startIdx; i < x.step.length; i++) {
    const bar = x.step[i];
    const step = trackCandle(c, st, bar);
    if (step.stopped) {
      return done(st.trailOn ? "TRAIL" : st.tp1Done ? "PART" : "SL", bar.openTime, st.stop);
    }
    const end = bar.openTime + STEP_MS;
    while (fi < x.funding.t.length && x.funding.t[fi] < end) {
      funding += x.funding.rate[fi] * qty * (st.tp1Done ? 0.5 : 1) * bar.close * dir;
      fi++;
    }
    if (end - openedAt >= HOLD_MS) return done("TIME", end, bar.close);
  }
  const last = x.step[x.step.length - 1];
  return done("OPEN", last.openTime + STEP_MS, last.close);
}

// ─────────────────────────── прогон ───────────────────────────

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "∞");
const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(1)}`;
const pad = (s: string, n: number) => s.padEnd(n);

async function main() {
  console.error(`Окно ${new Date(FROM).toISOString().slice(0, 10)} … ${new Date(NOW).toISOString().slice(0, 10)}`
    + ` | шаг сопровождения ${STEP_TF} | риск $${RISK_USD} | проскальзывание ${(SLIP * 10000).toFixed(1)} б.п.`);

  // topSymbols уже отсекает акции, металлы и innovation-зону — как в бою
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
  console.error(`Готово: ${syms.length} монет. Гоняю боевой findRelStrength по каждому скану…`);

  for (const v of VARIANTS) {
    const { trades, full, scans, dropped } = runVariant(syms, btc, byDay, v);
    report(v.key, trades, full, scans, dropped);
  }
}

interface RunOut { trades: Trade[]; full: number; scans: number; dropped: number }

function runVariant(
  syms: Sym[], btc: Sym, byDay: Map<number, Set<string>>, v: Variant,
): RunOut {
  for (const x of syms) { x.m15Ptr = -1; x.h1Ptr = -1; x.stepPtr = -1; }
  const limits = { maxEdgePp: v.maxEdgePp, maxStopPct: v.maxStopPct };
  const trades: Trade[] = [];
  const openUntil = new Map<string, number>();
  const lastEntry = new Map<string, number>();
  let scans = 0, full = 0, dropped = 0;

  for (let t = FROM; t <= NOW; t += SCAN_MS) {
    for (const [sym, until] of openUntil) if (until <= t) openUntil.delete(sym);

    // курсоры на последние закрытые свечи — то, что в бою отдаёт closedKlines
    for (const x of syms) {
      while (x.m15Ptr + 1 < x.m15.length && x.m15[x.m15Ptr + 1].closeTime <= t) x.m15Ptr++;
      while (x.h1Ptr + 1 < x.h1.length && x.h1[x.h1Ptr + 1].closeTime <= t) x.h1Ptr++;
      while (x.stepPtr + 1 < x.step.length && x.step[x.stepPtr + 1].openTime < t) x.stepPtr++;
    }
    const slots = MAX_ACTIVE - openUntil.size;
    if (slots <= 0) { full++; continue; }
    scans++;

    const universe = byDay.get(Math.floor(t / 86_400_000) * 86_400_000);
    if (!universe) continue;
    const btcWindow = btc.m15.slice(Math.max(0, btc.m15Ptr + 1 - M15_BARS), btc.m15Ptr + 1);
    if (btcWindow.length < RS_LOOKBACK + 1) continue;

    const cands: { c: NonNullable<ReturnType<typeof findRelStrength>>; x: Sym; idx: number }[] = [];
    for (const x of syms) {
      if (!universe.has(x.symbol)) continue;
      if (openUntil.has(x.symbol)) continue;
      const last = lastEntry.get(x.symbol);
      if (last !== undefined && t - last < COOLDOWN_MS) continue;
      if (x.m15Ptr < M15_BARS || x.h1Ptr < v.h1) continue;

      // Ровно те же аргументы, что собирает боевой сканер
      const m15 = x.m15.slice(x.m15Ptr + 1 - M15_BARS, x.m15Ptr + 1);
      const h1 = x.h1.slice(x.h1Ptr + 1 - v.h1, x.h1Ptr + 1);
      const live = m15[m15.length - 1].close;
      const c = findRelStrength(x.symbol, m15, h1, btcWindow, live, limits);
      if (c) cands.push({ c, x, idx: x.stepPtr + 1 });
    }
    if (!cands.length) continue;
    dropped += Math.max(0, cands.length - slots);

    cands.sort((a, b) => b.c.score - a.c.score);
    for (const { c, x, idx } of cands.slice(0, slots)) {
      if (idx >= x.step.length) continue;
      const tr = runTrade(x, idx, c, t);
      if (!tr) continue;
      trades.push(tr);
      openUntil.set(x.symbol, tr.exitTime);
      lastEntry.set(x.symbol, t);
    }
  }
  return { trades, full, scans, dropped };
}

// ─────────────────────────── отчёт ───────────────────────────

function report(title: string, trades: Trade[], full: number, scans: number, dropped: number): void {
  const closed = trades.filter((x) => x.status !== "OPEN").sort((a, b) => a.exitTime - b.exitTime);
  if (!closed.length) { console.log(`\n${title}: сделок нет`); return; }
  const open = trades.length - closed.length;
  const sum = (a: Trade[]) => a.reduce((s, x) => s + x.pnl, 0);
  const gross = closed.reduce((s, x) => s + Math.max(x.pnl, 0), 0);
  const loss = closed.reduce((s, x) => s + Math.max(-x.pnl, 0), 0);
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  for (const x of closed) {
    eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
    streak = x.pnl > 0 ? 0 : streak + 1; worst = Math.max(worst, streak);
  }
  const months = DAYS / 30.44;
  const cnt = (s: Status) => trades.filter((x) => x.status === s).length;
  const total = sum(closed);

  console.log(`\n════════ ${title} ════════`);
  console.log(`Сделок: ${closed.length} закрытых${open ? ` + ${open} в позиции` : ""}`
    + ` (${f(closed.length / months, 1)} в месяц), средняя живёт ${f(closed.reduce((s, x) => s + x.hours, 0) / closed.length, 1)}ч`);
  console.log(`Итог: ${money(total)}  |  профит-фактор ${f(gross / loss)}`
    + `  |  в плюс ${f(closed.filter((x) => x.pnl > 0).length / closed.length * 100, 1)}%`);
  console.log(`Средняя сделка: ${f(closed.reduce((s, x) => s + x.r, 0) / closed.length, 3)}R`
    + `  |  макс. просадка $${f(dd, 1)}  |  итог/просадка ${f(total / dd)}`);
  console.log(`Худшая серия убытков подряд: ${worst}`
    + `  |  внутри суток закрывается ${f(closed.filter((x) => x.hours <= 24).length / closed.length * 100, 0)}%`);
  console.log(`Исходы: SL ${cnt("SL")} · PART ${cnt("PART")} · TRAIL ${cnt("TRAIL")} · TIME ${cnt("TIME")}`
    + `  |  до TP1 дошли ${trades.filter((x) => x.tp1Done).length}`);
  console.log(`Плечо: медиана ×${[...closed].map((x) => x.leverage).sort((a, b) => a - b)[Math.floor(closed.length / 2)]}`
    + `, стоп ${f([...closed].map((x) => x.stopPct).sort((a, b) => a - b)[Math.floor(closed.length / 2)], 2)}% от цены (медиана)`);
  console.log(`Слоты: заняты полностью на ${f(full / (full + scans) * 100, 1)}% сканов, `
    + `отброшено сигналов из-за нехватки мест: ${dropped}`);

  const byYear = new Map<number, Trade[]>();
  for (const x of closed) {
    const y = new Date(x.exitTime).getUTCFullYear();
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(x);
  }
  console.log("\nПо годам (по дате закрытия):");
  console.log(pad("  год", 10) + ["сделок", "итог $", "win%"].map((h) => h.padStart(10)).join(""));
  for (const y of [...byYear.keys()].sort()) {
    const r = byYear.get(y)!;
    console.log(pad(`  ${y}`, 10) + [String(r.length), money(sum(r)),
      f(r.filter((x) => x.pnl > 0).length / r.length * 100, 1)].map((v) => v.padStart(10)).join(""));
  }

  const half = FROM + (NOW - FROM) / 2;
  console.log(`\nПо половинам периода: ${money(sum(closed.filter((x) => x.openedAt < half)))}`
    + ` / ${money(sum(closed.filter((x) => x.openedAt >= half)))}`);
  const longs = closed.filter((x) => x.direction === "LONG");
  const shorts = closed.filter((x) => x.direction === "SHORT");
  console.log(`Лонги ${money(sum(longs))} (${longs.length}), шорты ${money(sum(shorts))} (${shorts.length})`);

  const bySym = new Map<string, Trade[]>();
  for (const x of closed) {
    if (!bySym.has(x.symbol)) bySym.set(x.symbol, []);
    bySym.get(x.symbol)!.push(x);
  }
  const rank = [...bySym.entries()].map(([s, r]) => ({ s, v: sum(r) })).sort((a, b) => b.v - a.v);
  console.log(`\nМонет в работе: ${rank.length}, прибыльных ${rank.filter((x) => x.v > 0).length}`);
  console.log(`  лучшие: ${rank.slice(0, 5).map((x) => `${x.s} ${money(x.v)}`).join(", ")}`);
  console.log(`  худшие: ${rank.slice(-5).reverse().map((x) => `${x.s} ${money(x.v)}`).join(", ")}`);
  console.log(`  без лучшей монеты (${rank[0].s}): ${money(total - rank[0].v)}`);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
