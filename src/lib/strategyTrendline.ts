// Стратегия «Пробой наклонки» — пробой наклонного уровня после наторговки у него.
// Торгуется на BingX, на 5m / 15m / 1h; правила описаны трейдером и переложены
// в код один в один, поэтому ниже к каждому шагу — что именно проверяется.
//
// Отбор монеты (иначе сетап не смотрим):
//  1. Корреляция с BTC ниже MAX_CORR. Считается как индикатор TradingView «CC»
//     (Correlation Coefficient) на том же ТФ: Пирсон по CORR_PERIOD ценам
//     закрытия монеты и BTCUSDT. Смысл фильтра — торговать собственное
//     движение монеты, а не отражение биткоина.
//  2. Оборот за сутки не меньше MIN_QUOTE_VOLUME — иначе пробой рисуется одной
//     заявкой, а стоп исполняется по любой цене.
//
// Сетап:
//  3. Наклонка = прямая по свинг-экстремумам одного типа: по хаям (её пробивают
//     вверх, это лонг) или по лоям (пробой вниз, шорт). Линия задаётся первым
//     и последующим касанием; касанием считается свинг-точка не дальше
//     TOUCH_TOL_ATR×ATR от линии. Нужно минимум MIN_TOUCHES касаний, и до
//     пробойной свечи линия должна держать: ни одного закрытия за ней.
//  4. Первые два касания сопровождаются сильными откатами в обратную сторону:
//     от каждого из них цена должна отойти минимум на PULLBACK_ATR×ATR прежде,
//     чем вернуться к линии. Так отсекаются наклонки, нарисованные по трём
//     точкам внутри одного бокового шума.
//  5. После последнего касания — наторговка у границы: от CONSOL_MIN до
//     CONSOL_MAX свечей, шириной не больше CONSOL_RANGE_ATR×ATR, и её дальняя
//     сторона не отходит от линии дальше CONSOL_NEAR_ATR×ATR. Цена перестала
//     откатывать и упёрлась в уровень — это и есть подготовка пробоя.
//
// Вход:
//  6. Пробой ловим на незакрытой свече — «свеча начинает пересекать границу
//     уровня, и появляется объём». Условий три: свеча открылась по старую
//     сторону линии, текущая цена ушла за линию минимум на BREAK_ATR×ATR,
//     и объём набирается быстрее обычного — накопленный объём за минуту
//     не меньше VOL_MULT среднего темпа последних VOL_PERIOD свечей.
//     Вход по рынку в этот момент, у самой границы.
//
//     Почему не по закрытию пробойной свечи, как у остальных ботов: вход
//     считается от границы, и цель — основание наклонки, то есть фиксированная
//     точка. Каждый процент, пройденный до входа, одновременно увеличивает
//     стоп и уменьшает цель. На живом примере ARB 15m вход по границе даёт
//     3.7R, а по закрытию той же свечи — 1.4R, и правило «минимум 1:3» такой
//     сигнал обязано пропустить. Так что вход по закрытию отрезал бы как раз
//     сильные пробои — те, ради которых сетап и берут.
//
// Стоп:
//  7. За наторговку: под её минимум (лонг) или над максимумом (шорт) с запасом
//     STOP_BUFFER_ATR×ATR. Наторговка считается по закрытым свечам, пробойную
//     в неё не берём — она ещё формируется.
//
// Тейк:
//  8. Основание наклонки — цена самого первого касания. Линия сходится к цене,
//     поэтому её основание всегда лежит в сторону пробоя. Выход целиком, без
//     частичной фиксации и трейлинга.
//  9. Если от входа до основания меньше MIN_RR риска — сигнал пропускаем.
//     Это правило трейдера, и оно же главный фильтр: пробой у самого основания
//     геометрически не может дать 1:3.
//
// ⚠️ Экономика. Круговая комиссия BingX по рынку — 0.1% объёма (тейкер 0.05%
// на каждую сторону), и она входит в риск $3. После издержек заявленные 1:3
// превращаются в (3·d − f)/(d + f), где d — стоп в долях цены, f = 0.001:
// при стопе 1% это 2.6, при 0.5% — 2.3, при 0.3% — 2.0. Поэтому MIN_STOP_PCT
// держит слишком узкие стопы за бортом: там сделка состоит из комиссии.
// Тейк стоит ставить лимиткой — мейкер 0.02% вместо 0.05%.
//
// ⚠️ СТАТУС: исторической проверки у стратегии нет — правила только что
// переложены в код. Бот выключен по умолчанию.

