import { NextRequest, NextResponse } from "next/server";
import { isResponse, requireAdmin, requireUser } from "@/lib/auth";
import { symbolExists } from "@/lib/bingx";
import { createTrader, listTraders, traderStats } from "@/lib/db";
import { parseTraderPayload, ValidationError } from "@/lib/validate";

export const dynamic = "force-dynamic";

export async function GET() {
  const who = await requireUser();
  if (isResponse(who)) return who;
  try {
    const traders = await listTraders();
    const stats = await traderStats(traders.map((t) => t.id));
    return NextResponse.json(traders.map((t) => ({ ...t, stats: stats.get(t.id) ?? null })));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const who = await requireAdmin();
  if (isResponse(who)) return who;
  try {
    const { name, config } = parseTraderPayload(await req.json());
    if (!(await symbolExists(config.symbol))) {
      return NextResponse.json(
        { error: `Символ ${config.symbol} не найден на BingX` }, { status: 400 },
      );
    }
    const trader = await createTrader(name, config);
    return NextResponse.json(trader, { status: 201 });
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
