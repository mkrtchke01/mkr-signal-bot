// Сканер бота «Пробой по тренду»: режим BTC → пробои диапазона по ликвидным
// монетам → публикация лучших по силе выноса.

import { lastPrice } from "./bybit";
import { activeBotSetups, setBotState } from "./db";
import { botSetupCaption } from "./botFormat";
import { detectRegime } from "./regime";
import { findBreakout, MAX_HOLD_HOURS, TP1_R } from "./strategyBreakout";
import { publishSetup } from "./bot";
import { chunks, closedKlines, pickUniverse } from "./botScan";
import type { BotConfig, BotTickReport } from "./bot";
import type { BreakoutCandidate } from "./strategyBreakout";
import type { RegimeInfo } from "./regime";

export const BREAKOUT_SLUG = "breakout-trend";

export const BREAKOUT_DEFAULTS: BotConfig = {
  enabled: false,
  enabledAt: null,
  maxActive: 3,
  // Окно входа живёт 1–3 часа после закрытия 4h-свечи: сканировать надо часто,
  // иначе окно закроется до следующего скана.
  scanMinutes: 15,
  maxHoldHours: MAX_HOLD_HOURS,
};

// Повторный вход в ту же монету сразу после стопа обычно ошибка — сутки паузы
const SYMBOL_COOLDOWN_MS = 24 * 3_600_000;
const SCAN_UNIVERSE = 30;

const CAPTION = {
  head: "🚀 ПРОБОЙ",
  note: "⚠️ Стратегия трендовая: около половины сделок — мелкие минусы по стопу, "
    + "а основной заработок дают редкие длинные движения. Смысл есть только на дистанции.",
};

export async function scanBreakout(
  slug: string, cfg: BotConfig, report: BotTickReport,
): Promise<void> {
  const [btc1d, btc4h] = await Promise.all([
    closedKlines("BTCUSDT", "1d", 220),
    closedKlines("BTCUSDT", "4h", 260),
  ]);
  const regime: RegimeInfo = detectRegime(btc1d, btc4h);
  await setBotState(slug, "regime", regime);
  if (regime.bias === "NEUTRAL") return;

  const active = await activeBotSetups(slug);
  const slots = cfg.maxActive - active.length;
  if (slots <= 0) return;

  const { symbols, livePrices } = await pickUniverse(slug, SYMBOL_COOLDOWN_MS, SCAN_UNIVERSE);
  report.scanned = symbols.length;

  const now = Date.now();
  const candidates: BreakoutCandidate[] = [];
  for (const batch of chunks(symbols, 4)) {
    await Promise.all(batch.map(async (sym) => {
      try {
        const [d1, h4] = sym === "BTCUSDT"
          ? [btc1d, btc4h]
          : await Promise.all([closedKlines(sym, "1d", 220), closedKlines(sym, "4h", 260)]);
        const live = livePrices.get(sym) ?? await lastPrice(sym);
        const c = findBreakout(sym, d1, h4, regime.bias, live, now);
        if (c) candidates.push(c);
      } catch (e) {
        report.errors.push(`scan ${sym}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
  }

  candidates.sort((a, b) => b.score - a.score);
  let published = 0;
  for (const c of candidates) {
    if (published >= slots) break;
    const ok = await publishSetup({
      bot: slug, symbol: c.symbol, direction: c.direction,
      entry: c.entry, stop: c.stop, tp1: c.tp1, rr1: TP1_R,
      activateAt: c.activateAt, trailAbs: c.trailAbs,
      reasons: c.reasons, regime: regime.note,
    }, report, (s) => botSetupCaption(s, CAPTION));
    if (ok) published++;
  }
}
