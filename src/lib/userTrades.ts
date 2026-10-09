// Сигналы ботов общие, а деньги — у каждого свои. Когда бот публикует сигнал,
// каждому, кто включил этого бота, открывается личная сделка: объём от его
// баланса и риска, максимальное безопасное плечо, проверка свободной маржи.
// Когда сигнал закрывается, личные сделки закрываются по той же цене,
// а итог в $ считается по личному объёму.

import { getAccount } from "./account";
import { closeUserTrade, insertUserTrade, openTradesOfSetup, subscribersOf } from "./dbUsers";
import { BINGX } from "./market";
import { buildPlan, leverageCap, realizedPnl, riskUsdFor } from "./money";
import type { BotSetup, UserTradeStatus } from "./types";

export async function allocateSetup(s: BotSetup, report: { skipped: string[]; errors: string[] }): Promise<void> {
  const subs = await subscribersOf(s.bot);
  for (const { user, riskPct } of subs) {
    try {
      const acc = await getAccount(user);
      const riskUsd = riskUsdFor(acc.balance, riskPct);
      const built = riskUsd > 0
        ? buildPlan(s.direction, s.entryPrice, s.initialStop, s.tp1,
          s.plan?.feeRate ?? BINGX.takerFee, s.tpFinal, { riskUsd, maxLeverage: leverageCap(s.symbol) })
        : null;
      if (!built) {
        await insertUserTrade({
          userId: user.id, setupId: s.id, bot: s.bot, status: "SKIPPED", plan: null,
          note: "Баланс исчерпан — рассчитать объём не из чего",
        });
        continue;
      }
      const plan = { ...built, riskPct, balance: acc.balance };
      // Риск не урезаем: не хватает маржи — сделку пропускаем
      if (plan.margin > acc.free) {
        await insertUserTrade({
          userId: user.id, setupId: s.id, bot: s.bot, status: "SKIPPED", plan,
          note: `Не хватило маржи: нужно $${plan.margin.toFixed(2)}, свободно $${acc.free.toFixed(2)}`,
        });
        report.skipped.push(`${s.symbol} → ${user.email}: не хватило маржи`);
        continue;
      }
      await insertUserTrade({ userId: user.id, setupId: s.id, bot: s.bot, status: "OPEN", plan, note: null });
    } catch (e) {
      report.errors.push(`allocate ${s.symbol} → ${user.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Итог личной сделки в $ по её собственному объёму
export function tradePnl(
  s: Pick<BotSetup, "direction" | "entryPrice" | "tp1">, plan: BotSetup["plan"],
  exit: number, tp1Taken: boolean,
): number | null {
  return plan ? realizedPnl(plan, s.direction, s.entryPrice, s.tp1, exit, tp1Taken) : null;
}

export async function settleSetup(
  s: BotSetup, status: UserTradeStatus, exit: number, tp1Taken: boolean,
): Promise<void> {
  for (const t of await openTradesOfSetup(s.id)) {
    await closeUserTrade(t.id, status, tradePnl(s, t.plan, exit, tp1Taken));
  }
}
