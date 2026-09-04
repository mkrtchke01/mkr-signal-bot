// Стратегия «Pre-ignition» — ловим мемкоин в момент, когда он вот-вот стрельнёт.
//
// Предсказать +100% заранее нельзя — никто не умеет. Что реально делаем:
// отбираем статистические предвестники крупного выноса вверх и помечаем
// кандидатов. Это скринер вероятности, а не оракул: срабатывает меньшая часть
// сигналов, а результат делают те, где вынос продолжился.
//
// Тезис входа (всё считается из метрик пула GeckoTerminal):
//   • Свежесть. Пул создан от 30 минут до 3 суток назад — нарратив ещё живой,
//     капитализация мелкая, есть куда расти в 2–3 раза. Слишком свежие (<30 мин)
//     пропускаем: там снайперы и мгновенные rug-и.
//   • Ликвидность в коридоре. Хватает, чтобы войти и выйти, но пул ещё мелкий.
//   • Разгон прямо сейчас. Темп объёма за 5 минут кратно выше среднечасового —
//     активность вспыхивает именно в этот момент.
//   • Давят покупатели. Доля покупок в сделках за 5 минут и за час — на стороне
//     покупателей и не падает.
//   • Ранняя фаза. Цена только развернулась вверх и ещё НЕ улетела вертикально —
//     мы хотим начало движения, а не его середину.
//
// Торговля ручная и без бирже­вых стопов: бот отдаёт сигнал на вход, дальше сам
// следит за ценой и присылает сигнал на выход. Правила выхода — в decideExit.

import type { Pool } from "./geckoterminal";

// ── Пороги отбора (границы здравого смысла, не подобранные оптимизацией) ──
export const LIQ_MIN = 12_000;         // ниже — не войти/не выйти без проскальзывания
export const LIQ_MAX = 1_200_000;      // выше — уже не мелкая монета, 2× маловероятен
export const MC_MAX = 5_000_000;       // потолок капитализации: нужен запас на рост
export const AGE_MIN_H = 0.5;          // моложе — зона снайперов и мгновенных rug-ов
export const AGE_MAX_H = 72;           // старше — нарратив выдохся
export const VOL_H1_MIN = 15_000;      // реальная торговля, а не пустой пул
export const MIN_TX_H1 = 30;           // чтобы доли покупок считались не по 2 сделкам
export const H1_MAX_EARLY = 45;        // уже +45% за час — начало пропущено
export const H1_EXTENDED = 80;         // вертикальный вынос — заходить поздно
export const H6_EXTENDED = 250;        // +250% за 6ч — почти наверняка на вершине

// Разгон и давление покупателей
export const VOL_ACCEL_MIN = 1.4;      // темп объёма m5 (или m15) против часового
export const BUY_RATIO_5M = 0.58;      // доля покупок в сделках за 5 минут
export const SCORE_MIN = 4;            // порог итогового скора

// ── Параметры сопровождения позиции (в долях от цены входа) ──
export const TARGET_MULT = 2.0;        // «план +100%»: ориентир цели = 2× входа
export const MILESTONE_MULT = 1.5;     // отметка +50% — можно снять часть
export const TRAIL_ARM_MULT = 1.35;    // трейлинг-выход включается после +35%
export const TRAIL_RETRACE = 0.28;     // выход при откате 28% от пика
export const INVALIDATE_DROP = 0.35;   // идея не сыграла: −35% от входа
export const RUG_LIQ_FRACTION = 0.34;  // ликвидность рухнула ниже трети минимума

export interface PrepumpSignal {
  pool: Pool;
  entry: number;
  target: number;       // ориентир цели (+100%)
  milestone: number;    // отметка частичной фиксации (+50%)
  armAt: number;        // цена включения трейлинг-выхода (+35%)
  invalidate: number;   // уровень «идея не сыграла» (−35%)
  liqFloor: number;     // ниже этой ликвидности считаем пул сливающимся
  score: number;
  metrics: { volAccel: number; buyR5: number; buyR1: number; turnover: number };
  reasons: { entry: string; stop: string; tp1: string; trail: string };
}

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
const ageHours = (p: Pool) => (Date.now() - p.createdMs) / 3_600_000;

