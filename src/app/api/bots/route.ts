import { NextResponse } from "next/server";
import { getBotConfig } from "@/lib/bot";
import { CUSTOM_BOTS } from "@/lib/customBots";
import { botStats } from "@/lib/db";

export const dynamic = "force-dynamic";

// Список кастомных ботов с краткой сводкой для раздела /bots.
// Пока бот один — «Откат к уровням»; у следующих будут свои источники статы.
export async function GET() {
  try {
    const [config, stats] = await Promise.all([getBotConfig(), botStats()]);
    const bots = CUSTOM_BOTS.map((meta) => ({
      ...meta,
      enabled: config.enabled,
      enabledAt: config.enabledAt,
      stats,
    }));
    return NextResponse.json(bots);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
