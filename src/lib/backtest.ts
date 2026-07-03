import { fetchKlinesRange } from "./binance";
import {
  calcTargets, checkPriceExit, exitWarmup, profitPct, requiredTfs,
  ruleTriggeredAt, rsiExitTriggered, smallestTf, warmupCandles,
} from "./engine";
import type {
  BacktestResult, BacktestTrade, Candle, TF, TraderConfig,
} from "./types";
import { TF_MS } from "./types";

// Бэктест: шагаем по закрытиям свечей самого мелкого ТФ из правил.
// Вход — по цене закрытия свечи, на которой сработали все правила.
// Процентные SL/TP проверяются по high/low каждой шаговой свечи
// (стоп приоритетнее тейка в одной свече), RSI-выходы — по закрытиям своего ТФ.
export async function runBacktest(
  c: TraderConfig, days: number,
  preloaded?: Map<TF, Candle[]>, // готовые свечи (для перебора стратегий без повторных загрузок)
): Promise<BacktestResult> {
  const stepTf = smallestTf(c);
  const tfs = new Set<TF>(requiredTfs(c));
  tfs.add(stepTf);

  const now = Date.now();
  const from = now - days * 86_400_000;

  const maxWarmup = Math.max(
    ...c.rules.map(warmupCandles),
    exitWarmup(c.stopLoss),
    exitWarmup(c.takeProfit),
    50,
  );

  const candlesByTf = new Map<TF, Candle[]>();
  for (const tf of tfs) {
    if (preloaded?.has(tf)) {
      candlesByTf.set(tf, preloaded.get(tf)!);
      continue;
    }
    const start = from - maxWarmup * TF_MS[tf];
    const candles = await fetchKlinesRange(c.symbol, tf, start, now);
    // выбрасываем последнюю (незакрытую) свечу
    if (candles.length && candles[candles.length - 1].closeTime > now) candles.pop();
    candlesByTf.set(tf, candles);
  }

  const step = candlesByTf.get(stepTf)!;
  if (step.length < 10) {
    throw new Error(`Недостаточно данных по ${c.symbol} (${stepTf})`);
  }

  // указатель "последняя закрытая свеча ТФ на момент t" для каждого ТФ
  const pointers = new Map<TF, number>();
  for (const tf of tfs) pointers.set(tf, -1);

  const lastClosedIdx = (tf: TF, t: number): number => {
    const arr = candlesByTf.get(tf)!;
    let p = pointers.get(tf)!;
    while (p + 1 < arr.length && arr[p + 1].closeTime <= t) p++;
    pointers.set(tf, p);
    return p;
  };

  const trades: BacktestTrade[] = [];
  let openTrade: BacktestTrade | null = null;
  let stopPrice: number | null = null;
  let takePrice: number | null = null;
  let candlesTested = 0;

  for (let i = 0; i < step.length; i++) {
    const candle = step[i];
    const t = candle.closeTime;
    if (candle.openTime < from) {
      lastClosedIdx(stepTf, t); // прогреваем указатели
      continue;
    }
    candlesTested++;

    if (openTrade) {
      // 0) лимит времени удержания — закрываем по рынку
      if (c.maxHoldHours && t - openTrade.entryTime >= c.maxHoldHours * 3_600_000) {
        openTrade.exitTime = t;
        openTrade.exitPrice = candle.close;
        openTrade.result = "TIME";
        openTrade.profitPct = profitPct(c.direction, openTrade.entryPrice, candle.close, c.leverage);
        openTrade = null;
        continue;
      }
      // 1) процентные уровни по экстремумам шаговой свечи
      const hit = checkPriceExit(c.direction, candle, stopPrice, takePrice);
      if (hit) {
        openTrade.exitTime = t;
        openTrade.exitPrice = hit.price;
        openTrade.result = hit.status;
        openTrade.profitPct = profitPct(c.direction, openTrade.entryPrice, hit.price, c.leverage);
        openTrade = null;
        continue;
      }
      // 2) RSI-выходы по закрытию соответствующего ТФ
      let closed = false;
      for (const [kind, exit] of [["sl", c.stopLoss], ["tp", c.takeProfit]] as const) {
        if (exit.type !== "rsi") continue;
        const idx = lastClosedIdx(exit.tf, t);
        if (idx < 0) continue;
        if (rsiExitTriggered(exit, kind, c.direction, candlesByTf.get(exit.tf)!, idx)) {
          openTrade.exitTime = t;
          openTrade.exitPrice = candle.close;
          openTrade.result = kind === "tp" ? "TP" : "SL";
          openTrade.profitPct = profitPct(c.direction, openTrade.entryPrice, candle.close, c.leverage);
          openTrade = null;
          closed = true;
          break;
        }
      }
      if (closed) continue;
    } else {
      // проверяем вход: все правила на своих последних закрытых свечах
      let all = c.rules.length > 0;
      for (const rule of c.rules) {
        const idx = lastClosedIdx(rule.tf, t);
        if (idx < warmupCandles(rule) ||
            !ruleTriggeredAt(rule, c.direction, candlesByTf.get(rule.tf)!, idx)) {
          all = false;
          break;
        }
      }
      if (all) {
        const entry = candle.close;
        const targets = calcTargets(c.direction, entry, c.stopLoss, c.takeProfit);
        stopPrice = targets.stopPrice;
        takePrice = targets.takePrice;
        openTrade = {
          entryTime: t, entryPrice: entry,
          exitTime: null, exitPrice: null, result: "OPEN", profitPct: null,
        };
        trades.push(openTrade);
      }
    }
  }

  const tp = trades.filter((x) => x.result === "TP").length;
  const sl = trades.filter((x) => x.result === "SL").length;
  const time = trades.filter((x) => x.result === "TIME").length;
  const open = trades.filter((x) => x.result === "OPEN").length;
  const closed = trades.filter((x) => x.result !== "OPEN");
  const wins = closed.filter((x) => (x.profitPct ?? 0) > 0).length;
  const total = trades.reduce((s, x) => s + (x.profitPct ?? 0), 0);

  return {
    days,
    candles: candlesTested,
    trades,
    stats: {
      total: trades.length, tp, sl, time, open,
      winRate: closed.length ? Math.round((wins / closed.length) * 1000) / 10 : 0,
      profitPct: Math.round(total * 100) / 100,
    },
  };
}
