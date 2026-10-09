// Общий движок кастомных ботов: тик раз в минуту (из общего крона).
//  - Сопровождение открытых позиций одинаково для всех ботов и работает даже
//    когда бот на паузе — пауза останавливает только поиск новых сетапов.
//  - Поиск сетапов у каждого бота свой: сканер берётся из реестра по slug.
//
// Позиция ведётся по минутным свечам: TP1 → фиксация 50%, дальше остаток
// подхватывает трейлинг, стоп → выход. Правила одной свечи живут в track.ts —
// отдельным чистым модулем, чтобы бэктесты гоняли ровно тот же код.
// Если за maxHoldHours не сработало ничего — выходим по рынку.

import {
  activeBotSetups, closeBotSetup, getBotSetup, getBotState,
  insertBotSetup, markBotTp1, setBotState, touchBotSetup, updateBotTrail,
} from "./db";
import { botCloseCaption, botTp1Caption } from "./botFormat";
import { broadcastText } from "./telegram";
import { buildPlan, realizedPnl } from "./money";
import { BINGX } from "./market";
import { leverageCap, RISK_USD } from "./money";
import { allocateSetup, settleSetup } from "./userTrades";
import { trackCandle } from "./track";
import type { MarketData } from "./market";
import type { TrackState } from "./track";
import type { BotSetup } from "./types";

// Сколько позиций держит бот, не ограничено — ограничивает свободная маржа счёта
export interface BotConfig {
  enabled: boolean;
  enabledAt: string | null; // когда бота запустили в последний раз (ISO)
  scanMinutes: number;  // как часто искать новые сетапы
  maxHoldHours: number; // дольше не держим — закрываем по рынку
}

export interface BotTickReport {
  monitored: number;
  scanned: number;
  closed: { symbol: string; status: string }[];
  newSetups: string[];
  skipped: string[]; // сигналы, на которые не хватило свободной маржи
  errors: string[];
}

export type BotScanner = (
  slug: string, cfg: BotConfig, report: BotTickReport,
) => Promise<void>;

export function emptyReport(): BotTickReport {
  return { monitored: 0, scanned: 0, closed: [], newSetups: [], skipped: [], errors: [] };
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
  s: BotSetup, cfg: BotConfig, market: MarketData, report: BotTickReport,
): Promise<void> {
  const isLong = s.direction === "LONG";
  const move = (p: number) => (isLong ? p / s.entryPrice - 1 : 1 - p / s.entryPrice);
  const pct = (v: number) => Math.round(v * 10000) / 100;
  const now = Date.now();

  // Итог сделки: движение цены + деньги по плану сетапа (плечо и комиссии биржи).
  // При взятом TP1 половина уже зафиксирована по TP1, остаток выходит по exit.
  const result = (exit: number, tp1Taken: boolean) => ({
    exitPrice: exit,
    profitPct: pct(tp1Taken ? 0.5 * move(s.tp1) + 0.5 * move(exit) : move(exit)),
    profitUsd: s.plan
      ? realizedPnl(s.plan, s.direction, s.entryPrice, s.tp1, exit, tp1Taken)
      : null,
  });

  // Закрытие сигнала: в базе, у всех, кто его торговал, и сообщение в каналы
  async function finish(
    status: Exclude<BotSetup["status"], "OPEN">, reason: string, exit: number, tp1Taken: boolean,
  ): Promise<void> {
    await closeBotSetup(s.id, status, reason, result(exit, tp1Taken));
    await settleSetup(s, status, exit, tp1Taken);
    await broadcastClose(s.id, report);
    report.closed.push({ symbol: s.symbol, status });
  }

  const since = Math.max(s.lastCheckedMs || 0, new Date(s.createdAt).getTime());
  const candles = await market.fetchKlines(s.symbol, "1m",
    { startTime: since - 60_000, limit: 1000 });

  const st: TrackState = {
    stop: s.stopPrice, best: s.bestPrice,
    tp1Done: s.tp1Done, trailOn: s.trailOn, moved: false,
  };

  for (const c of candles) {
    const step = trackCandle(s, st, c);
    if (step.stopped) {
      const status = st.trailOn ? "TRAIL" : st.tp1Done ? "PART" : "SL";
      const reason = {
        TRAIL: "Трейлинг снял прибыль: движение выдохлось.",
        PART: s.tpFinal
          ? "Остаток закрыт в безубыток, половина зафиксирована на TP1 — сделка в плюсе."
          : "Остаток выбит стопом, но половина зафиксирована на TP1 — сделка в плюсе.",
        SL: "Пробой оказался ложным — цена вернулась в диапазон.",
      }[status];
      await finish(status, reason, st.stop, st.tp1Done);
      return;
    }
    if (step.tp1Hit) {
      await markBotTp1(s.id);
      report.errors.push(...await broadcastText(botTp1Caption(s)));
    }
    // Цель взята: без частичной фиксации — вся позиция на tp1, с безубытком —
    // остаток на tpFinal. tp1_done ставим, чтобы сетап попал в «дошли до цели».
    if (step.tpHit) {
      const final = s.tpFinal !== null && s.tpFinal > 0;
      if (!final) await markBotTp1(s.id);
      await finish("TP", final
        ? "Основание наклонки взято — остаток закрыт на второй цели."
        : "Цель взята — позиция закрыта целиком.",
      final ? s.tpFinal as number : s.tp1, final);
      return;
    }
  }
  if (st.moved) await updateBotTrail(s.id, st.stop, st.best, st.trailOn);

  // Лимит удержания: идея не сработала ни в плюс, ни в минус — освобождаем слот
  const ageHours = (now - new Date(s.createdAt).getTime()) / 3_600_000;
  if (ageHours >= cfg.maxHoldHours && candles.length) {
    const exit = candles[candles.length - 1].close;
    await finish("TIME",
      `Прошло ${Math.round(ageHours / 24)} дн, цели не достигнуты — выходим по рынку.`,
      exit, st.tp1Done);
    return;
  }

  await touchBotSetup(s.id, now);
}

