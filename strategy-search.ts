// Перебор стратегий на исторических данных Binance.
// Запуск: npx tsx strategy-search.ts
import { runBacktest } from "./src/lib/backtest";
import { fetchKlinesRange } from "./src/lib/binance";
import type { Candle, Direction, Rule, TF, TraderConfig } from "./src/lib/types";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const EVAL_DAYS = 90;
const FEE_PCT = 0.12; // комиссия+проскальзывание за круг, % от цены (без плеча)
const NOW = Date.now();

// сколько дней истории грузить на каждый ТФ (запас под прогрев EMA200 и т.п.)
const LOAD_DAYS: Partial<Record<TF, number>> = {
  "5m": 100, "15m": 100, "1h": 120, "4h": 190, "1d": 400,
};

type Loaded = Map<string, Map<TF, Candle[]>>;

async function loadAll(): Promise<Loaded> {
  const out: Loaded = new Map();
  for (const sym of SYMBOLS) {
    const bySym = new Map<TF, Candle[]>();
    for (const [tf, days] of Object.entries(LOAD_DAYS) as [TF, number][]) {
      const candles = await fetchKlinesRange(sym, tf, NOW - days * 86_400_000, NOW);
      while (candles.length && candles[candles.length - 1].closeTime > NOW) candles.pop();
      bySym.set(tf, candles);
      console.error(`  ${sym} ${tf}: ${candles.length} свечей`);
    }
    out.set(sym, bySym);
  }
  return out;
}

interface EvalResult {
  label: string;
  config: TraderConfig;
  trades90: number;
  net90: number;   // сумма (профит − комиссия) за 90д, % без плеча
  netH1: number;   // первая половина периода
  netH2: number;   // вторая половина
  net30: number;   // последние 30 дней
  winRate: number;
  maxDD: number;   // макс. просадка по кумулятивной кривой, %
}

async function evalConfig(label: string, c: TraderConfig, preloaded: Map<TF, Candle[]>): Promise<EvalResult | null> {
  const r = await runBacktest(c, EVAL_DAYS, preloaded);
  const closed = r.trades.filter((t) => t.result !== "OPEN" && t.profitPct !== null);
  if (!closed.length) return null;
  const half = NOW - (EVAL_DAYS / 2) * 86_400_000;
  const d30 = NOW - 30 * 86_400_000;
  const net = (t: (typeof closed)[0]) => (t.profitPct ?? 0) - FEE_PCT;
  const sum = (arr: typeof closed) => Math.round(arr.reduce((s, t) => s + net(t), 0) * 100) / 100;
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of closed) {
    equity += net(t);
    peak = Math.max(peak, equity);
    maxDD = Math.max(maxDD, peak - equity);
  }
  return {
    label, config: c,
    trades90: closed.length,
    net90: sum(closed),
    netH1: sum(closed.filter((t) => t.entryTime < half)),
    netH2: sum(closed.filter((t) => t.entryTime >= half)),
    net30: sum(closed.filter((t) => t.entryTime >= d30)),
    winRate: r.stats.winRate,
    maxDD: Math.round(maxDD * 100) / 100,
  };
}

function intradayGrid(sym: string): { label: string; config: TraderConfig }[] {
  const out: { label: string; config: TraderConfig }[] = [];
  for (const dir of ["LONG", "SHORT"] as Direction[]) {
    for (const rsiTf of ["5m", "15m"] as TF[]) {
      for (const rsiVal of dir === "LONG" ? [25, 30, 35] : [65, 70, 75]) {
        for (const trendTf of ["1h", "4h"] as TF[]) {
          for (const slPct of [0.7, 1.0, 1.5]) {
            for (const tpPct of [1.0, 1.5, 2.0]) {
              const rules: Rule[] = [
                { type: "rsi", tf: rsiTf, period: 14, op: dir === "LONG" ? "lte" : "gte", value: rsiVal },
                { type: "ema", tf: trendTf, period: 200, condition: dir === "LONG" ? "price_above" : "price_below" },
              ];
              out.push({
                label: `ID ${sym} ${dir} rsi(${rsiVal})@${rsiTf} ema200@${trendTf} sl${slPct} tp${tpPct}`,
                config: {
                  symbol: sym, direction: dir, leverage: 1, timeframe: rsiTf, rules,
                  stopLoss: { type: "percent", value: slPct },
                  takeProfit: { type: "percent", value: tpPct },
                  maxHoldHours: 24,
                },
              });
            }
          }
        }
      }
    }
  }
  return out;
}

