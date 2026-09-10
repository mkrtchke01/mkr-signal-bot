import { NextRequest, NextResponse } from "next/server";
import { getBotSetup } from "@/lib/db";
import { fetchTradeCandles } from "@/lib/tradeChart";
import { TIMEFRAMES } from "@/lib/types";
import type { TF } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Соседний кусок истории для графика сделки: клиент просит его, когда
// пролистывает окно за край уже загруженных свечей.
// GET ?tf=15m&from=<ms>&to=<ms>
export async function GET(
  req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const q = req.nextUrl.searchParams;
    const tf = q.get("tf") as TF | null;
    const from = Number(q.get("from"));
    const to = Number(q.get("to"));
    if (!tf || !TIMEFRAMES.includes(tf)) {
      return NextResponse.json({ error: "Неизвестный таймфрейм" }, { status: 400 });
    }
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return NextResponse.json({ error: "Некорректное окно" }, { status: 400 });
    }
    const setup = await getBotSetup(id);
    if (!setup) return NextResponse.json({ error: "Сделка не найдена" }, { status: 404 });

    const candles = await fetchTradeCandles(setup, tf, from, to);
    return NextResponse.json({
      candles: candles.map((c) => ({
        t: c.openTime, o: c.open, h: c.high, l: c.low, c: c.close,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
