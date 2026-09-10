import { NextRequest, NextResponse } from "next/server";
import { getBotSetup } from "@/lib/db";
import { buildTradeChart } from "@/lib/tradeChart";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // свечи тянутся с биржи, у DEX ещё и с лимитом

// Свечи и восстановленный путь одной сделки — для графика в карточке истории
export async function GET(
  _req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const setup = await getBotSetup(id);
    if (!setup) return NextResponse.json({ error: "Сделка не найдена" }, { status: 404 });
    const chart = await buildTradeChart(setup);
    return NextResponse.json({ setup, chart });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