// Один тик конкретного бота: сопровождение + (если включён и подошёл срок) скан.
// Свечи для сопровождения берём на бирже этого бота: у ботов на BingX и цена,
// и минутные свечи свои.
export async function runBotTick(
  slug: string, defaults: BotConfig, scan: BotScanner, market: MarketData,
  opts: { forceScan?: boolean } = {},
): Promise<BotTickReport> {
  const report = emptyReport();
  const cfg = await getBotConfig(slug, defaults);

  const active = await activeBotSetups(slug);
  report.monitored = active.length;
  for (const s of active) {
    try {
      await monitorSetup(s, cfg, market, report);
    } catch (e) {
      report.errors.push(`setup ${s.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lastScanMs = (await getBotState<number>(slug, "lastScanMs")) ?? 0;
  const due = Date.now() - lastScanMs >= cfg.scanMinutes * 60_000;
  // Боты ищут сигналы всегда: торговать ли ими, решает каждый пользователь
  if (due || opts.forceScan) {
    await setBotState(slug, "lastScanMs", Date.now());
    try {
      await scan(slug, cfg, report);
    } catch (e) {
      report.errors.push(`scan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}

// Публикация сигнала: он общий и уходит в каналы всегда, а деньги — у каждого
// свои: allocateSetup открывает личные сделки тем, кто включил бота.
// План самого сигнала — эталонный (риск RISK_USD): по нему считаются плечо
// и ликвидация для каналов, а в долларах сигнал нигде не показывается.
export async function publishSetup(s: {
  bot: string; symbol: string; direction: BotSetup["direction"];
  entry: number; stop: number; tp1: number; rr1: number;
  activateAt: number; trailAbs: number; tpFull?: boolean;
  tpFinal?: number | null; // цель остатка после TP1 со стопом в безубытке
  reasons: BotSetup["reasons"]; regime: string;
  // Комиссия биржи бота: входит в риск сделки, поэтому определяет объём позиции.
  // По умолчанию BingX — на нём торгуют все боты.
  feeRate?: number;
}, report: BotTickReport, caption: (x: BotSetup) => string): Promise<boolean> {
  const plan = buildPlan(s.direction, s.entry, s.stop, s.tp1, s.feeRate ?? BINGX.takerFee,
    s.tpFinal ?? null, { riskUsd: RISK_USD, maxLeverage: leverageCap(s.symbol) });
  if (!plan) {
    report.errors.push(`plan ${s.symbol}: не удалось рассчитать плечо`);
    return false;
  }
  const setup = await insertBotSetup({
    bot: s.bot, symbol: s.symbol, direction: s.direction,
    entryPrice: s.entry, stopPrice: s.stop,
    tp1: s.tp1, rr1: s.rr1, activateAt: s.activateAt, trailAbs: s.trailAbs,
    tpFull: s.tpFull, tpFinal: s.tpFinal ?? null, reasons: s.reasons, regime: s.regime, plan,
  });
  report.newSetups.push(s.symbol);
  report.errors.push(...await broadcastText(caption(setup)));
  await allocateSetup(setup, report);
  return true;
}
