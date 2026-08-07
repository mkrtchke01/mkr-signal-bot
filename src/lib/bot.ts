// Общий движок кастомных ботов: тик раз в минуту (из общего крона).
//  - Сопровождение открытых позиций одинаково для всех ботов и работает даже
//    когда бот на паузе — пауза останавливает только поиск новых сетапов.
//  - Поиск сетапов у каждого бота свой: сканер берётся из реестра по slug.
//
// Позиция ведётся по минутным свечам: TP1 → фиксация 50% и стоп в безубыток,
// TP2 → закрытие остатка, стоп → выход. Если за maxHoldHours не сработало
// ничего — выходим по рынку, чтобы сетап не занимал слот бесконечно.

import { fetchKlines } from "./binance";
import {
  activeBotSetups, closeBotSetup, getBotSetup, getBotState,
  insertBotSetup, markBotTp1, setBotState, touchBotSetup, updateBotTrail,
} from "./db";
import { botCloseCaption, botTp1Caption } from "./botFormat";
import { broadcastText } from "./telegram";
import { buildPlan, realizedPnl } from "./money";
import type { BotSetup } from "./types";

export interface BotConfig {
  enabled: boolean;
  enabledAt: string | null; // когда бота запустили в последний раз (ISO)
  maxActive: number;    // максимум одновременных позиций
  scanMinutes: number;  // как часто искать новые сетапы
  maxHoldHours: number; // дольше не держим — закрываем по рынку
}

export interface BotTickReport {
  monitored: number;
  scanned: number;
  closed: { symbol: string; status: string }[];
  newSetups: string[];
  errors: string[];
}

export type BotScanner = (
  slug: string, cfg: BotConfig, report: BotTickReport,
) => Promise<void>;

export function emptyReport(): BotTickReport {
  return { monitored: 0, scanned: 0, closed: [], newSetups: [], errors: [] };
}

export async function getBotConfig(slug: string, defaults: BotConfig): Promise<BotConfig> {
  const saved = await getBotState<Partial<BotConfig>>(slug, "config");
  return { ...defaults, ...(saved ?? {}) };
}

export async function saveBotConfig(slug: string, cfg: BotConfig): Promise<void> {
  await setBotState(slug, "config", cfg);
}

async function broadcastClose(id: string, report: BotTickReport): Promise<void> {
  const fresh = await getBotSetup(id);
  if (fresh) report.errors.push(...await broadcastText(botCloseCaption(fresh)));
}

