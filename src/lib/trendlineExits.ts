// Выходы «Пробоя наклонки» по правилу трейдера:
//  - до основания наклонки от TP_R до SPLIT_FROM_R риска — вся позиция
//    закрывается на TP_R;
//  - дальше SPLIT_FROM_R — на TP_R фиксируем половину и переносим стоп
//    в безубыток, остаток ведём до основания (первоначальной цели).
// Модуль без зависимостей: его гоняют и бот, и возврат сетапа в работу, и тесты.

import type { Direction } from "./types";

export const TP_R = 3;          // первая (а при близкой цели — единственная) фиксация
export const SPLIT_FROM_R = 3.7; // цель дальше этого — делим позицию

export interface TrendlineExits {
  tp1: number;            // цена фиксации на TP_R
  rr1: number;            // TP_R
  tpFull: boolean;        // на tp1 выходим целиком
  tpFinal: number | null; // цель остатка после безубытка (основание наклонки)
  activateAt: number;     // трейлинга у стратегии нет
  trailAbs: number;
}

/** @param rr сколько риска от входа до основания наклонки */
export function trendlineExits(
  direction: Direction, entry: number, initialStop: number, rr: number,
): TrendlineExits | null {
  const risk = Math.abs(entry - initialStop);
  if (!(entry > 0) || !(risk > 0) || !(rr > 0)) return null;
  const sign = direction === "LONG" ? 1 : -1;
  // Старые сетапы могли открыться с целью ближе TP_R — фиксация не дальше цели
  const r1 = Math.min(TP_R, rr);
  const tp1 = entry + sign * r1 * risk;
  if (!(tp1 > 0)) return null;
  // Сравниваем с допуском: rr приходит и округлённым до десятых
  const split = rr > SPLIT_FROM_R + 1e-9;
  const tpFinal = split ? entry + sign * rr * risk : null;
  if (tpFinal !== null && !(tpFinal > 0)) return null;
  return { tp1, rr1: Math.round(r1 * 10) / 10, tpFull: !split, tpFinal, activateAt: 0, trailAbs: 0 };
}
