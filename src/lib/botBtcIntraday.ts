// Сканер бота «Bitcoin intraday»: одна пара, один таймфрейм, одна позиция.
// Вселенной здесь нет — стратегия работает только на BTCUSDT 15m, поэтому
// вместо перебора монет бот просто разбирает каждую закрытую 15m-свечу.

import { lastPrice } from "./bingx";
import { activeBotSetups, getBotState, setBotState } from "./db";
import { botSetupCaption } from "./botFormat";
import {
  confirmIntradayTrend, findBtcIntraday, TREND_BARS, TREND_TF, LEVEL_LOOKBACK, M15_BARS, MAX_HOLD_HOURS, RSI_HIGH, RSI_LOW,
  RSI_PERIOD, SYMBOL, TP_R,
} from "./strategyBtcIntraday";
import { publishSetup } from "./bot";
import { closedKlines } from "./botScan";
import type { BotConfig, BotTickReport } from "./bot";
import type { BotSetup } from "./types";

export const BTC_INTRADAY_SLUG = "btc-intraday";

// Риск сделки, % баланса счёта: у Bitcoin intraday — 5%
export const BTC_INTRADAY_RISK_PCT = 5;

export const BTC_INTRADAY_DEFAULTS: BotConfig = {
  enabled: false,
  enabledAt: null,
  // Вход — по закрытию разворотной свечи, поэтому проверяем каждую минуту:
  // так сигнал уходит в первую же минуту после закрытия 15m-свечи. Запрос
  // всего один (одна монета), нагрузки это не создаёт.
  scanMinutes: 1,
  maxHoldHours: MAX_HOLD_HOURS,
};

const CAPTION = {
  head: "₿ BITCOIN INTRADAY",
  note: "⚠️ Стратегия внутридневная: заходим против движения, которое перегрело "
    + "RSI у суточного уровня, но только в сторону тренда 1h по EMA — то есть "
    + "покупаем откат в росте и продаём откат в падении. Сделка живёт часы, стоп узкий — "
    + "комиссии съедают заметную долю риска, поэтому смысл есть только при "
    + "высокой доле попаданий.",
};

export async function scanBtcIntraday(
  slug: string, cfg: BotConfig, report: BotTickReport,
): Promise<void> {
  const active = await activeBotSetups(slug);
  // Пара одна — держать в ней две позиции сразу не из чего
  if (active.length) return;

  const m15 = await closedKlines(SYMBOL, "15m", M15_BARS);
  report.scanned = 1;
  if (!m15.length) return;

  // Каждую свечу разбираем ровно один раз — сразу после её закрытия.
  // Иначе бот весь следующий час проверял бы один и тот же сетап и вошёл бы
  // по цене, которая к правилу входа уже не относится.
  const candle = m15[m15.length - 1].openTime;
  const seen = (await getBotState<number>(slug, "lastCandle")) ?? 0;
  if (candle <= seen) return;
  await setBotState(slug, "lastCandle", candle);

  const raw = findBtcIntraday(m15, await lastPrice(SYMBOL));
  if (!raw) return;
  // Тренд 1h по EMA: свечи качаем, только когда сетап уже нашёлся
  const c = confirmIntradayTrend(raw, await closedKlines(SYMBOL, TREND_TF, TREND_BARS));
  if (!c) return; // разворот против тренда — пропускаем

  await publishSetup({
    bot: slug, symbol: c.symbol, direction: c.direction,
    entry: c.entry, stop: c.stop, tp1: c.tp, rr1: TP_R,
    // трейлинга у стратегии нет: на цели выходим целиком
    activateAt: 0, trailAbs: 0, tpFull: true,
    reasons: c.reasons,
    riskPct: BTC_INTRADAY_RISK_PCT,
    regime: `RSI(${RSI_PERIOD}) проколол ${c.direction === "SHORT" ? RSI_HIGH : RSI_LOW} `
      + `(${c.rsiAt.toFixed(1)}) у уровня ${c.level.toFixed(1)} `
      + `(свинг-уровни за ${LEVEL_LOOKBACK / 96} суток), по тренду ${TREND_TF} (EMA)`,
  }, report, (s: BotSetup) => botSetupCaption(s, CAPTION));
}
