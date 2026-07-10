// Трейдер-бот: тик раз в минуту (из общего крона).
//  - Сигнал = вход по рынку прямо сейчас: публикуется, только когда цена уже
//    откатилась к кластеру уровней. Сетап рождается сразу OPEN.
//  - Сопровождение: TP1 → фикс 50% + безубыток, TP2/стоп — с сообщениями в каналы.
//    (PENDING-ветки ниже — легаси для лимиток, опубликованных старой версией.)
//  - Скан рынка (раз в scanMinutes): режим BTC → поиск точек входа по ликвидным
//    монетам → публикация лучших по скорингу.
// Открытые сетапы сопровождаются даже когда бот на паузе —
// пауза останавливает только поиск новых.

import { fetchKlines, lastPrice, topSymbols } from "./binance";
import {
  activeBotSetups, closeBotSetup, fillBotSetup, getBotSetup, getBotState,
  insertBotSetup, listBotSetups, markBotTp1, setBotState, touchBotSetup,
} from "./db";
import {
  botCloseCaption, botFilledCaption, botSetupCaption, botTp1Caption,
} from "./botFormat";
import { broadcastText } from "./telegram";
import { detectRegime, findSetup } from "./strategy";
import type { RegimeInfo, SetupCandidate } from "./strategy";
import type { BotSetup, Candle, TF } from "./types";

export interface BotConfig {
  enabled: boolean;
  enabledAt: string | null; // когда бота запустили в последний раз (ISO)
  maxActive: number;   // максимум одновременных сетапов (PENDING + OPEN)
  scanMinutes: number; // как часто искать новые сетапы
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  enabled: false,
  enabledAt: null,
  maxActive: 3,
  scanMinutes: 15,
};

const PENDING_TTL_MS = 48 * 3_600_000; // легаси: лимитка не налилась за 48ч — сетап истёк
const SYMBOL_COOLDOWN_MS = 6 * 3_600_000; // пауза по монете после сетапа — не спамим от того же кластера
const SCAN_UNIVERSE = 16;              // сколько монет анализируем за скан
const MIN_QUOTE_VOLUME = 30_000_000;   // фильтр ликвидности, USDT за 24ч
const EXCLUDED = new Set([
  "USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "BUSDUSDT", "EURUSDT", "DAIUSDT",
]);

export interface BotTickReport {
  monitored: number;
  scanned: number;
  filled: string[];
  closed: { symbol: string; status: string }[];
  cancelled: string[];
  newSetups: string[];
  errors: string[];
}

export async function getBotConfig(): Promise<BotConfig> {
  const saved = await getBotState<Partial<BotConfig>>("config");
  return { ...DEFAULT_BOT_CONFIG, ...(saved ?? {}) };
}

export async function saveBotConfig(cfg: BotConfig): Promise<void> {
  await setBotState("config", cfg);
}

export async function getSavedRegime(): Promise<RegimeInfo | null> {
  return getBotState<RegimeInfo>("regime");
}

// Только закрытые свечи (последняя может ещё формироваться)
async function closedKlines(symbol: string, tf: TF, limit: number): Promise<Candle[]> {
  const raw = await fetchKlines(symbol, tf, { limit: Math.min(limit + 1, 1000) });
  if (raw.length && raw[raw.length - 1].closeTime > Date.now()) raw.pop();
  return raw;
}

async function broadcastClose(id: string, report: BotTickReport): Promise<void> {
  const fresh = await getBotSetup(id);
  if (fresh) report.errors.push(...await broadcastText(botCloseCaption(fresh)));
}

// Сопровождение одного сетапа по минутным свечам с момента прошлой проверки.
async function monitorSetup(s: BotSetup, report: BotTickReport): Promise<void> {
  const isLong = s.direction === "LONG";
  const move = (p: number) => (isLong ? p / s.entryPrice - 1 : 1 - p / s.entryPrice);
  const pct = (v: number) => Math.round(v * 10000) / 100;
  const now = Date.now();

  // Легаси: PENDING-сетапы старой версии (лимитки) дожидаются налива по прежним правилам
  if (s.status === "PENDING" && now - new Date(s.createdAt).getTime() >= PENDING_TTL_MS) {
    await closeBotSetup(s.id, "EXPIRED", null, null,
      "Лимитка не налилась за 48 часов — сетап потерял актуальность.");
    await broadcastClose(s.id, report);
    report.cancelled.push(s.symbol);
    return;
  }

  const since = Math.max(s.lastCheckedMs || 0, new Date(s.createdAt).getTime());
  const candles = await fetchKlines(s.symbol, "1m", { startTime: since - 60_000, limit: 1000 });

  let status = s.status;
  let tp1Done = s.tp1Done;
  let stop = s.stopPrice;

  for (const c of candles) {
    if (status === "PENDING") {
      const filled = isLong ? c.low <= s.entryPrice : c.high >= s.entryPrice;
      if (filled) {
        await fillBotSetup(s.id);
        status = "OPEN";
        report.filled.push(s.symbol);
        report.errors.push(...await broadcastText(botFilledCaption(s)));
        // проваливаемся в проверку выходов на этой же свече
      } else {
        const ranAway = isLong ? c.high >= s.tp1 : c.low <= s.tp1;
        if (ranAway) {
          await closeBotSetup(s.id, "CANCELLED", null, null,
            "Цена дошла до TP1 без налива лимитки — отмена, вдогонку не входим.");
          await broadcastClose(s.id, report);
          report.cancelled.push(s.symbol);
          return;
        }
        continue;
      }
    }

    // status === "OPEN": консервативно сначала стоп, потом тейки
    const hitStop = isLong ? c.low <= stop : c.high >= stop;
    if (hitStop) {
      const st = tp1Done ? "BE" : "SL";
      const profit = tp1Done ? pct(0.5 * move(s.tp1) + 0.5 * move(stop)) : pct(move(stop));
      await closeBotSetup(s.id, st, stop, profit, tp1Done
        ? "Остаток закрыт в безубытке — половина профита с TP1 сохранена."
        : "Структура сломана — идея неправа, выходим по стопу.");
      await broadcastClose(s.id, report);
      report.closed.push({ symbol: s.symbol, status: st });
      return;
    }
    if (!tp1Done) {
      const hitT1 = isLong ? c.high >= s.tp1 : c.low <= s.tp1;
      if (hitT1) {
        tp1Done = true;
        stop = s.entryPrice;
        await markBotTp1(s.id);
        report.errors.push(...await broadcastText(botTp1Caption(s)));
      }
    }
    if (tp1Done) {
      const hitT2 = isLong ? c.high >= s.tp2 : c.low <= s.tp2;
      if (hitT2) {
        const profit = pct(0.5 * move(s.tp1) + 0.5 * move(s.tp2));
        await closeBotSetup(s.id, "TP", s.tp2, profit, "Обе цели взяты полностью.");
        await broadcastClose(s.id, report);
        report.closed.push({ symbol: s.symbol, status: "TP" });
        return;
      }
    }
  }

  await touchBotSetup(s.id, now);
}

