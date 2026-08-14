// Стратегия «Сила против BTC» — кросс-секционный импульс на 15m.
//
// Идея одна: монета, которая за последние сутки обогнала биткоин, продолжает
// его обгонять. Сравнение с BTC отделяет собственное движение монеты от общего
// движения рынка — если рынок вырос на 5%, а монета на 8%, интересны эти 3%.
//
//  1. Вселенная — топ-20 ликвидных перпов по обороту за сутки.
//  2. Вход, когда за 24 часа (96 свечей 15m) монета опережает BTC больше чем
//     на RS_THRESHOLD процентных пункта.
//  3. Подтверждение — собственный тренд монеты: EMA50 > EMA200 на 1h
//     (для шортов зеркально). Отдельного фильтра по режиму BTC нет: на тестах
//     он только ухудшал результат, эту роль играет тренд самой монеты.
//  4. Вход по рынку сразу по закрытию сигнальной свечи — ждать здесь нечего,
//     преимущество как раз в том, что движение уже началось.
//  5. Стоп 6×ATR(14, 15m). Широкий намеренно: на коротком стопе круговые
//     издержки (комиссии + проскальзывание) съедают заметную долю риска.
//  6. TP1 на 1.5R фиксирует половину, там же остаток подхватывает трейлинг
//     с шагом 2×ATR.
//  7. Если за неделю не сработало ничего — выходим по рынку.
//
// Приятное свойство конструкции: TP1 стоит на 9×ATR от входа, а трейлинг идёт
// в 2×ATR за ценой. Значит в момент срабатывания TP1 трейл встаёт минимум на
// 7×ATR = +1.17R, и дальше сделка закрывается не хуже +1.34R по сумме.

import { atrWilder, lastEma } from "./indicators";
import { fmtPrice } from "./format";
import type { Candle, Direction } from "./types";

export const RS_LOOKBACK = 96;      // свечей 15m в окне сравнения = 24 часа
export const RS_THRESHOLD = 3;      // на сколько п.п. монета должна обгонять BTC
export const STOP_ATR = 6;          // стоп в ATR(14, 15m) от входа
export const TP1_R = 1.5;           // фиксация 50% позиции
export const TRAIL_ATR = 2;         // шаг трейлинга
export const MAX_HOLD_HOURS = 168;  // неделя, дальше выход по рынку
export const TREND_FAST = 50;       // EMA на 1h для фильтра тренда
export const TREND_SLOW = 200;

// Границы применимости модели. На тестах стоп выходил примерно в 1.5% от цены,
// а обгон редко превышал десяток пунктов. Всё, что сильно выходит за эти рамки —
// не импульс, а разовый вынос (листинг, новость, памп): там нет ни продолжения,
// ни вменяемого плеча, а объём позиции ужимается до копеек.
export const MAX_STOP_PCT = 8;      // стоп шире — инструмент слишком волатилен
export const MAX_EDGE_PP = 25;      // обгон больше — это не импульс

// сколько свечей нужно сканеру: окно сравнения + прогрев ATR и EMA50
export const M15_BARS = 300;
export const H1_BARS = 260;         // под EMA200 на часовом

export interface RsCandidate {
  symbol: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp1: number;
  activateAt: number;  // совпадает с TP1: трейлинг подхватывает остаток сразу
  trailAbs: number;
  atr: number;
  edge: number;        // обгон BTC в процентных пунктах
  score: number;
  reasons: { entry: string; stop: string; tp1: string; trail: string };
}

// Доходность за lookback баров в процентах; NaN, если данных не хватает
function retPct(c: Candle[], lookback: number): number {
  const base = c[c.length - 1 - lookback];
  const last = c[c.length - 1];
  if (!base || !last || !(base.close > 0)) return NaN;
  return (last.close / base.close - 1) * 100;
}