// Причины отбраковки — пригодятся в диагностике скана
export function rejectReasons(p: Pool): string[] {
  const r: string[] = [];
  const age = ageHours(p);
  const c = p.priceChange; const v = p.volume; const t = p.txns;
  if (!(p.liqUsd >= LIQ_MIN && p.liqUsd <= LIQ_MAX)) r.push("liq");
  if (!(p.marketCap > 0 && p.marketCap <= MC_MAX)) r.push("mc");
  if (!(age >= AGE_MIN_H && age <= AGE_MAX_H)) r.push("age");
  if (!(v.h1 >= VOL_H1_MIN)) r.push("volH1");
  if (!((t.h1.buys + t.h1.sells) >= MIN_TX_H1)) r.push("fewtx");
  if (c.h1 > H1_EXTENDED || c.h6 > H6_EXTENDED) r.push("extended");
  if (c.m5 < -6 || c.m15 < -12 || c.h1 < -20) r.push("dumping");
  return r;
}

// Основная функция отбора: пул → сигнал или null. Все пороги — из констант выше.
export function evaluatePrepump(p: Pool): PrepumpSignal | null {
  if (!(p.priceUsd > 0)) return null;
  if (rejectReasons(p).length) return null;

  const c = p.priceChange; const v = p.volume; const t = p.txns;

  // Разгон: темп последних 5 (или 15) минут против среднечасового
  const accel5 = v.h1 > 0 ? (v.m5 * 12) / v.h1 : 0;
  const accel15 = v.h1 > 0 ? (v.m15 * 4) / v.h1 : 0;
  const volAccel = Math.max(accel5, accel15);

  // Доли покупок: за 5 минут берём m5, если сделок мало — падаем на m15
  const tx5 = t.m5.buys + t.m5.sells;
  const buyR5 = tx5 >= 5 ? t.m5.buys / tx5
    : (t.m15.buys + t.m15.sells) > 0 ? t.m15.buys / (t.m15.buys + t.m15.sells) : 0;
  const buyR1 = (t.h1.buys + t.h1.sells) > 0 ? t.h1.buys / (t.h1.buys + t.h1.sells) : 0;
  const turnover = p.liqUsd > 0 ? v.h1 / p.liqUsd : 0;

  // Ранняя фаза: развернулись вверх, но ещё не улетели
  const early = c.m5 > 0 && c.m15 > 0 && c.h1 >= 0 && c.h1 < H1_MAX_EARLY;

  let score = 0;
  if (volAccel >= VOL_ACCEL_MIN) score += Math.min(3, volAccel);
  if (buyR5 >= BUY_RATIO_5M) score += (buyR5 - 0.5) * 6;
  if (buyR1 >= 0.55) score += (buyR1 - 0.5) * 4;
  if (turnover >= 0.5 && turnover <= 30) score += 1;
  if (early) score += 1.5;
  if (ageHours(p) <= 24) score += 1;
  score = Math.round(score * 100) / 100;

  const pass = early && buyR5 >= BUY_RATIO_5M && volAccel >= VOL_ACCEL_MIN
    && (t.h1.buys + t.h1.sells) >= MIN_TX_H1 && score >= SCORE_MIN;
  if (!pass) return null;

  const entry = p.priceUsd;
  const age = ageHours(p);
  return {
    pool: p,
    entry,
    target: entry * TARGET_MULT,
    milestone: entry * MILESTONE_MULT,
    armAt: entry * TRAIL_ARM_MULT,
    invalidate: entry * (1 - INVALIDATE_DROP),
    liqFloor: LIQ_MIN * RUG_LIQ_FRACTION,
    score,
    metrics: {
      volAccel: Math.round(volAccel * 100) / 100,
      buyR5: Math.round(buyR5 * 100) / 100,
      buyR1: Math.round(buyR1 * 100) / 100,
      turnover: Math.round(turnover * 100) / 100,
    },
    reasons: {
      entry: `монете ${age.toFixed(1)}ч, ликвидность $${Math.round(p.liqUsd).toLocaleString("en-US")}, `
        + `капитализация $${Math.round(p.marketCap).toLocaleString("en-US")}. Разгон объёма ×${(Math.round(volAccel * 10) / 10)} `
        + `к часовому темпу, покупатели давят (${Math.round(buyR5 * 100)}% сделок за 5 мин — покупки), `
        + `цена ${pct(c.h1)} за час — начало движения, а не вершина`,
      stop: `биржевого стопа нет — торгуешь вручную. Бот сам напишет «выходи»: `
        + `при −${Math.round(INVALIDATE_DROP * 100)}% от входа идея считается не сыгравшей`,
      tp1: `ориентир цели +100% (${TARGET_MULT}× входа). На +50% приходит отметка — можно снять часть`,
      trail: `после +${Math.round((TRAIL_ARM_MULT - 1) * 100)}% бот ведёт позицию по пику и даёт сигнал `
        + `на выход при откате ${Math.round(TRAIL_RETRACE * 100)}% от максимума`,
    },
  };
}