import { atrWilder, pearson, sma } from "./indicators";
import { fmtPrice } from "./format";
import type { Candle, Direction, TF } from "./types";
import { TF_MS } from "./types";

// Таймфреймы, на которых работает бот
export const TRENDLINE_TFS: TF[] = ["5m", "15m", "1h"];

export const BARS = 320;            // истории на окно поиска + прогрев ATR
export const SEARCH_BARS = 200;     // в каких свечах вообще ищем наклонку
export const PIVOT_SIDE = 2;        // свинг-точка: экстремум с 2 свечами по бокам
export const MIN_TOUCHES = 3;       // требование трейдера
export const TOUCH_TOL_ATR = 0.5;   // ближе этого к линии — касание
export const MIN_SPAN = 12;         // свечей между первым и последним касанием
export const PULLBACK_ATR = 1.5;    // «сильный откат» после первых двух касаний
export const CONSOL_MIN = 3;        // наторговка: свечей после последнего касания
export const CONSOL_MAX = 30;
export const CONSOL_RANGE_ATR = 2.5; // ширина наторговки
export const CONSOL_NEAR_ATR = 2;   // насколько наторговка отходит от границы
// Заход за линию, при котором считаем, что свеча её пересекла. Половина ATR —
// это примерно тело средней свечи: цена перешла границу, а не задела тенью.
// Меньшие значения проверялись на разведочном прогоне и работают заметно хуже
// (при 0.05–0.25 ATR из 22–24 сигналов выживает один), но выборки там
// на 8 днях истории, поэтому порог выбран по смыслу, а не по этому результату.
export const BREAK_ATR = 0.5;
export const VOL_PERIOD = 20;       // окно среднего объёма
export const VOL_MULT = 1.5;        // темп объёма на пробое против среднего
export const STOP_BUFFER_ATR = 0.15; // запас за наторговку
export const MIN_RR = 3;            // без 1:3 сигнал пропускаем
export const CORR_PERIOD = 20;      // окно корреляции с BTC (как CC на графике)
export const MAX_CORR = 0.4;        // выше — монета идёт за биткоином
export const MIN_QUOTE_VOLUME = 8_000_000; // оборот за 24ч, USDT
export const MAX_HOLD_HOURS = 48;   // дольше идею не держим

// Границы здравого смысла для денежной модели, а не подобранные параметры.
// Узкий стоп — сделка состоит из комиссии (см. врезку выше), широкий —
// плечо и маржа перестают быть разумными.
export const MIN_STOP_PCT = 0.3;
export const MAX_STOP_PCT = 8;

// Насколько далеко может лежать основание наклонки, в ATR. Тоже граница
// здравого смысла: цель должна быть достижима за время удержания, иначе сетап
// закроется по лимиту времени, а не по цели. 12 ATR — это пара дней хода
// в тренде на любом из трёх ТФ.
//
// Предел нужен не для красоты: без него перебор находит крутые многодневные
// линии с основанием в 20% от входа. Формально 1:3 там выполняется с запасом,
// но такую цель внутридневная сделка не увидит — а на живом примере ARB 15m
// именно такая линия перебивала правильную.
//
// Пробовалась и версия «корень из числа свечей за время удержания» (24 ATR
// на 5m, 14 на 15m, 7 на 1h). Её пришлось отбросить: на 1h она не оставила
// ни одного сигнала за 8 дней по 40 монетам, а этот ТФ трейдер торгует.
export const MAX_TARGET_ATR = 12;

/**
 * Пороги сетапа. Существуют как параметры, чтобы исследовательские прогоны
 * гоняли ровно этот код, а не его копию: боевой бот берёт TRENDLINE_PARAMS.
 */
export interface TrendlineParams {
  touchTolAtr: number;
  minTouches: number;
  pullbackAtr: number;
  consolRangeAtr: number;
  consolNearAtr: number;
  breakAtr: number;
  volMult: number;
  stopBufferAtr: number;
  minRr: number;
}

