// Мемкоин-бот «Pre-ignition»: ищет свежие DEX-токены, которые вот-вот стрельнут,
// и ведёт их вручную — сигнал на вход, затем сигналы «выходи».
//
// Ключевая деталь — watchlist. Момент, когда тихий пул превращается в разгон,
// в одном срезе ленты почти не поймать: новые пулы ещё без объёма, а популярные
// уже старые. Поэтому мы подбираем свежие пулы в наблюдение и на каждом скане
// заново тянем их метрики — и ловим переход «тихо → загорелось».
//
// Живёт в общей таблице bot_setups (slug 'prepump'), но со своим сопровождением:
// плеча и биржевых ордеров нет, цена обновляется на GeckoTerminal, выход — это
// сообщение в канал, а не стоп на бирже.

import { emptyReport, getBotConfig } from "./bot";
import type { BotConfig, BotTickReport } from "./bot";
import {
  activeBotSetups, closeBotSetup, getBotState, insertDexSetup,
  listBotSetups, markBotTp1, setBotState, touchBotSetup, updateDexTracking,
} from "./db";
import {
  dexEntryAlert, dexExitAlert, dexMilestoneAlert, dexTargetAlert,
} from "./dexAlerts";
import { fetchFeed, fetchPoolsMulti, GT_PAGE_SLEEP_MS, sleep } from "./geckoterminal";
import type { Pool } from "./geckoterminal";
import {
  AGE_MAX_H, decideExit, evaluatePrepump, LIQ_MAX, LIQ_MIN,
  MILESTONE_MULT, RUG_LIQ_FRACTION, TARGET_MULT,
} from "./strategyPrepump";
import type { ExitState } from "./strategyPrepump";
import { broadcastText } from "./telegram";
import type { BotSetup } from "./types";

export const PREPUMP_SLUG = "prepump";

export const PREPUMP_DEFAULTS: BotConfig = {
  enabled: false,
  enabledAt: null,
  maxActive: 5,
  scanMinutes: 3,     // скан делает ~6–8 запросов к GeckoTerminal, лимит ~30/мин
  maxHoldHours: 24,   // мемкоин либо стреляет за сутки, либо идея умерла
};

const NET = "solana";              // где живут мемкоины с быстрым циклом
const WATCH_MAX = 75;              // потолок watchlist — ограничивает число запросов
const INTAKE_MAX_AGE_H = 24;       // в наблюдение берём только свежие пулы
const INTAKE_LIQ_MIN = 8_000;      // совсем сухие пулы не караулим
const WATCH_TTL_MS = 6 * 3_600_000;    // столько ждём разгон, потом снимаем с наблюдения
const SIGNAL_COOLDOWN_MS = 12 * 3_600_000; // не сигналим повторно по той же монете

interface WatchItem { pool: string; firstSeenMs: number; createdMs: number; symbol: string }

async function getWatch(): Promise<WatchItem[]> {
  return (await getBotState<WatchItem[]>(PREPUMP_SLUG, "watch")) ?? [];
}
async function getSignaled(): Promise<Record<string, number>> {
  return (await getBotState<Record<string, number>>(PREPUMP_SLUG, "signaled")) ?? {};
}

