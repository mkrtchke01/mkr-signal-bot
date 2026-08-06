import { NextResponse } from "next/server";
import { getBotConfig } from "@/lib/bot";
import { botRuntime } from "@/lib/botRegistry";
import { CUSTOM_BOTS } from "@/lib/customBots";
import { botStats } from "@/lib/db";

export const dynamic = "force-dynamic";

// Список кастомных ботов с краткой сводкой для раздела /bots
export async function GET() {
  try {
    const bots = await Promise.all(CUSTOM_BOTS.map(async (meta) => {
      const rt = botRuntime(meta.slug);
      const [config, stats] = await Promise.all([
        rt ? getBotConfig(meta.slug, rt.defaults) : null,
        botStats(meta.slug),
      ]);
      return {
        ...meta,
        enabled: config?.enabled ?? false,
        enabledAt: config?.enabledAt ?? null,
        stats,
      };
    }));
    return NextResponse.json(bots);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
