import { NextRequest, NextResponse } from "next/server";
import { lastPrice } from "@/lib/bybit";
import { closeBotSetup, getBotSetup, reopenBotSetup } from "@/lib/db";
import { botCloseCaption, botRearmCaption } from "@/lib/botFormat";
import { buildPlan, realizedPnl } from "@/lib/money";
import { BTC_INTRADAY_SLUG } from "@/lib/botBtcIntraday";
import { levelsFromStop, TP1_R } from "@/lib/strategyBreakout";
import {
  levelsFromStop as intradayLevels, TP_R as INTRADAY_TP_R,
} from "@/lib/strategyBtcIntraday";
import { broadcastText } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Ручное закрытие позиции по текущей рыночной цене
export async function DELETE(
  _req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const s = await getBotSetup(id);
    if (!s) return NextResponse.json({ error: "Сетап не найден" }, { status: 404 });
    if (s.status !== "OPEN") {
      return NextResponse.json({ error: "Сетап уже закрыт" }, { status: 400 });
    }

    const price = await lastPrice(s.symbol);
    const isLong = s.direction === "LONG";
    const move = (p: number) => (isLong ? p / s.entryPrice - 1 : 1 - p / s.entryPrice);
    // при взятом TP1 половина уже зафиксирована по нему, остаток идёт по рынку
    const profitPct = Math.round(
      (s.tp1Done ? 0.5 * move(s.tp1) + 0.5 * move(price) : move(price)) * 10000,
    ) / 100;
    await closeBotSetup(id, "CANCELLED", "Позиция закрыта вручную по рынку.", {
      exitPrice: price,
      profitPct,
      profitUsd: s.plan
        ? realizedPnl(s.plan, s.direction, s.entryPrice, s.tp1, price, s.tp1Done)
        : null,
    });

    const fresh = await getBotSetup(id);
    const errors = fresh ? await broadcastText(botCloseCaption(fresh)) : [];
    return NextResponse.json({ ok: true, errors });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// Вернуть в работу сетап, который бот закрыл ошибочно, а позиция на бирже жива.
// Вход и стоп сохраняются (под них посчитан объём), цели и трейлинг пересчитываются
// по текущим правилам стратегии. Записанный результат сделки стирается.
export async function POST(
  _req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const s = await getBotSetup(id);
    if (!s) return NextResponse.json({ error: "Сетап не найден" }, { status: 404 });
    if (s.status === "OPEN") {
      return NextResponse.json({ error: "Сетап и так в работе" }, { status: 400 });
    }

    // Цели пересчитывает та стратегия, которая сетап породила: у каждого бота
    // свои R до цели и свои параметры трейлинга
    const lv = s.bot === BTC_INTRADAY_SLUG
      ? intradayLevels(s.direction, s.entryPrice, s.initialStop)
      : levelsFromStop(s.direction, s.entryPrice, s.initialStop);
    if (!lv || !(lv.tp1 > 0)) {
      return NextResponse.json({ error: "Не удалось пересчитать уровни" }, { status: 400 });
    }
    const rr1 = s.bot === BTC_INTRADAY_SLUG ? INTRADAY_TP_R : TP1_R;
    const plan = buildPlan(s.direction, s.entryPrice, s.initialStop, lv.tp1);
    if (!plan) {
      return NextResponse.json({ error: "Не удалось пересчитать план" }, { status: 400 });
    }

    const fresh = await reopenBotSetup(id, {
      tp1: lv.tp1, rr1, activateAt: lv.activateAt, trailAbs: lv.trailAbs,
      plan,
      reasons: {
        ...s.reasons,
        tp1: s.tpFull
          ? `${rr1}R: выходим целиком — цель пересчитана от прежнего стопа`
          : `${rr1}R: фиксируем половину — цели пересчитаны по действующим правилам`,
        trail: s.tpFull
          ? `трейлинга нет — позиция закрывается целиком на тейке или на стопе`
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
