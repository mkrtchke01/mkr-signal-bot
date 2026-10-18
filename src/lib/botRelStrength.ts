// Сканер бота «Сила против BTC»: ликвидные монеты → те, что обогнали биткоин
// за сутки → публикация лучших по силе импульса.

import { lastPrice } from "./bingx";
import { botSetupCaption } from "./botFormat";
import {
  findRelStrength, H1_BARS, M15_BARS, MAX_HOLD_HOURS, RS_LOOKBACK, RS_THRESHOLD, TP1_R,
} from "./strategyRelStrength";
import { publishSetup } from "./bot";
import { activeBotSetups } from "./db";
import { chunks, closedKlines, pickUniverse } from "./botScan";
import type { BotConfig, BotTickReport } from "./bot";
import type { RsCandidate } from "./strategyRelStrength";
import type { BotSetup } from "./types";

export const RELSTRENGTH_SLUG = "rel-strength";

export const RELSTRENGTH_DEFAULTS: BotConfig = {
  enabled: false,
  enabledAt: null,
  // Сигнал живёт ровно одну 15-минутную свечу, поэтому сканируем в её такт.
  scanMinutes: 15,
  maxHoldHours: MAX_HOLD_HOURS,
};

// Условие обгона держится часами подряд, поэтому без паузы бот перезаходил бы
// в ту же монету каждую свечу. Четырёх часов хватает, чтобы импульс обновился.
const SYMBOL_COOLDOWN_MS = 4 * 3_600_000;
const SCAN_UNIVERSE = 20;

// Сигналы стратегии сильно коррелируют между собой: одно движение BTC даёт
// обгон сразу у многих монет, и без лимитов бот открывал до двух десятков
// сделок в одну сторону — по сути одну ставку на биткоин с большим риском.
// На четырёх годах истории эти лимиты срезали просадку с $639 до $120 и худший
// день с −$56 до −$12 при том же итоге (relstrength-batch-test.ts).
const MAX_NEW_PER_SCAN = 1;
const MAX_SAME_DIRECTION = 2;

const CAPTION = {
  head: "⚡ СИЛА ПРОТИВ BTC",
  note: "⚠️ Стратегия импульсная и работает на дистанции: в плюс закрывается "
    + "меньше половины сделок, а результат делают те, где движение продолжилось. "
    + "Не больше одной новой сделки за скан и двух открытых в одну сторону.",
};

export async function scanRelStrength(
  slug: string, cfg: BotConfig, report: BotTickReport,
): Promise<void> {
  // Направления открытых сделок бота; новые из этого скана дописываются сюда же
  const openDirs = (await activeBotSetups(slug)).map((s) => s.direction);

  // Эталон, с которым сравниваются все монеты
  const btc15 = await closedKlines("BTCUSDT", "15m", M15_BARS);

  const { symbols, livePrices } = await pickUniverse(slug, SYMBOL_COOLDOWN_MS, SCAN_UNIVERSE);
  report.scanned = symbols.length;

  const candidates: RsCandidate[] = [];
  for (const batch of chunks(symbols, 4)) {
    await Promise.all(batch.map(async (sym) => {
      try {
        const [m15, h1] = await Promise.all([
          sym === "BTCUSDT" ? Promise.resolve(btc15) : closedKlines(sym, "15m", M15_BARS),
          closedKlines(sym, "1h", H1_BARS),
        ]);
        const live = livePrices.get(sym) ?? await lastPrice(sym);
        // BTC сам себя обогнать не может — вернётся null и отсеется здесь же
        const c = findRelStrength(sym, m15, h1, btc15, live);
        if (c) candidates.push(c);
      } catch (e) {
        report.errors.push(`scan ${sym}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }

  candidates.sort((a, b) => b.score - a.score);
  let published = 0;
  for (const c of candidates) {
    if (published >= MAX_NEW_PER_SCAN) break;
    if (openDirs.filter((d) => d === c.direction).length >= MAX_SAME_DIRECTION) continue;
    const ok = await publishSetup({
      bot: slug, symbol: c.symbol, direction: c.direction,
      entry: c.entry, stop: c.stop, tp1: c.tp1, rr1: TP1_R,
      activateAt: c.activateAt, trailAbs: c.trailAbs,
      reasons: c.reasons,
      regime: `обгон BTC за ${RS_LOOKBACK / 4}ч на ${c.edge.toFixed(1)} п.п. `
        + `сверх беты ${c.beta.toFixed(2)} (порог ${RS_THRESHOLD})`,
    }, report, (s: BotSetup) => botSetupCaption(s, CAPTION));
    if (ok) {
      published++;
      openDirs.push(c.direction);
    }
  }
}