/**
 * Ищет сетап по относительной силе. Все свечи — только закрытые.
 * @param m15 15-минутные свечи монеты
 * @param h1 часовые свечи монеты — фильтр тренда
 * @param btc15 15-минутные свечи BTC; окно должно совпадать по времени с m15,
 *   иначе сравнение считается по разным отрезкам и врёт
 * @param livePrice текущая цена — вход по рынку
 */
export function findRelStrength(
  symbol: string, m15: Candle[], h1: Candle[], btc15: Candle[], livePrice: number,
): RsCandidate | null {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return null;
  if (m15.length < RS_LOOKBACK + 30 || btc15.length < RS_LOOKBACK + 1) return null;
  if (h1.length < TREND_SLOW + 10) return null;

  // Сравнивать можно только одинаковые отрезки времени
  const last = m15[m15.length - 1];
  const btcLast = btc15[btc15.length - 1];
  const base = m15[m15.length - 1 - RS_LOOKBACK];
  const btcBase = btc15[btc15.length - 1 - RS_LOOKBACK];
  if (!base || !btcBase) return null;
  if (last.openTime !== btcLast.openTime || base.openTime !== btcBase.openTime) return null;

  const edge = retPct(m15, RS_LOOKBACK) - retPct(btc15, RS_LOOKBACK);
  if (!Number.isFinite(edge)) return null;

  const closes1h = h1.map((c) => c.close);
  const fast = lastEma(closes1h, TREND_FAST);
  const slow = lastEma(closes1h, TREND_SLOW);
  const a = atrWilder(m15);
  const ema50 = lastEma(m15.map((c) => c.close), 50);
  if ([fast, slow, a, ema50].some(Number.isNaN) || !(a > 0)) return null;

  let direction: Direction | null = null;
  if (edge > RS_THRESHOLD && fast > slow) direction = "LONG";
  else if (edge < -RS_THRESHOLD && fast < slow) direction = "SHORT";
  if (!direction) return null;
  if (Math.abs(edge) > MAX_EDGE_PP) return null;

  const isLong = direction === "LONG";
  const sign = isLong ? 1 : -1;
  const entry = livePrice;
  const stop = entry - sign * STOP_ATR * a;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  if ((risk / entry) * 100 > MAX_STOP_PCT) return null;
  const tp1 = entry + sign * TP1_R * risk;
  const trailAbs = TRAIL_ATR * a;

  const word = isLong ? "обогнала" : "отстала от";
  const dirWord = isLong ? "выше" : "ниже";
  const reasons = {
    entry: `за ${RS_LOOKBACK / 4}ч монета ${word} BTC на ${Math.abs(edge).toFixed(1)} п.п. `
      + `(${retPct(m15, RS_LOOKBACK).toFixed(1)}% против ${retPct(btc15, RS_LOOKBACK).toFixed(1)}% у BTC). `
      + `Собственный тренд подтверждает: EMA${TREND_FAST} ${dirWord} EMA${TREND_SLOW} на 1h. `
      + `Капитал притекает в то, что уже растёт, и приток инерционен — заходим по рынку сразу`,
    stop: `${STOP_ATR}×ATR(14, 15m) = ${fmtPrice(STOP_ATR * a)} от входа. Стоп широкий намеренно: `
      + `на коротком стопе комиссии и проскальзывание съедают слишком большую долю риска`,
    tp1: `${TP1_R}R = ${fmtPrice(tp1)}: фиксируем половину. Там же остаток подхватывает `
      + `трейлинг, поэтому после TP1 сделка закрывается не хуже +1.34R`,
    trail: `шаг ${TRAIL_ATR}×ATR = ${fmtPrice(trailAbs)} от лучшей цены. Фиксированной второй `
      + `цели нет: импульс иногда тянется намного дальше, чем можно угадать заранее`,
  };

  return {
    symbol, direction, entry, stop, tp1,
    activateAt: tp1,
    trailAbs, atr: a, edge,
    // приоритет при нехватке слотов: чем дальше цена ушла от своей EMA50, тем сильнее импульс
    score: Math.abs(last.close - ema50) / a,
    reasons,
  };
}