// ── Правила выхода. Позиция ведётся по текущей цене и пику с момента входа. ──
export type ExitStatus = "TP" | "TRAIL" | "SL" | "TIME";
export interface ExitDecision { exit: boolean; status: ExitStatus; reason: string }

export interface ExitState {
  entry: number;
  peak: number;          // лучшая цена с момента входа
  target: number;
  invalidate: number;
  liqFloor: number;
  armAt: number;
  ageHours: number;
  maxHoldHours: number;
}

// Решение по открытой позиции на основе свежих метрик пула.
// Порядок важен: сначала аварийные выходы (rug), затем цель/откат, потом провал
// идеи, в конце — время.
export function decideExit(st: ExitState, p: Pool | null): ExitDecision | null {
  // Пул пропал из выдачи или ликвидность рухнула — выходим немедленно
  if (!p || p.liqUsd < st.liqFloor || !(p.priceUsd > 0)) {
    return { exit: true, status: "SL",
      reason: "ликвидность рухнула или пул пропал — вероятен слив (rug). Выходи немедленно по рынку" };
  }
  const price = p.priceUsd;
  const gain = price / st.entry - 1;
  const peak = Math.max(st.peak, price);
  const fromPeak = peak > 0 ? 1 - price / peak : 0;
  const reachedTarget = peak >= st.target;
  const armed = peak >= st.armAt;

  // Откат от пика после того, как ушли в заметный плюс — фиксируем движение
  if (armed && fromPeak >= TRAIL_RETRACE) {
    const status: ExitStatus = reachedTarget ? "TP" : "TRAIL";
    return { exit: true, status,
      reason: `откат ${Math.round(fromPeak * 100)}% от пика ${peak.toPrecision(4)} — импульс выдохся. `
        + `Пик был ${gainPct(peak / st.entry - 1)} от входа. Фиксируй по рынку` };
  }
  // Идея не сыграла — цена ушла ниже уровня инвалидации
  if (price <= st.invalidate) {
    return { exit: true, status: "SL",
      reason: `${gainPct(gain)} от входа — идея не сыграла, выходи по рынку` };
  }
  // Держим слишком долго без результата — освобождаем внимание
  if (st.ageHours >= st.maxHoldHours) {
    return { exit: true, status: "TIME",
      reason: `${Math.round(st.ageHours)}ч в позиции без выноса (${gainPct(gain)}) — выходи, идея не развилась` };
  }
  return null;
}

function gainPct(g: number): string {
  return `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%`;
}