function swingGrid(sym: string): { label: string; config: TraderConfig }[] {
  const out: { label: string; config: TraderConfig }[] = [];
  for (const dir of ["LONG", "SHORT"] as Direction[]) {
    const trend: Rule = { type: "ema", tf: "1d", period: 200, condition: dir === "LONG" ? "price_above" : "price_below" };
    const entries: { name: string; rule: Rule }[] = [];
    for (const n of [2, 3, 4]) entries.push({ name: `macd${n}@4h`, rule: { type: "macd", tf: "4h", candles: n } });
    for (const v of dir === "LONG" ? [35, 40] : [60, 65]) {
      entries.push({ name: `rsi(${v})@4h`, rule: { type: "rsi", tf: "4h", period: 14, op: dir === "LONG" ? "lte" : "gte", value: v } });
    }
    for (const e of entries) {
      for (const slPct of [2, 3]) {
        for (const tpPct of [5, 8]) {
          out.push({
            label: `SW ${sym} ${dir} ${e.name} ema200@1d sl${slPct} tp${tpPct}`,
            config: {
              symbol: sym, direction: dir, leverage: 1, timeframe: "4h",
              rules: [e.rule, trend],
              stopLoss: { type: "percent", value: slPct },
              takeProfit: { type: "percent", value: tpPct },
              maxHoldHours: 168,
            },
          });
        }
      }
    }
  }
  return out;
}

function fmt(r: EvalResult): string {
  return `${r.label} | trades=${r.trades90} wr=${r.winRate}% net90=${r.net90}% h1=${r.netH1}% h2=${r.netH2}% n30=${r.net30}% dd=${r.maxDD}%`;
}

async function main() {
  console.error("Загружаю свечи…");
  const loaded = await loadAll();

  const intraday: EvalResult[] = [];
  const swing: EvalResult[] = [];

  for (const sym of SYMBOLS) {
    const pre = loaded.get(sym)!;
    for (const { label, config } of intradayGrid(sym)) {
      const r = await evalConfig(label, config, pre);
      if (r) intraday.push(r);
    }
    for (const { label, config } of swingGrid(sym)) {
      const r = await evalConfig(label, config, pre);
      if (r) swing.push(r);
    }
    console.error(`${sym}: посчитан`);
  }

  // Отбор: обе половины в плюсе, достаточно сделок, ранжируем по худшей половине
  const robust = (arr: EvalResult[], minTrades: number) => arr
    .filter((r) => r.trades90 >= minTrades && r.netH1 > 0 && r.netH2 > 0 && r.net30 > -0.5)
    .sort((a, b) => Math.min(b.netH1, b.netH2) - Math.min(a.netH1, a.netH2));

  console.log("\n=== ИНТРАДЕЙ: устойчивые (обе половины в плюсе) ===");
  robust(intraday, 25).slice(0, 15).forEach((r) => console.log(fmt(r)));
  console.log("\n=== ИНТРАДЕЙ: топ по net90 (для сравнения) ===");
  [...intraday].sort((a, b) => b.net90 - a.net90).slice(0, 5).forEach((r) => console.log(fmt(r)));

  console.log("\n=== СРЕДНЕСРОК: устойчивые ===");
  robust(swing, 6).slice(0, 15).forEach((r) => console.log(fmt(r)));
  console.log("\n=== СРЕДНЕСРОК: топ по net90 ===");
  [...swing].sort((a, b) => b.net90 - a.net90).slice(0, 5).forEach((r) => console.log(fmt(r)));
}

main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
