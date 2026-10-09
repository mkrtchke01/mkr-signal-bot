// Итог сигнала в единицах риска (R) — общая статистика ботов считается в R,
// а не в долларах: у каждого пользователя свой капитал и свой риск.
// 1R — расстояние от входа до начального стопа. Комиссии не учитываются.

import type { BotSetup } from "./types";

export type RSetup = Pick<BotSetup,
  "direction" | "entryPrice" | "initialStop" | "tp1" | "tp1Done" | "exitPrice">;

/**
 * Если TP1 взят — половина зафиксирована на нём, остаток вышел по exitPrice.
 * У стратегий с выходом целиком на цели exitPrice = tp1, и формула даёт тот же R.
 */
export function setupR(s: RSetup): number | null {
  const risk = Math.abs(s.entryPrice - s.initialStop);
  if (!(risk > 0) || s.exitPrice === null || s.exitPrice === undefined) return null;
  const move = (p: number) => (s.direction === "LONG" ? p - s.entryPrice : s.entryPrice - p) / risk;
  return s.tp1Done ? 0.5 * move(s.tp1) + 0.5 * move(s.exitPrice) : move(s.exitPrice);
}

export function fmtR(r: number | null | undefined): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return "—";
  const v = Math.round(r * 100) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v)}R`;
}
