import { NextRequest, NextResponse } from "next/server";
import { botRuntime } from "@/lib/botRegistry";
import { isResponse, requireUser } from "@/lib/auth";
import { getBotSetup, reopenBotSetup } from "@/lib/db";
import { closeUserTrade, getUserTrade, reopenTradesOfSetup, undoUserClose } from "@/lib/dbUsers";
import { tradePnl } from "@/lib/userTrades";
import { botRearmCaption } from "@/lib/botFormat";
import { BINGX } from "@/lib/market";
import { buildPlan, leverageCap, RISK_USD } from "@/lib/money";
import { BTC_INTRADAY_SLUG } from "@/lib/botBtcIntraday";
import { TRENDLINE_SLUG } from "@/lib/botTrendline";
import { levelsFromStop, TP1_R } from "@/lib/strategyBreakout";
import {
  levelsFromStop as intradayLevels, TP_R as INTRADAY_TP_R,
} from "@/lib/strategyBtcIntraday";
import { levelsFromStop as trendlineLevels } from "@/lib/strategyTrendline";
import { broadcastText } from "@/lib/telegram";
import { fmtPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

// Цену и комиссию берём на бирже того бота, который породил сетап
const marketOf = (bot: string) => botRuntime(bot)?.market ?? BINGX;

// Личное закрытие по рынку: моя сделка по этому сигналу закрывается по текущей
// цене, сам сигнал и сделки других пользователей продолжают жить
export async function DELETE(
  _req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const { id } = await params;
    const s = await getBotSetup(id);
    if (!s) return NextResponse.json({ error: "Сигнал не найден" }, { status: 404 });
    const mine = await getUserTrade(user.id, id);
    if (!mine || mine.status !== "OPEN") {
      return NextResponse.json({ error: "У тебя нет открытой сделки по этому сигналу" }, { status: 400 });
    }
    const price = await marketOf(s.bot).lastPrice(s.symbol);
    // При взятом TP1 половина уже зафиксирована по нему, остаток идёт по рынку
    await closeUserTrade(mine.id, "CANCELLED", tradePnl(s, mine.plan, price, s.tp1Done));
    return NextResponse.json({ ok: true, price });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// Вернуть в работу сетап, который бот закрыл ошибочно, а позиция на бирже жива.
// Вход и стоп сохраняются (под них посчитан объём), цели и трейлинг пересчитываются
// по текущим правилам стратегии. Записанный результат сделки стирается.
// { action: "undo" } — личное: вернуть мою сделку, закрытую вручную, пока сигнал жив.
// Без action — только админ: вернуть в работу сам сигнал, ошибочно закрытый ботом.
export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    if (body.action === "undo") {
      if (!await undoUserClose(user.id, id)) {
        return NextResponse.json(
          { error: "Вернуть можно только свою сделку, закрытую вручную, пока сигнал в работе" },
          { status: 400 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    if (!user.isAdmin) return NextResponse.json({ error: "Только для админа" }, { status: 403 });

    const s = await getBotSetup(id);
    if (!s) return NextResponse.json({ error: "Сетап не найден" }, { status: 404 });
    if (s.status === "OPEN") {
      return NextResponse.json({ error: "Сетап и так в работе" }, { status: 400 });
    }

    // Цели пересчитывает та стратегия, которая сетап породила: у каждого бота
    // свои R до цели и свои параметры трейлинга. У «Пробоя наклонки» цель —
    // основание линии, заново его не построить, зато известен rr до него:
    // по цели остатка, если она есть, иначе rr1 (у старых сетапов это он и есть).
    const trendRr = s.tpFinal
      ? Math.abs(s.tpFinal - s.entryPrice) / Math.abs(s.entryPrice - s.initialStop)
      : s.rr1;
    const tl = s.bot === TRENDLINE_SLUG
      ? trendlineLevels(s.direction, s.entryPrice, s.initialStop, trendRr)
      : null;
    const lv = s.bot === TRENDLINE_SLUG
      ? tl
      : s.bot === BTC_INTRADAY_SLUG
        ? intradayLevels(s.direction, s.entryPrice, s.initialStop)
        : levelsFromStop(s.direction, s.entryPrice, s.initialStop);
    if (!lv || !(lv.tp1 > 0)) {
      return NextResponse.json({ error: "Не удалось пересчитать уровни" }, { status: 400 });
    }
    const rr1 = tl
      ? tl.rr1
      : s.bot === BTC_INTRADAY_SLUG ? INTRADAY_TP_R : TP1_R;
    const tpFull = tl ? tl.tpFull : s.tpFull;
    const tpFinal = tl ? tl.tpFinal : null;
    const plan = buildPlan(s.direction, s.entryPrice, s.initialStop, lv.tp1,
      marketOf(s.bot).takerFee, tpFinal, {
        // Позиция на бирже жива: объём и плечо те же, что при входе
        riskUsd: s.plan?.riskUsd ?? RISK_USD,
        maxLeverage: s.plan?.leverage ?? leverageCap(s.symbol),
      });
    if (!plan) {
      return NextResponse.json({ error: "Не удалось пересчитать план" }, { status: 400 });
    }

    if (s.plan?.riskPct) Object.assign(plan, { riskPct: s.plan.riskPct, balance: s.plan.balance });
    // Личные сделки, закрытые вместе с сигналом, тоже возвращаются в работу
    if (s.closedAt) await reopenTradesOfSetup(id, s.closedAt);
    const fresh = await reopenBotSetup(id, {
      tp1: lv.tp1, rr1, activateAt: lv.activateAt, trailAbs: lv.trailAbs,
      tpFull, tpFinal,
      plan,
      reasons: {
        ...s.reasons,
        tp1: tpFull
          ? `${rr1}R: выходим целиком — цель пересчитана от прежнего стопа`
          : tpFinal
            ? `${rr1}R: фиксируем половину и переносим стоп в безубыток`
            : `${rr1}R: фиксируем половину — цели пересчитаны по действующим правилам`,
        trail: tpFull
          ? `трейлинга нет — позиция закрывается целиком на тейке или на стопе`
          : tpFinal
            ? `трейлинга нет — остаток в безубытке идёт до ${fmtPrice(tpFinal)}`
          : `трейлинг подхватывает остаток с цены активации, шаг постоянный`,
      },
    });
    if (!fresh) {
      return NextResponse.json({ error: "Сетап не удалось вернуть" }, { status: 409 });
    }
    const errors = await broadcastText(botRearmCaption(fresh));
    return NextResponse.json({ ok: true, setup: fresh, errors });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
