import { NextRequest, NextResponse } from "next/server";
import { symbolExists } from "@/lib/binance";
import {
  deleteTrader, getTrader, listSignals, setTraderStatus, traderStats, updateTrader,
} from "@/lib/db";
import { parseTraderPayload, ValidationError } from "@/lib/validate";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const trader = await getTrader(id);
  if (!trader) return NextResponse.json({ error: "Не найден" }, { status: 404 });
  const stats = await traderStats([id]);
  const signals = await listSignals(id);
  return NextResponse.json({ ...trader, stats: stats.get(id) ?? null, signals });
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const { name, config } = parseTraderPayload(await req.json());
    if (!(await symbolExists(config.symbol))) {
      return NextResponse.json(
        { error: `Символ ${config.symbol} не найден на Binance` }, { status: 400 },
      );
    }
    const trader = await updateTrader(id, name, config);
    if (!trader) return NextResponse.json({ error: "Не найден" }, { status: 404 });
    return NextResponse.json(trader);
  } catch (e) {
    if (e instanceof ValidationError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// PATCH { status: "RUNNING" | "PAUSED" }
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  if (body.status !== "RUNNING" && body.status !== "PAUSED") {
    return NextResponse.json({ error: "status: RUNNING или PAUSED" }, { status: 400 });
  }
  await setTraderStatus(id, body.status);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  await deleteTrader(id);
  return NextResponse.json({ ok: true });
}
