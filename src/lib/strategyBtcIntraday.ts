// Стратегия «Bitcoin intraday» — разворот от уровня после прокола RSI.
// Только BTCUSDT и только 15m: правила подобраны под ритм именно этой пары.
//
//  1. Прокол RSI(14) — свеча, на которой RSI впервые за серию заходит
//     за RSI_HIGH (шорт) или за RSI_LOW (лонг). Именно пересечение, а не
//     «RSI выше порога»: иначе один затяжной перегрев давал бы сигнал
//     каждую свечу.
//  2. Уровни строятся как их рисует человек: свинг-точки за трое суток,
//     близкие слиты в один уровень. Сигнал берём, только если экстремум
//     разворота подошёл к БЛИЖАЙШЕМУ уровню не дальше LEVEL_TOL_ATR×ATR.
//     Именно ближайшему: при выносе единственный экстремум окна остаётся
//     далеко позади, и правило «уровень = максимум окна» отсекает всё.
//     Перегрев в чистом поле — не сетап.
//  3. Разворотная свеча — первая после прокола свеча противоположного цвета
//     (для шорта красная, для лонга зелёная). Ждём её сколько потребуется:
//     пока идёт серия свечей в сторону прокола, сигнал жив. Вход по рынку
//     сразу после её закрытия.
//  4. Стоп — ровно на экстремуме движения (максимум для шорта, минимум для
//     лонга) на отрезке от свечи прокола до входной включительно. Цена уже
//     показала, где её развернули; вернулась туда — идея не сработала.
//  5. Тейк — 2R от стопа, выход целиком. Ни частичной фиксации, ни
//     трейлинга: сделка внутридневная, вести остаток нечего.
//
//     Сопровождение остатка проверено и не взято. Перебор 12 схем на годовой
//     истории: 50% на 1.5R с трейлингом на 3R шагом 1R даёт профит-фактор 0.67
//     против 0.60 у полного выхода, но выигрывает не заработком, а тем, что
//     реже платит комиссию — сопровождение дольше занимает единственный слот,
//     и сделок становится 663 вместо 734. Прибыльным ни один вариант не стал,
//     поэтому берём тот, что проще: одна цель, один стоп, нечего обновлять
//     на бирже.
//
// ⚠️ Экономика узкого стопа. Круговая комиссия Bybit по рынку — 0.11% объёма,
// и она входит в риск $3. Реальное отношение прибыли к убытку получается
// (TP_R·d − f)/(d + f), где d — стоп в долях цены, f = 0.0011: чем ближе стоп,
// тем меньше от заявленных R остаётся после издержек. Медианный стоп здесь
// 0.32% от цены, и комиссия съедает 27% риска — на годовом прогоне это $580
// при итоге −$483, то есть весь минус стратегии это оплата биржи, а результат
// по чистому движению цены болтается около нуля (+$84 за год на 708 сделках).
// Тейк лимитным ордером (мейкер 0.01% вместо тейкера 0.055%) возвращает часть
// разницы, но безубыточная комиссия здесь 0.0045% за сторону — до неё далеко
// даже мейкеру.
//
// ⚠️ СТАТУС: преимущества на истории не показывает. Бот выключен по умолчанию.

import { atrWilder, rsi } from "./indicators";
import { fmtPrice } from "./format";
import type { Candle, Direction } from "./types";

