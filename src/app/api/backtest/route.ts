import { NextRequest, NextResponse } from "next/server";
import { runBacktest } from "@/lib/backtest";
import { getTrader } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { traderId: string, days: 7 | 30 }
export async function POST(req: NextRequest) {
  const body = await req.json();
  const days = Number(body.days) === 30 ? 30 : 7;
  const trader = await getTrader(String(body.traderId ?? ""));
  if (!trader) return NextResponse.json({ error: "Трейдер не найден" }, { status: 404 });
  try {
    const result = await runBacktest(trader, days);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Ошибка бэктеста" }, { status: 500 },
    );
  }
}
