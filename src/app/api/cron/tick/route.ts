import { NextRequest, NextResponse } from "next/server";
import { runBotTick } from "@/lib/bot";
import { runTick } from "@/lib/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Дёргается внешним кроном (cron-job.org) раз в минуту:
// GET /api/cron/tick?secret=CRON_SECRET
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const provided = req.nextUrl.searchParams.get("secret")
    ?? req.headers.get("authorization")?.replace("Bearer ", "");
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const report = await runTick();
    // Трейдер-бот не должен ломать конструктор (и наоборот)
    let bot;
    try {
      bot = await runBotTick();
    } catch (e) {
      bot = { error: e instanceof Error ? e.message : String(e) };
    }
    return NextResponse.json({ ...report, bot });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
