// Стратегия «Сила против BTC» — кросс-секционный импульс на 15m.
//
// Идея одна: монета, которая за последние сутки обогнала биткоин, продолжает
// его обгонять. Сравнение с BTC отделяет собственное движение монеты от общего
// движения рынка — если рынок вырос на 5%, а монета на 8%, интересны эти 3%.
//
//  1. Вселенная — топ-20 ликвидных перпов по обороту за сутки.
//  2. Вход, когда за 24 часа (96 свечей 15m) монета опережает BTC больше чем
//     на RS_THRESHOLD процентных пункта сверх своей беты. Альт с бетой 1.8 при
//     падении BTC на 3% сам собой теряет 5.4% — это не слабость монеты, а рычаг
//     к рынку. Без поправки на бету любое движение BTC давало пачку однотипных
//     сигналов по всем высокобетовым альтам сразу.
//  3. Подтверждение — собственный тренд монеты: EMA50 > EMA200 на 1h
//     (для шортов зеркально). Отдельного фильтра по режиму BTC нет: на тестах
//     он только ухудшал результат, эту роль играет тренд самой монеты.
//  4. Вход по рынку сразу по закрытию сигнальной свечи — ждать здесь нечего,
//     преимущество как раз в том, что движение уже началось.
//  5. Стоп 6×ATR(14, 15m) — на практике медиана около 6% от цены. Широкий
//     намеренно: на коротком стопе круговые издержки (комиссии +
//     проскальзывание) съедают заметную долю риска.
//  6. TP1 на 1.5R фиксирует половину, там же остаток подхватывает трейлинг
//     с шагом 2×ATR.
//  7. Если за неделю не сработало ничего — выходим по рынку.
//
// Приятное свойство конструкции: TP1 стоит на 9×ATR от входа, а трейлинг идёт
// в 2×ATR за ценой. Значит в момент срабатывания TP1 трейл встаёт минимум на
// 7×ATR = +1.17R, и дальше сделка закрывается не хуже +1.34R по сумме.
//
// Лимиты на число сделок (одна новая за скан, не больше двух в одну сторону)
// живут в сканере botRelStrength: без них сигналы шли пачками за BTC.
//
// ⚠️ СТАТУС: НЕ ПОДТВЕРЖДЕНА. Стратегия отобрана перебором, но прогон этого же
// кода на истории даёт результат в диапазоне от −$10 до +$309 за четыре года
// в зависимости от одного порога, причём немонотонно. Устойчивого преимущества
// на данных не видно; бот выключен по умолчанию. Подробности в README.

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
// Бета к BTC по лог-доходностям 15m за всё окно сканера (~3 суток). Границы —
// защита от вырожденных оценок на тихом или аномальном отрезке, а не подбор.
export const BETA_MIN = 0.3;
export const BETA_MAX = 3;

// Грубые границы здравого смысла, а не подобранные параметры. Медианный стоп
// у стратегии около 6% от цены — это её нормальный режим, а не аномалия.
// Порог отсекает только совсем дикие инструменты, где 6×ATR уходит за четверть
// цены: там нет ни продолжения движения, ни вменяемого плеча.
//
// ВНИМАНИЕ: значение порога сильно влияет на исторический результат и влияет
// немонотонно (8% → −$10, 10% → +$98, 15% → +$48, 20% → +$309 за четыре года).
// Это признак того, что устойчивого преимущества у стратегии нет — см. README.
export const MAX_STOP_PCT = 25;     // стоп шире — инструмент за рамками модели
export const MAX_EDGE_PP = 60;      // обгон больше — это уже не импульс, а вынос

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
  edge: number;        // обгон BTC сверх беты, в процентных пунктах
  beta: number;        // бета монеты к BTC
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

// Бета монеты к BTC по лог-доходностям общего хвоста двух рядов
export function betaToBtc(coin: Candle[], btc: Candle[]): number {
  const n = Math.min(coin.length, btc.length);
  const a = coin.slice(-n), b = btc.slice(-n);
  let sx = 0, sy = 0;
  const x: number[] = [], y: number[] = [];
  for (let i = 1; i < n; i++) {
    const rx = Math.log(b[i].close / b[i - 1].close);
    const ry = Math.log(a[i].close / a[i - 1].close);
    x.push(rx); y.push(ry); sx += rx; sy += ry;
  }
  if (x.length < 2) return 1;
  const mx = sx / x.length, my = sy / y.length;
  let cov = 0, vx = 0;
  for (let i = 0; i < x.length; i++) { cov += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; }
  const v = vx > 0 ? cov / vx : 1;
  return Number.isFinite(v) ? Math.min(BETA_MAX, Math.max(BETA_MIN, v)) : 1;
}

/**
 * Ищет сетап по относительной силе. Все свечи — только закрытые.
 * @param m15 15-минутные свечи монеты
 * @param h1 часовые свечи монеты — фильтр тренда
 * @param btc15 15-минутные свечи BTC; окно должно совпадать по времени с m15,
 *   иначе сравнение считается по разным отрезкам и врёт
 * @param livePrice текущая цена — вход по рынку
 */
export interface RsLimits { maxEdgePp: number; maxStopPct: number }
export const DEFAULT_LIMITS: RsLimits = { maxEdgePp: MAX_EDGE_PP, maxStopPct: MAX_STOP_PCT };

export function findRelStrength(
  symbol: string, m15: Candle[], h1: Candle[], btc15: Candle[], livePrice: number,
  limits: RsLimits = DEFAULT_LIMITS,
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

  // Сколько монета «должна» была пройти просто из-за своей беты к BTC
  // (в лог-масштабе, чтобы на крупных движениях не уходить в отрицательные цены)
  const beta = betaToBtc(m15, btc15);
  const coinRet = retPct(m15, RS_LOOKBACK);
  const btcRet = retPct(btc15, RS_LOOKBACK);
  const expected = ((1 + btcRet / 100) ** beta - 1) * 100;
  const edge = coinRet - expected;
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
  if (Math.abs(edge) > limits.maxEdgePp) return null;

  const isLong = direction === "LONG";
  const sign = isLong ? 1 : -1;
  const entry = livePrice;
  const stop = entry - sign * STOP_ATR * a;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  if ((risk / entry) * 100 > limits.maxStopPct) return null;
  const tp1 = entry + sign * TP1_R * risk;
  const trailAbs = TRAIL_ATR * a;

  const word = isLong ? "обогнала" : "отстала от";
  const sgn = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const dirWord = isLong ? "выше" : "ниже";
  const reasons = {
    entry: `за ${RS_LOOKBACK / 4}ч монета ${word} BTC на ${Math.abs(edge).toFixed(1)} п.п. сверх своей беты: `
      + `${sgn(coinRet)} при BTC ${sgn(btcRet)}, а с бетой ${beta.toFixed(2)} ожидалось ${sgn(expected)}. `
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
    trailAbs, atr: a, edge, beta,
    // приоритет при нехватке слотов: чем дальше цена ушла от своей EMA50, тем сильнее импульс
    score: Math.abs(last.close - ema50) / a,
    reasons,
  };
}