export const TRENDLINE_PARAMS: TrendlineParams = {
  touchTolAtr: TOUCH_TOL_ATR,
  minTouches: MIN_TOUCHES,
  pullbackAtr: PULLBACK_ATR,
  consolRangeAtr: CONSOL_RANGE_ATR,
  consolNearAtr: CONSOL_NEAR_ATR,
  breakAtr: BREAK_ATR,
  volMult: VOL_MULT,
  stopBufferAtr: STOP_BUFFER_ATR,
  minRr: MIN_RR,
};

export interface TrendlineCandidate {
  symbol: string;
  tf: TF;
  direction: Direction;
  entry: number;
  stop: number;
  tp: number;
  rr: number;           // сколько риска до основания наклонки
  atr: number;
  base: number;         // основание наклонки — цель
  baseTime: number;     // openTime первого касания
  lineAtBreak: number;  // граница уровня на пробойной свече
  touches: number;      // сколько касаний собрала линия
  spanBars: number;     // длина наклонки в свечах
  consolBars: number;   // сколько свечей длилась наторговка
  consolLow: number;
  consolHigh: number;
  volMult: number;      // объём пробойной свечи в средних
  corr: number;         // корреляция с BTC на этом ТФ
  fit: number;          // среднее отклонение касаний от линии, в ATR
  signalCandle: number; // openTime пробойной свечи
  reasons: { entry: string; stop: string; tp1: string; trail: string };
}

/**
 * Корреляция монеты с биткоином на её же таймфрейме — как индикатор «CC»
 * в TradingView. Свечи сопоставляются по времени открытия: пропуск в истории
 * одной из пар не должен сдвигать ряды друг относительно друга.
 */
export function corrToBtc(c: Candle[], btc: Candle[], period = CORR_PERIOD): number {
  const byTime = new Map(btc.map((k) => [k.openTime, k.close]));
  const a: number[] = [];
  const b: number[] = [];
  for (let i = c.length - 1; i >= 0 && a.length < period; i--) {
    const p = byTime.get(c[i].openTime);
    if (p === undefined) continue;
    a.push(c[i].close);
    b.push(p);
  }
  if (a.length < period) return NaN;
  return pearson(a, b);
}

interface Pivot { i: number; p: number }

/** Свинг-экстремумы одного типа: хай/лой с PIVOT_SIDE свечами по бокам. */
function pivots(c: Candle[], from: number, to: number, high: boolean): Pivot[] {
  const out: Pivot[] = [];
  for (let i = Math.max(from, PIVOT_SIDE); i <= to - PIVOT_SIDE; i++) {
    let ok = true;
    for (let j = i - PIVOT_SIDE; j <= i + PIVOT_SIDE && ok; j++) {
      if (j === i) continue;
      if (high ? c[j].high >= c[i].high : c[j].low <= c[i].low) ok = false;
    }
    if (ok) out.push({ i, p: high ? c[i].high : c[i].low });
  }
  return out;
}

/**
 * Цели от входа и стопа — для возврата в работу сетапа, который бот закрыл
 * ошибочно. Основание наклонки заново не построить (история уже другая),
 * зато у сетапа сохранён его rr — цель восстанавливается по нему точно.
 */
export function levelsFromStop(
  direction: Direction, entry: number, initialStop: number, rr: number,
): { tp1: number; activateAt: number; trailAbs: number } | null {
  const risk = Math.abs(entry - initialStop);
  if (!(entry > 0) || !(risk > 0) || !(rr > 0)) return null;
  const tp1 = entry + (direction === "LONG" ? 1 : -1) * rr * risk;
  if (!(tp1 > 0)) return null;
  // Трейлинга у стратегии нет — на цели выходим целиком
  return { tp1, activateAt: 0, trailAbs: 0 };
}

/**
 * Ищет пробой наклонки прямо сейчас: наклонка строится по закрытым свечам,
 * а пересечение границы ловится на текущей, ещё не закрытой свече.
 * @param c закрытые свечи монеты, последняя — та, на которой линия ещё держала
 * @param brk текущая незакрытая свеча — она и пересекает границу
 * @param btc закрытые свечи BTCUSDT того же ТФ — для корреляции
 * @param livePrice текущая цена: по ней и заходим по рынку
 * @param now момент проверки — нужен, чтобы понять темп набора объёма
 */
