import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { CUSTOM_BOTS } from "@/lib/customBots";
import { botStats } from "@/lib/db";
import { DEFAULT_USER_RISK_PCT, userBotSettings, userBotStats } from "@/lib/dbUsers";

export const dynamic = "force-dynamic";

// Список кастомных ботов: общая статистика сигналов (в R) и моя (в $)
export async function GET() {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const settings = await userBotSettings(user.id);
    const bots = await Promise.all(CUSTOM_BOTS.map(async (meta) => {
      const [stats, mine] = await Promise.all([botStats(meta.slug), userBotStats(user.id, meta.slug)]);
      const s = settings.get(meta.slug);
      return {
        ...meta,
        stats,
        mine: { enabled: s?.enabled ?? false, riskPct: s?.riskPct ?? DEFAULT_USER_RISK_PCT, stats: mine },
      };
    }));
    return NextResponse.json(bots);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
