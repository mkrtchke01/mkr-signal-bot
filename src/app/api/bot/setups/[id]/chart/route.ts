import { NextRequest, NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { getBotSetup } from "@/lib/db";
import { getUserTrade } from "@/lib/dbUsers";
import { buildTradeChart } from "@/lib/tradeChart";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // свечи тянутся с биржи

// Свечи и восстановленный путь одной сделки — для графика в карточке истории.
// mine — моя сделка по этому сигналу (объём, плечо, итог в $), если была.
export async function GET(
  _req: NextRequest, { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const { id } = await params;
    const setup = await getBotSetup(id);
    if (!setup) return NextResponse.json({ error: "Сделка не найдена" }, { status: 404 });
    const [chart, mine] = await Promise.all([buildTradeChart(setup), getUserTrade(user.id, id)]);
    return NextResponse.json({ setup, chart, mine });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