function chunks<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Скан рынка: режим BTC → кандидаты → публикация лучших.
async function scanMarket(cfg: BotConfig, report: BotTickReport): Promise<void> {
  const [btc1d, btc4h] = await Promise.all([
    closedKlines("BTCUSDT", "1d", 120),
    closedKlines("BTCUSDT", "4h", 200),
  ]);
  const regime = detectRegime(btc1d, btc4h);
  await setBotState("regime", regime);

  // Легаси: смена режима инвалидирует ещё не налитые лимитки старой версии
  for (const s of await activeBotSetups()) {
    if (s.status === "PENDING" && s.direction !== regime.bias) {
      await closeBotSetup(s.id, "CANCELLED", null, null,
        `Режим BTC сменился (${regime.bias === "NEUTRAL" ? "нейтральный" : regime.bias}) — сетап отменён до входа.`);
      await broadcastClose(s.id, report);
      report.cancelled.push(s.symbol);
    }
  }
  if (regime.bias === "NEUTRAL") return;

  const active = await activeBotSetups();
  const slots = cfg.maxActive - active.length;
  if (slots <= 0) return;
  const activeSymbols = new Set(active.map((s) => s.symbol));

  // Кулдаун: вход по рынку срабатывает, пока цена стоит у кластера, — без паузы
  // после закрытия сетапа бот тут же пересигналил бы ту же самую точку
  const cooldownCutoff = Date.now() - SYMBOL_COOLDOWN_MS;
  const cooling = new Set((await listBotSetups(50))
    .filter((s) => new Date(s.createdAt).getTime() >= cooldownCutoff)
    .map((s) => s.symbol));

  const skip = (sym: string) => activeSymbols.has(sym) || cooling.has(sym);
  const top = await topSymbols(60);
  // Живые цены тикеров: вход по рынку, close закрытой 4h-свечи может быть старым
  const livePrices = new Map(top.map((t) => [t.symbol, t.lastPrice]));
  const universe = top
    .filter((t) => t.quoteVolume >= MIN_QUOTE_VOLUME
      && !EXCLUDED.has(t.symbol) && !skip(t.symbol))
    .slice(0, SCAN_UNIVERSE)
    .map((t) => t.symbol);
  // BTC всегда в выборке — если по нему есть сетап, он может быть лучшим
  if (!skip("BTCUSDT") && !universe.includes("BTCUSDT")) {
    universe.unshift("BTCUSDT");
  }
  report.scanned = universe.length;

  const candidates: SetupCandidate[] = [];
  for (const batch of chunks(universe, 4)) {
    await Promise.all(batch.map(async (sym) => {
      try {
        const [d1, h4] = sym === "BTCUSDT"
          ? [btc1d, btc4h]
          : await Promise.all([closedKlines(sym, "1d", 120), closedKlines(sym, "4h", 200)]);
        const live = livePrices.get(sym) ?? await lastPrice(sym);
        const c = findSetup(sym, d1, h4, regime.bias, live);
        if (c) candidates.push(c);
      } catch (e) {
        report.errors.push(`scan ${sym}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }

  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates.slice(0, slots)) {
    const setup = await insertBotSetup({
      symbol: c.symbol, direction: c.direction, entryPrice: c.entry,
      stopPrice: c.stop, tp1: c.tp1, tp2: c.tp2, rr1: c.rr1, rr2: c.rr2,
      reasons: c.reasons, regime: regime.note,
    });
    report.newSetups.push(c.symbol);
    report.errors.push(...await broadcastText(botSetupCaption(setup)));
  }
}

export async function runBotTick(opts: { forceScan?: boolean } = {}): Promise<BotTickReport> {
  const report: BotTickReport = {
    monitored: 0, scanned: 0, filled: [], closed: [], cancelled: [],
    newSetups: [], errors: [],
  };
  const cfg = await getBotConfig();

  const active = await activeBotSetups();
  report.monitored = active.length;
  for (const s of active) {
    try {
      await monitorSetup(s, report);
    } catch (e) {
      report.errors.push(`setup ${s.symbol}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const lastScanMs = (await getBotState<number>("lastScanMs")) ?? 0;
  const due = Date.now() - lastScanMs >= cfg.scanMinutes * 60_000;
  if (cfg.enabled && (due || opts.forceScan)) {
    await setBotState("lastScanMs", Date.now());
    try {
      await scanMarket(cfg, report);
    } catch (e) {
      report.errors.push(`scan: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return report;
}
