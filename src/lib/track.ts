// Сопровождение открытой позиции по одной свече — общая логика для боевого
// бота и бэктестов. Модуль намеренно чистый: ни базы, ни сети, ни времени,
// чтобы бэктест гонял ровно тот же код, что и бот, а не его копию.

import type { BotSetup, Candle } from "./types";

export interface TrackState {
  stop: number;      // текущий стоп: до трейлинга — исходный, дальше подтянутый
  best: number;      // лучшая цена с момента активации трейлинга
  tp1Done: boolean;
  trailOn: boolean;
  moved: boolean;    // стоп сдвигался — есть что сохранить
}

export type TrackLevels = Pick<BotSetup, "direction" | "tp1" | "activateAt" | "trailAbs">;

export interface TrackStep {
  stopped: boolean;  // позицию выбило стопом (обычным или трейлинговым)
  tp1Hit: boolean;   // на этой свече взята частичная фиксация
}

/**
 * Прогоняет одну свечу через правила сопровождения, меняя `st` на месте.
 * Порядок проверок консервативный: сначала стоп, потом цели — если свеча
 * задела и то и другое, засчитываем худший исход.
 */
export function trackCandle(s: TrackLevels, st: TrackState, c: Candle): TrackStep {
  const isLong = s.direction === "LONG";
  // Сетапы, опубликованные до появления трейлинга, ведём по их исходным
  // правилам: без шага трейла подтягивать стоп не от чего.
  const canTrail = s.trailAbs > 0 && s.activateAt > 0;

  if (isLong ? c.low <= st.stop : c.high >= st.stop) return { stopped: true, tp1Hit: false };

  // фиксация половины: стоп на остаток здесь не двигаем
  let tp1Hit = false;
  if (!st.tp1Done && (isLong ? c.high >= s.tp1 : c.low <= s.tp1)) {
    st.tp1Done = true;
    tp1Hit = true;
  }

  // отдельная точка включения трейлинга (у импульсных стратегий совпадает с TP1)
  if (canTrail && !st.trailOn && (isLong ? c.high >= s.activateAt : c.low <= s.activateAt)) {
    st.trailOn = true;
    st.best = isLong ? c.high : c.low;
  }

  // трейлинг ведёт остаток: стоп идёт за ценой и не отходит назад
  if (canTrail && st.trailOn) {
    st.best = isLong ? Math.max(st.best, c.high) : Math.min(st.best, c.low);
    const trail = isLong ? st.best - s.trailAbs : st.best + s.trailAbs;
    const next = isLong ? Math.max(st.stop, trail) : Math.min(st.stop, trail);
    if (next !== st.stop) {
      st.stop = next;
      st.moved = true;
    }
  }
  return { stopped: false, tp1Hit };
}