export const SYMBOL = "BTCUSDT";
export const RSI_PERIOD = 14;
// Пороги мягче хрестоматийных 70/30 намеренно. На разборе живых сетапов
// нашёлся вход, где RSI дошёл до 69.2 и развернулся: по жёсткому порогу 70
// такой разворот не существует, хотя на графике он ничем не отличается от
// соседних. Два пункта запаса эту границу и снимают.
export const RSI_HIGH = 68;         // прокол вверх → ищем шорт
export const RSI_LOW = 32;          // прокол вниз → ищем лонг
// Тейк в единицах риска, выход целиком. Кратность подобрана перебором на
// годовой истории и проверена на обеих её половинах — тенденция монотонная,
// не шум. Ключевое: с ростом цели улучшается не только комиссия (сделок
// меньше), но и сам результат по движению цены: +$47 на 1.5R, +$84 на 2R,
// +$155 на 3R. У сетапа тяжёлый правый хвост — когда разворот отрабатывает,
// он часто уезжает намного дальше, и близкая цель этот хвост срезает.
// На 4R движение падает до +$106: цель становится недостижимой.
// 3R по всем метрикам лучше (ПФ 0.73 против 0.65, просадка $381 против $493),
// но доля попаданий там 26% против 34% — три сделки из четырёх в минус.
export const TP_R = 2;
export const LEVEL_LOOKBACK = 288;  // свечей 15m в окне поиска уровней = 3 суток
export const PIVOT_SIDE = 2;        // свинг-точка: экстремум с 2 свечами по бокам
export const LEVEL_CLUSTER_ATR = 0.3; // ближе этого свинг-точки — один уровень
// Сколько раз цена должна была развернуться на уровне. Единица проверена
// против разбора живых сетапов: требование двух касаний срезает половину
// подтверждённых входов — человек торгует и от одиночного свинга тоже.
export const LEVEL_MIN_TOUCHES = 1;
// Насколько близко к уровню считается «подошли». Значение подобрано по
// разбору живых сетапов: при допуске 1×ATR правило воспроизводит 9 из 10
// подтверждённых входов, при 0.5 — только 6 из 10.
export const LEVEL_TOL_ATR = 1;
// Запас за экстремум разворота. Ноль — стоп стоит ровно на экстремуме:
// цена его уже не переписала, и повторное касание считается опровержением
// идеи. Запас 0.15×ATR (≈0.07% цены) проверялся и оставлен как параметр —
// он расширяет стоп, но вместе с ним растёт и цель 1.5R.
export const STOP_BUFFER_ATR = 0;
export const MAX_WAIT = 24;         // предел ожидания разворотной свечи, 6 часов
export const MAX_HOLD_HOURS = 24;   // дольше внутридневную идею не держим
export const M15_BARS = 500;        // истории на окно уровней + прогрев RSI и ATR

// Границы здравого смысла, а не подобранные параметры.
// Слишком узкий стоп — сделка состоит из комиссии (см. врезку выше).
// Слишком широкий — экстремум далеко, разворот уже не «от уровня».
export const MIN_STOP_PCT = 0.1;
export const MAX_STOP_PCT = 2;

export interface IntradayCandidate {
  symbol: string;
  direction: Direction;
  entry: number;
  stop: number;
  tp: number;
  atr: number;
  level: number;        // уровень, к которому подошла цена
  extreme: number;      // экстремум разворота — за ним стоит стоп
  rsiAt: number;        // значение RSI на свече прокола
  waited: number;       // сколько свечей ждали разворотную
  signalCandle: number; // openTime входной свечи — по нему сканер не входит дважды
  reasons: { entry: string; stop: string; tp1: string; trail: string };
}

const isUp = (c: Candle) => c.close >= c.open;

/**
 * Всё, что зависит от таймфрейма. Боевой бот работает на 15m и берёт
 * значения по умолчанию; параметры существуют, чтобы исследовательские
 * прогоны на других ТФ гоняли ровно этот код, а не его копию.
 */
export interface TfParams {
  tfMinutes: number;      // длина свечи в минутах
  levelLookback: number;  // окно поиска уровней, в свечах
  maxWait: number;        // предел ожидания разворотной свечи, в свечах
}

export const M15_PARAMS: TfParams = {
  tfMinutes: 15,
  levelLookback: LEVEL_LOOKBACK,
  maxWait: MAX_WAIT,
};

/**
 * Цели от входа и стопа — для возврата в работу сетапа, который бот закрыл
 * ошибочно. Вход и стоп остаются прежними (под них посчитан объём),
 * пересчитываются только цель и параметры трейлинга.
 */