// Сопровождение одного сетапа по минутным свечам с момента прошлой проверки.
async function monitorSetup(
  s: BotSetup, cfg: BotConfig, report: BotTickReport,
): Promise<void> {
  const isLong = s.direction === "LONG";
  const move = (p: number) => (isLong ? p / s.entryPrice - 1 : 1 - p / s.entryPrice);
  const pct = (v: number) => Math.round(v * 10000) / 100;
  const now = Date.now();

  // Итог сделки: движение цены + деньги по плану сетапа (плечо и комиссии Bybit).
  // При взятом TP1 половина уже зафиксирована по TP1, остаток выходит по exit.
  const result = (exit: number, tp1Taken: boolean) => ({
    exitPrice: exit,
    profitPct: pct(tp1Taken ? 0.5 * move(s.tp1) + 0.5 * move(exit) : move(exit)),
    profitUsd: s.plan
      ? realizedPnl(s.plan, s.direction, s.entryPrice, s.tp1, exit, tp1Taken)
      : null,
  });

  const since = Math.max(s.lastCheckedMs || 0, new Date(s.createdAt).getTime());
  const candles = await fetchKlines(s.symbol, "1m", { startTime: since - 60_000, limit: 1000 });

  let tp1Done = s.tp1Done;
  let stop = s.stopPrice;
  let best = s.bestPrice;
  let moved = false;

  for (const c of candles) {
    // консервативно: сначала стоп, потом цель
    const hitStop = isLong ? c.low <= stop : c.high >= stop;
    if (hitStop) {
      const st = tp1Done ? "TRAIL" : "SL";
      await closeBotSetup(s.id, st, tp1Done
        ? "Трейлинг снял прибыль: движение выдохлось."
        : "Пробой оказался ложным — цена вернулась в диапазон.",
      result(stop, tp1Done));
      await broadcastClose(s.id, report);
      report.closed.push({ symbol: s.symbol, status: st });
      return;
    }

    if (!tp1Done) {
      const hitT1 = isLong ? c.high >= s.tp1 : c.low <= s.tp1;
      if (hitT1) {
        tp1Done = true;
        best = isLong ? c.high : c.low;
        stop = isLong ? best - s.trailAbs : best + s.trailAbs;
        await markBotTp1(s.id, stop, best);
        report.errors.push(...await broadcastText(botTp1Caption(s)));
      }
    }

    // после TP1 остаток ведёт трейлинг: стоп идёт за ценой и не отходит назад
    if (tp1Done) {
      best = isLong ? Math.max(best, c.high) : Math.min(best, c.low);
      const trail = isLong ? best - s.trailAbs : best + s.trailAbs;
      const next = isLong ? Math.max(stop, trail) : Math.min(stop, trail);
      if (next !== stop) {
        stop = next;
        moved = true;
      }
    }
  }
  if (moved) await updateBotTrail(s.id, stop, best);

  // Лимит удержания: идея не сработала ни в плюс, ни в минус — освобождаем слот
  const ageHours = (now - new Date(s.createdAt).getTime()) / 3_600_000;
  if (ageHours >= cfg.maxHoldHours && candles.length) {
    const exit = candles[candles.length - 1].close;
    await closeBotSetup(s.id, "TIME",
      `Прошло ${Math.round(ageHours / 24)} дн, цели не достигнуты — выходим по рынку.`,
      result(exit, tp1Done));
    await broadcastClose(s.id, report);
    report.closed.push({ symbol: s.symbol, status: "TIME" });
    return;
  }

  await touchBotSetup(s.id, now);
}

// Один тик конкретного бота: сопровождение + (если включён и подошёл срок) скан.
export async function runBotTick(
  slug: string, defaults: BotConfig, scan: BotScanner,
  opts: { forceScan?: boolean } = {},
): Promise<BotTickReport> {
  const report = emptyReport();
  const cfg = await getBotConfig(slug, defaults);

  const active = await activeBotSetups(slug);
  report.monitored = active.length;
  for (const s of active) {
    try {
      await monitorSetup(s, cfg, report);
    } catch (e) {
      report.errors.push(`setup ${s.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lastScanMs = (await getBotState<number>(slug, "lastScanMs")) ?? 0;
  const due = Date.now() - lastScanMs >= cfg.scanMinutes * 60_000;
  if (cfg.enabled && (due || opts.forceScan)) {
    await setBotState(slug, "lastScanMs", Date.now());
    try {
      await scan(slug, cfg, report);
    } catch (e) {
      report.errors.push(`scan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

// Публикация сетапа: считает денежный план и рассылает сигнал в каналы.
export async function publishSetup(s: {
  bot: string; symbol: string; direction: BotSetup["direction"];
  entry: number; stop: number; tp1: number; rr1: number; trailAbs: number;
  reasons: BotSetup["reasons"]; regime: string;
}, report: BotTickReport, caption: (x: BotSetup) => string): Promise<boolean> {
  const plan = buildPlan(s.direction, s.entry, s.stop, s.tp1);
  if (!plan) {
    report.errors.push(`plan ${s.symbol}: не удалось рассчитать объём и плечо`);
    return false;
  }
  const setup = await insertBotSetup({
    bot: s.bot, symbol: s.symbol, direction: s.direction,
    entryPrice: s.entry, stopPrice: s.stop,
    tp1: s.tp1, rr1: s.rr1, trailAbs: s.trailAbs,
    reasons: s.reasons, regime: s.regime, plan,
  });
  report.newSetups.push(s.symbol);
  report.errors.push(...await broadcastText(caption(setup)));
  return true;
}
