// Счёт пользователя: капитал, который он задал, плюс итог сделок, закрытых
// после этого. От баланса считается риск сделки, а свободная маржа решает,
// поместится ли новая: если один бот занял $280 из $300, другим остаётся $20.

import { userAccountTotals } from "./dbUsers";
import type { User } from "./types";

export interface Account {
  capital: number;      // заданный капитал
  capitalSetAt: string;
  realized: number;     // итог сделок, закрытых после установки капитала
  balance: number;      // capital + realized
  usedMargin: number;   // маржа открытых позиций
  free: number;         // balance − usedMargin
  open: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

export async function getAccount(user: User): Promise<Account> {
  const t = await userAccountTotals(user.id, user.capitalSetAt);
  const balance = r2(user.capital + t.realized);
  const usedMargin = r2(t.usedMargin);
  return {
    capital: user.capital, capitalSetAt: user.capitalSetAt,
    realized: r2(t.realized), balance, usedMargin,
    free: r2(Math.max(0, balance - usedMargin)), open: t.open,
  };
}