export function levelsFromStop(direction: Direction, entry: number, initialStop: number): {
  tp1: number; activateAt: number; trailAbs: number;
} | null {
  const risk = Math.abs(entry - initialStop);
  if (!(entry > 0) || !(risk > 0)) return null;
  const tp1 = entry + (direction === "LONG" ? 1 : -1) * TP_R * risk;
  // Уровень ниже нуля пересчитывать не во что: сетап неисполним
  if (!(tp1 > 0)) return null;
  // Трейлинга у стратегии нет — на цели выходим целиком
  return { tp1, activateAt: 0, trailAbs: 0 };
}

export interface PriceLevel {
  price: number;
  touches: number; // сколько свинг-точек слилось в этот уровень
}

/**
 * Уровни так, как их рисует человек: точки, где цена уже разворачивалась.
 * Берём свинг-экстремумы (хай/лоу с PIVOT_SIDE свечами по бокам) за окно,
 * сливаем близкие в один уровень и отдаём списком — важно именно множество
 * уровней, а не один экстремум окна: цена подходит к ближайшему из них,
 * а не к самому дальнему.
 * @param end индекс, до которого (не включая) ищем историю — свеча прокола
 * @param lookback окно поиска в свечах
 */
export function findLevels(
  c: Candle[], end: number, atr: number, lookback = LEVEL_LOOKBACK,
): PriceLevel[] {
  const from = Math.max(PIVOT_SIDE, end - lookback);
  const pts: number[] = [];
  for (let i = from; i < end - PIVOT_SIDE; i++) {
    let hi = true;
    let lo = true;
    for (let j = i - PIVOT_SIDE; j <= i + PIVOT_SIDE; j++) {
      if (j === i) continue;
      if (c[j].high >= c[i].high) hi = false;
      if (c[j].low <= c[i].low) lo = false;
    }
    if (hi) pts.push(c[i].high);
    if (lo) pts.push(c[i].low);
  }
  pts.sort((a, b) => a - b);

  const out: PriceLevel[] = [];
  let group: number[] = [];
  const flush = () => {
    if (!group.length) return;
    out.push({
      price: group.reduce((a, b) => a + b, 0) / group.length,
      touches: group.length,
    });
    group = [];
  };
  for (const p of pts) {
    if (group.length && p - group[group.length - 1] > LEVEL_CLUSTER_ATR * atr) flush();
    group.push(p);
  }
  flush();
  return out.filter((l) => l.touches >= LEVEL_MIN_TOUCHES);
}

/**
 * Ищет сетап на последней закрытой свече. Вход возможен только на ней:
 * стратегия входит по закрытию разворотной свечи, а не «когда-нибудь потом».
 * @param m15 закрытые свечи BTCUSDT базового ТФ, последняя — входная
 * @param livePrice текущая цена — вход по рынку
 * @param tf параметры таймфрейма; по умолчанию боевые, 15m
 */
