// Счёт, на котором торгуют все кастомные боты. Стартовый баланс START_BALANCE,
// дальше к нему прибавляется результат каждой закрытой сделки. От баланса
// считается риск сделки, а свободная маржа решает, поместится ли новая:
// если один бот занял $280 из $300, другим остаётся $20.
//
// Учитываются только сетапы, открытые после запуска счёта: старые сделки
// считались с фиксированным риском $3 и к этому балансу не относятся.

import { accountTotals, getBotState, setBotState } from "./db";

export const START_BALANCE = 300;
const STATE_BOT = "account"; // ключ в bot_state: account:startedAt

export interface Account {
  start: number;       // стартовый баланс
  startedAt: string;   // с какого момента считаем
  realized: number;    // результат закрытых сделок
  balance: number;     // start + realized
  usedMargin: number;  // маржа открытых позиций
  free: number;        // balance − usedMargin
  open: number;
  closed: number;
}

export async function getAccount(): Promise<Account> {
  let startedAt = await getBotState<string>(STATE_BOT, "startedAt");
  if (!startedAt) {
    startedAt = new Date().toISOString();
    await setBotState(STATE_BOT, "startedAt", startedAt);
  }
  const t = await accountTotals(startedAt);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const balance = r2(START_BALANCE + t.realized);
  const usedMargin = r2(t.usedMargin);
  return {
    start: START_BALANCE, startedAt,
    realized: r2(t.realized), balance, usedMargin,
    free: r2(Math.max(0, balance - usedMargin)),
    open: t.open, closed: t.closed,
  };
}
