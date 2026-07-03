import { fetchKlines, lastPrice } from "./binance";
import {
  closeSignal, getSignal, insertSignal, listTraders, openSignals,
  openSignalTraderIds, setTraderLastEntryCandle, touchSignal,
} from "./db";
import {
  allRulesTriggered, calcTargets, checkPriceExit, profitPct,
  requiredTfs, rsiExitTriggered, warmupCandles,
} from "./engine";
import { broadcastSignalClose, broadcastSignalOpen } from "./telegram";
import type { Candle, Signal, TF } from "./types";
import { TF_MS } from "./types";

export interface TickReport {
  checkedSignals: number;
  closed: { id: string; status: string; profitPct: number }[];
  opened: { id: string; symbol: string; direction: string }[];
  errors: string[];
}

// Кэш свечей в рамках одного тика: symbol:tf -> закрытые свечи
async function getClosedCandles(
  cache: Map<string, Candle[]>, symbol: string, tf: TF, limit: number,
): Promise<Candle[]> {
  const key = `${symbol}:${tf}`;
  const cached = cache.get(key);
  if (cached && cached.length >= Math.min(limit, 990)) return cached;
  const raw = await fetchKlines(symbol, tf, { limit: Math.min(limit + 1, 1000) });
  // последняя свеча ещё формируется — отбрасываем
  if (raw.length && raw[raw.length - 1].closeTime > Date.now()) raw.pop();
  cache.set(key, raw);
  return raw;
}

async function checkExits(s: Signal, cache: Map<string, Candle[]>, report: TickReport) {
  const c = s.config;
  const now = Date.now();
  const since = Math.max(s.lastCheckedMs || 0, new Date(s.entryTime).getTime());

  // 1) процентные уровни — по минутным свечам с момента прошлой проверки
  if (s.stopPrice !== null || s.takePrice !== null) {
    const minute = await fetchKlines(s.symbol, "1m", {
      startTime: since - 60_000, limit: 1000,
    });
    for (const candle of minute) {
      const hit = checkPriceExit(s.direction, candle, s.stopPrice, s.takePrice);
      if (hit) {
        const pct = profitPct(s.direction, s.entryPrice, hit.price, s.leverage);
        await closeSignal(s.id, hit.status, hit.price, pct);
        const fresh = await getSignal(s.id);
        if (fresh) report.errors.push(...await broadcastSignalClose(fresh));
        report.closed.push({ id: s.id, status: hit.status, profitPct: pct });
        return;
      }
    }
  }

  // 2) RSI-выходы — по закрытиям своего ТФ
  for (const [kind, exit] of [["sl", c.stopLoss], ["tp", c.takeProfit]] as const) {
    if (exit.type !== "rsi") continue;
    const candles = await getClosedCandles(cache, s.symbol, exit.tf, exit.period * 4 + 20);
    if (rsiExitTriggered(exit, kind, s.direction, candles)) {
      const price = await lastPrice(s.symbol);
      const status = kind === "tp" ? "TP" : "SL";
      const pct = profitPct(s.direction, s.entryPrice, price, s.leverage);
      await closeSignal(s.id, status, price, pct);
      const fresh = await getSignal(s.id);
      if (fresh) report.errors.push(...await broadcastSignalClose(fresh));
      report.closed.push({ id: s.id, status, profitPct: pct });
      return;
    }
  }

  await touchSignal(s.id, now);
}

export async function runTick(): Promise<TickReport> {
  const report: TickReport = { checkedSignals: 0, closed: [], opened: [], errors: [] };
  const cache = new Map<string, Candle[]>();

  // Открытые сигналы мониторим всегда, даже если трейдер на паузе
  const open = await openSignals();
  report.checkedSignals = open.length;
  for (const s of open) {
    try {
      await checkExits(s, cache, report);
    } catch (e) {
      report.errors.push(`signal ${s.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Входы — только для запущенных трейдеров без открытого сигнала
  const traders = await listTraders();
  const busy = await openSignalTraderIds();
  const now = Date.now();

  for (const t of traders) {
    if (t.status !== "RUNNING" || busy.has(t.id) || !t.rules.length) continue;
    try {
      // не больше одного входа на одну базовую свечу
      const baseOpen = Math.floor(now / TF_MS[t.timeframe]) * TF_MS[t.timeframe];
      if (t.lastEntryCandle === baseOpen) continue;

      const candlesByTf = new Map<TF, Candle[]>();
      for (const tf of requiredTfs(t)) {
        const need = Math.max(...t.rules.filter((r) => r.tf === tf).map(warmupCandles), 60);
        candlesByTf.set(tf, await getClosedCandles(cache, t.symbol, tf, need + 5));
      }

      if (!allRulesTriggered(t, candlesByTf)) continue;

      const entry = await lastPrice(t.symbol);
      const targets = calcTargets(t.direction, entry, t.stopLoss, t.takeProfit);
      const signal = await insertSignal({
        traderId: t.id,
        symbol: t.symbol,
        direction: t.direction,
        leverage: t.leverage,
        entryPrice: entry,
        stopPrice: targets.stopPrice,
        takePrice: targets.takePrice,
        config: {
          name: t.name, symbol: t.symbol, direction: t.direction,
          leverage: t.leverage, timeframe: t.timeframe, rules: t.rules,
          stopLoss: t.stopLoss, takeProfit: t.takeProfit,
        },
        lastCheckedMs: now,
      });
      await setTraderLastEntryCandle(t.id, baseOpen);
      report.errors.push(...await broadcastSignalOpen(signal));
      report.opened.push({ id: signal.id, symbol: t.symbol, direction: t.direction });
    } catch (e) {
      report.errors.push(`trader ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return report;
}