export function findBtcIntraday(
  m15: Candle[], livePrice: number, tf: TfParams = M15_PARAMS,
): IntradayCandidate | null {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return null;
  if (m15.length < tf.levelLookback + RSI_PERIOD + 5) return null;

  const r = rsi(m15.map((c) => c.close), RSI_PERIOD);
  const atr = atrWilder(m15);
  if (!(atr > 0)) return null;

  const e = m15.length - 1;
  // Цвет входной свечи задаёт направление: красная разворачивает рост,
  // зелёная — падение. Значит и прокол ищем только соответствующий.
  const short = !isUp(m15[e]);
  const crossed = (i: number) => (short
    ? r[i] >= RSI_HIGH && r[i - 1] < RSI_HIGH
    : r[i] <= RSI_LOW && r[i - 1] > RSI_LOW);
  // разворотная свеча = противоположная направлению прокола
  const reversal = (i: number) => (short ? !isUp(m15[i]) : isUp(m15[i]));

  // Ищем прокол в серии свечей, идущих в сторону прокола, прямо перед входной.
  // Наткнулись на более раннюю разворотную — значит она и была входом для
  // того прокола, а этот сигнал уже отработан.
  let t = -1;
  for (let i = e - 1; i >= Math.max(1, e - tf.maxWait); i--) {
    if (crossed(i)) { t = i; break; }
    if (reversal(i)) break;
  }
  if (t < 0) return null;
  if (Number.isNaN(r[t])) return null;

  // Экстремум движения: от свечи прокола до входной включительно
  const swing = m15.slice(t, e + 1);
  const extreme = short
    ? Math.max(...swing.map((c) => c.high))
    : Math.min(...swing.map((c) => c.low));

  // Подошли к уровню — иначе это перегрев в чистом поле, и разворачиваться не от чего.
  // Уровней много, и цена подходит к ближайшему: искать надо именно его,
  // а не единственный экстремум окна — тот при выносе остаётся далеко позади.
  // Этот же фильтр отсекает затянувшееся ожидание: пока ждали разворотную
  // свечу, цена могла уйти от уровня далеко, и вход «у уровня» превратился бы
  // во вход в пустоту.
  const all = findLevels(m15, t, atr, tf.levelLookback);
  if (!all.length) return null;
  const nearest = all.reduce((best, l) =>
    (Math.abs(l.price - extreme) < Math.abs(best.price - extreme) ? l : best));
  const level = nearest.price;
  const tol = LEVEL_TOL_ATR * atr;
  if (Math.abs(extreme - level) > tol) return null;

  const buffer = STOP_BUFFER_ATR * atr;
  const entry = livePrice;
  const stop = short ? extreme + buffer : extreme - buffer;
  const risk = short ? stop - entry : entry - stop;
  if (!(risk > 0)) return null; // цена уже за стопом — входить некуда
  const stopPct = (risk / entry) * 100;
  if (stopPct < MIN_STOP_PCT || stopPct > MAX_STOP_PCT) return null;
  const tp = entry + (short ? -1 : 1) * TP_R * risk;

  const waited = e - t;
  const dirWord = short ? "перекупленность" : "перепроданность";
  const revWord = short ? "красная" : "зелёная";
  const sideWord = short ? "выше" : "ниже";
  const touches = nearest.touches > 1
    ? `цена разворачивалась на нём ${nearest.touches} раза`
    : `свинг-разворот за последние ${tf.levelLookback * tf.tfMinutes / 1440} суток`;
  const reasons = {
    entry: `RSI(${RSI_PERIOD}) проколол ${short ? RSI_HIGH : RSI_LOW} `
      + `(${r[t].toFixed(1)}) у уровня ${fmtPrice(level)} — ${touches}; `
      + `цена подошла к нему на ${fmtPrice(Math.abs(extreme - level))} `
      + `(допуск ${fmtPrice(tol)}). ${dirWord[0].toUpperCase()}${dirWord.slice(1)} `
      + `у готового уровня — там разворачивают. Подтверждение — первая ${revWord} `
      + `свеча после прокола`
      + (waited > 1 ? ` (ждали ${waited} свечей)` : ``)
      + `: заходим по её закрытию, а не в момент прокола`,
    stop: (buffer > 0
      ? `${STOP_BUFFER_ATR}×ATR(14, 15m) = ${fmtPrice(buffer)} за экстремум разворота `
        + `${fmtPrice(extreme)} → ${fmtPrice(stop)}`
      : `ровно на экстремуме разворота — ${fmtPrice(stop)}`)
      + ` (${stopPct.toFixed(2)}% от входа). Цена уже показала, где её развернули: `
      + `вернулась ${sideWord} к этой отметке — идея не сработала`,
    tp1: `${TP_R}R = ${fmtPrice(tp)}, выходим целиком. Внутридневной разворот `
      + `отрабатывает быстро, тянуть остаток не за чем — сопровождение остатка `
      + `проверено на годовой истории и прибыли не добавило`,
    trail: `трейлинга нет — позиция закрывается целиком на тейке или на стопе`,
  };

  return {
    symbol: SYMBOL,
    direction: short ? "SHORT" : "LONG",
    entry, stop, tp, atr, level, extreme,
    rsiAt: r[t], waited,
    signalCandle: m15[e].openTime,
    reasons,
  };
}
