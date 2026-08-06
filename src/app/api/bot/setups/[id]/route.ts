import { NextRequest, NextResponse } from "next/server";
import { lastPrice } from "@/lib/binance";
import { closeBotSetup, getBotSetup } from "@/lib/db";
import { botCloseCaption } from "@/lib/botFormat";
import { realizedPnl } from "@/lib/money";
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