export function findTrendlineBreak(
  symbol: string, tf: TF, c: Candle[], brk: Candle, btc: Candle[],
  livePrice: number, now: number, p: TrendlineParams = TRENDLINE_PARAMS,
): TrendlineCandidate | null {
  if (!Number.isFinite(livePrice) || livePrice <= 0) return null;
  if (c.length < VOL_PERIOD + PIVOT_SIDE * 2 + CONSOL_MIN + MIN_SPAN + 20) return null;

  const corr = corrToBtc(c, btc);
  // NaN сюда же: без корреляции монету не отбирали, значит и сетап не берём
  if (!(corr < MAX_CORR)) return null;

  const atr = atrWilder(c);
  if (!(atr > 0)) return null;
  const volAvg = sma(c.map((k) => k.volume), VOL_PERIOD)[c.length - 1];
  if (!(volAvg > 0)) return null;

  // «Появляется объём»: свеча ещё формируется, поэтому сравниваем не сумму,
  // а темп — сколько объёма пришло за минуту против обычного для этого ТФ.
  // Минута снизу нужна, чтобы первые секунды свечи не давали случайный темп.
  const tfMin = TF_MS[tf] / 60_000;
  const elapsed = Math.min(tfMin, Math.max(1, (now - brk.openTime) / 60_000));
  const volMult = (brk.volume / elapsed) / (volAvg / tfMin);
  if (volMult < p.volMult) return null; // объёма на пробое не появилось

  const e = c.length - 1;
  const bi = e + 1; // позиция пробойной свечи на линии
  const tol = p.touchTolAtr * atr;
  const from = Math.max(PIVOT_SIDE, e - SEARCH_BARS);
  let best: TrendlineCandidate | null = null;

  // Пробой вверх ищем по наклонке из хаёв, вниз — из лоёв. Направление задаёт
  // и то, какой стороной свеча должна пересечь границу.
  for (const long of [true, false]) {
    const pts = pivots(c, from, e, long);
    if (pts.length < p.minTouches) continue;

    for (let a = 0; a < pts.length - 1; a++) {
      for (let b = a + 1; b < pts.length; b++) {
        const span = pts[b].i - pts[a].i;
        if (span < MIN_SPAN) continue;
        const slope = (pts[b].p - pts[a].p) / span;
        // Наклонка должна сходиться к цене: сопротивление падает, поддержка
        // растёт. Иначе её основание оказалось бы позади пробоя, и «тейк
        // к основанию» смотрел бы в обратную сторону.
        if (long ? slope >= 0 : slope <= 0) continue;
        const lineAt = (x: number) => pts[a].p + slope * (x - pts[a].i);

        // Дальше — от дешёвых проверок к дорогим: линий-кандидатов много,
        // и почти все отсеивает первая же — свеча обязана пересечь именно её.
        const line = lineAt(bi);
        // Свеча начала пересекать границу: открылась по старую сторону линии,
        // а цена уже ушла за неё
        const crossed = long
          ? brk.open <= line && livePrice - line >= p.breakAtr * atr
          : brk.open >= line && line - livePrice >= p.breakAtr * atr;
        if (!crossed) continue;

        // Касания линии — только свинг-точки, начиная с её основания
        const touch = pts.filter((q) => q.i >= pts[a].i
          && Math.abs(q.p - lineAt(q.i)) <= tol);
        if (touch.length < p.minTouches) continue;
        const last = touch[touch.length - 1].i;

        // Наторговка после последнего касания — до пробойной свечи
        const consolBars = e - last;
        if (consolBars < CONSOL_MIN || consolBars > CONSOL_MAX) continue;

        // Геометрия наторговки: узкая и у самой границы
        let hiC = -Infinity;
        let loC = Infinity;
        for (let x = last + 1; x <= e; x++) {
          hiC = Math.max(hiC, c[x].high);
          loC = Math.min(loC, c[x].low);
        }
        if (hiC - loC > p.consolRangeAtr * atr) continue;
        const away = long ? line - loC : hiC - line;
        if (away > p.consolNearAtr * atr) continue;

        // Линия держала до пробоя: ни одного закрытия за ней
        let held = true;
        for (let x = pts[a].i; x <= e && held; x++) {
          const lv = lineAt(x);
          if (long ? c[x].close > lv + tol : c[x].close < lv - tol) held = false;
        }
        if (!held) continue;

        // Сильные откаты после первых двух касаний
        let pulled = true;
        for (let k = 0; k < 2 && pulled; k++) {
          let depth = 0;
          for (let x = touch[k].i + 1; x <= touch[k + 1].i; x++) {
            depth = Math.max(depth, long ? touch[k].p - c[x].low : c[x].high - touch[k].p);
          }
          if (depth < p.pullbackAtr * atr) pulled = false;
        }
        if (!pulled) continue;

        const entry = livePrice;
        const stop = (long ? loC : hiC) + (long ? -1 : 1) * p.stopBufferAtr * atr;
        const risk = long ? entry - stop : stop - entry;
        if (!(risk > 0)) continue;
        const stopPct = (risk / entry) * 100;
        if (stopPct < MIN_STOP_PCT || stopPct > MAX_STOP_PCT) continue;

        const base = touch[0].p;
        const reward = long ? base - entry : entry - base;
        const rr = reward / risk;
        if (rr < p.minRr) continue; // 1:3 не выходит — правило трейдера
        // Цель за пределами дневного хода — сделка упрётся в лимит удержания
        if (reward > MAX_TARGET_ATR * atr) continue;

        const fit = touch.reduce((s, q) => s + Math.abs(q.p - lineAt(q.i)), 0)
          / touch.length / atr;
        // Из нескольких линий берём ту, у которой больше касаний, а при равных
        // касаниях — которая точнее ложится на них.
        if (best && (best.touches > touch.length
          || (best.touches === touch.length && best.fit <= fit))) continue;

        best = {
          symbol, tf,
          direction: long ? "LONG" : "SHORT",
          entry, stop, tp: base, rr, atr,
          base, baseTime: c[touch[0].i].openTime,
          lineAtBreak: line,
          touches: touch.length,
          spanBars: last - touch[0].i,
          consolBars, consolLow: loC, consolHigh: hiC,
          volMult, corr, fit,
          signalCandle: brk.openTime,
          reasons: reasonsFor({
            long, tf, line, base, stop, stopPct, rr, atr,
            touches: touch.length, span: last - touch[0].i,
            consolBars, loC, hiC, volMult, corr, p,
          }),
        };
      }
    }
  }
  return best;
}