// ── Сопровождение открытых позиций: одинаково работает и на паузе бота ──
async function monitor(report: BotTickReport): Promise<void> {
  const active = await activeBotSetups(PREPUMP_SLUG);
  report.monitored = active.length;
  if (!active.length) return;

  const addrs = active.map((s) => s.poolAddress).filter((a): a is string => !!a);
  let byPool = new Map<string, Pool>();
  try {
    const pools = await fetchPoolsMulti(NET, addrs);
    byPool = new Map(pools.map((p) => [p.pool, p]));
  } catch (e) {
    report.errors.push(`monitor fetch: ${e instanceof Error ? e.message : String(e)}`);
    return; // без свежих цен позиции не трогаем — попробуем в следующий тик
  }

  for (const s of active) {
    try {
      await monitorSetup(s, s.poolAddress ? byPool.get(s.poolAddress) ?? null : null, report);
    } catch (e) {
      report.errors.push(`setup ${s.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function monitorSetup(
  s: BotSetup, p: Pool | null, report: BotTickReport,
): Promise<void> {
  const price = p?.priceUsd ?? 0;
  const peak = Math.max(s.bestPrice, price);
  const pctMove = (exit: number) => Math.round((exit / s.entryPrice - 1) * 10000) / 100;

  const st: ExitState = {
    entry: s.entryPrice,
    peak,
    target: s.tp1,
    invalidate: s.stopPrice,
    liqFloor: LIQ_MIN * RUG_LIQ_FRACTION,
    armAt: s.activateAt,
    ageHours: (Date.now() - new Date(s.createdAt).getTime()) / 3_600_000,
    maxHoldHours: (await getBotConfig(PREPUMP_SLUG, PREPUMP_DEFAULTS)).maxHoldHours,
  };

  const decision = decideExit(st, p);
  if (decision) {
    const exitPrice = p ? price : null;
    await closeBotSetup(s.id, decision.status, decision.reason, {
      exitPrice: exitPrice ?? s.entryPrice,
      profitPct: exitPrice ? pctMove(exitPrice) : 0,
      profitUsd: null,
    });
    report.errors.push(...await broadcastText(
      dexExitAlert(s, exitPrice ?? s.bestPrice, decision.reason)));
    report.closed.push({ symbol: s.symbol, status: decision.status });
    return;
  }

  // Позиция продолжается: отмечаем пройденные цели и подтягиваем пик
  const targetAnnounced = s.trailOn; // флагом trail_on помечаем «цель +100% объявлена»
  if (!s.tp1Done && peak >= s.entryPrice * MILESTONE_MULT) {
    await markBotTp1(s.id);
    report.errors.push(...await broadcastText(dexMilestoneAlert(s, price || peak)));
  }
  let announce = targetAnnounced;
  if (!targetAnnounced && peak >= s.tp1) {
    announce = true;
    report.errors.push(...await broadcastText(dexTargetAlert(s, price || peak)));
  }
  await updateDexTracking(s.id, peak, announce);
  await touchBotSetup(s.id, Date.now());
}

// ── Скан: подбор свежих пулов + обновление watchlist + выпуск сигналов ──
async function scan(report: BotTickReport, cfg: BotConfig): Promise<void> {
  const active = await activeBotSetups(PREPUMP_SLUG);
  const slots = cfg.maxActive - active.length;
  if (slots <= 0) return;

  const now = Date.now();
  const activePools = new Set(active.map((s) => s.poolAddress).filter(Boolean));
  const signaled = await getSignaled();
  // Чистим старые записи о просигналенных монетах
  for (const [pool, ts] of Object.entries(signaled)) {
    if (now - ts > SIGNAL_COOLDOWN_MS) delete signaled[pool];
  }

  // 1) Подбор свежих пулов из лент. Метрики приходят сразу — часть можно
  //    оценить тут же, остальное отправляется в наблюдение.
  const intake: Pool[] = [];
  const feeds: [("new_pools" | "trending_pools"), number][] = [
    ["new_pools", 1], ["new_pools", 2], ["trending_pools", 1],
  ];
  for (const [feed, page] of feeds) {
    try {
      intake.push(...await fetchFeed(NET, feed, page));
    } catch (e) {
      report.errors.push(`intake ${feed}#${page}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await sleep(GT_PAGE_SLEEP_MS);
  }

  // 2) Watchlist: обновляем метрики уже наблюдаемых пулов пакетно
  let watch = await getWatch();
  const intakePools = new Set(intake.map((p) => p.pool));
  const toRefresh = watch
    .filter((w) => !intakePools.has(w.pool) && !activePools.has(w.pool))
    .map((w) => w.pool);
  const refreshed: Pool[] = [];
  if (toRefresh.length) {
    try {
      refreshed.push(...await fetchPoolsMulti(NET, toRefresh));
    } catch (e) {
      report.errors.push(`refresh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 3) Оценка всех доступных пулов (свежий подбор + обновлённое наблюдение)
  const candidatePools = [...intake, ...refreshed]
    .filter((p) => !activePools.has(p.pool) && !signaled[p.pool]);
  report.scanned = candidatePools.length;

  const signals = candidatePools
    .map((p) => evaluatePrepump(p))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.score - a.score);

  let published = 0;
  const justSignaled = new Set<string>();
  for (const sig of signals) {
    if (published >= slots) break;
    const p = sig.pool;
    try {
      await insertDexSetup({
        bot: PREPUMP_SLUG, symbol: p.symbol, chain: p.net,
        tokenAddress: p.token, poolAddress: p.pool,
        entry: sig.entry, invalidate: sig.invalidate, target: sig.target,
        milestoneR: TARGET_MULT, armAt: sig.armAt, retrace: 0.28,
        reasons: sig.reasons,
        regime: `разгон ×${sig.metrics.volAccel}, покупки ${Math.round(sig.metrics.buyR5 * 100)}%, `
          + `скор ${sig.score}`,
      });
      report.errors.push(...await broadcastText(dexEntryAlert(sig)));
      report.newSetups.push(p.symbol);
      signaled[p.pool] = now;
      justSignaled.add(p.pool);
      published++;
    } catch (e) {
      report.errors.push(`publish ${p.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 4) Пересобираем watchlist: добавляем свежие пулы, выкидываем просигналенные,
  //    старые и потерявшие ликвидность; ограничиваем размер.
  const known = new Map(watch.map((w) => [w.pool, w]));
  for (const p of intake) {
    const age = (now - p.createdMs) / 3_600_000;
    const fit = age <= INTAKE_MAX_AGE_H && p.liqUsd >= INTAKE_LIQ_MIN && p.liqUsd <= LIQ_MAX;
    if (fit && !known.has(p.pool) && !activePools.has(p.pool) && !signaled[p.pool]) {
      known.set(p.pool, { pool: p.pool, firstSeenMs: now, createdMs: p.createdMs, symbol: p.symbol });
    }
  }
  watch = [...known.values()].filter((w) => {
    if (justSignaled.has(w.pool) || signaled[w.pool] || activePools.has(w.pool)) return false;
    const age = (now - w.createdMs) / 3_600_000;
    if (age > AGE_MAX_H) return false;                 // пул состарился
    if (now - w.firstSeenMs > WATCH_TTL_MS) return false; // не загорелся за отведённое время
    return true;
  });
  // Держим самые свежие: приоритет у молодых пулов
  watch.sort((a, b) => b.createdMs - a.createdMs);
  watch = watch.slice(0, WATCH_MAX);

  await setBotState(PREPUMP_SLUG, "watch", watch);
  await setBotState(PREPUMP_SLUG, "signaled", signaled);
}

// Один тик мемкоин-бота: сопровождение всегда, скан — по расписанию/форсом.
export async function tickPrepump(
  opts: { forceScan?: boolean } = {},
): Promise<BotTickReport> {
  const report = emptyReport();
  const cfg = await getBotConfig(PREPUMP_SLUG, PREPUMP_DEFAULTS);

  await monitor(report);

  const lastScanMs = (await getBotState<number>(PREPUMP_SLUG, "lastScanMs")) ?? 0;
  const due = Date.now() - lastScanMs >= cfg.scanMinutes * 60_000;
  if (cfg.enabled && (due || opts.forceScan)) {
    await setBotState(PREPUMP_SLUG, "lastScanMs", Date.now());
    try {
      await scan(report, cfg);
    } catch (e) {
      report.errors.push(`scan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