function reasonsFor(x: {
  long: boolean; tf: TF; line: number; base: number; stop: number; stopPct: number;
  rr: number; atr: number; touches: number; span: number; consolBars: number;
  loC: number; hiC: number; volMult: number; corr: number; p: TrendlineParams;
}): TrendlineCandidate["reasons"] {
  const side = x.long ? "сопротивления" : "поддержки";
  return {
    entry: `пробой наклонного ${side} на ${x.tf}. Линия собрала ${x.touches} касания `
      + `за ${x.span} свечей, первые два отработали сильными откатами в обратную `
      + `сторону. После последнего касания ${x.consolBars} свечей наторговки `
      + `в ${fmtPrice(x.loC)}–${fmtPrice(x.hiC)} — цена перестала откатывать `
      + `и упёрлась в границу ${fmtPrice(x.line)}. Текущая свеча начала `
      + `пересекать границу, объём набирается в ${x.volMult.toFixed(1)} раза `
      + `быстрее обычного — заходим по рынку прямо сейчас, у самой границы: `
      + `цель фиксирована, и каждый процент до входа съедает и её, и стоп. `
      + `Корреляция с BTC ${x.corr.toFixed(2)} (порог ${MAX_CORR}) — монета идёт `
      + `своим движением, а не за биткоином`,
    stop: `за наторговку: ${fmtPrice(x.stop)} (${x.stopPct.toFixed(2)}% от входа) — `
      + `${x.p.stopBufferAtr}×ATR = ${fmtPrice(x.p.stopBufferAtr * x.atr)} `
      + `${x.long ? "под минимумом" : "над максимумом"} скопления. Цена вернулась `
      + `в диапазон наторговки — пробой ложный, идею опровергли`,
    tp1: `основание наклонки ${fmtPrice(x.base)} — точка, с которой линию начали `
      + `рисовать; выходим целиком. От входа это ${x.rr.toFixed(1)}R: сетапы, `
      + `где до основания меньше ${x.p.minRr}R, стратегия пропускает`,
    trail: `трейлинга нет — позиция закрывается целиком на тейке или на стопе`,
  };
}
