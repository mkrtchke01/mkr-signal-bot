import { NextRequest, NextResponse } from "next/server";
import {
  getBotConfig, getSavedRegime, runBotTick, saveBotConfig,
} from "@/lib/bot";
import { botStats, listBotSetups } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // ручной скан делает десятки запросов к Binance

export async function GET() {
  try {
    const [config, regime, setups, stats] = await Promise.all([
      getBotConfig(), getSavedRegime(), listBotSetups(60), botStats(),
    ]);
    return NextResponse.json({ config, regime, setups, stats });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// POST { action: "toggle" } — вкл/выкл поиск сетапов
// POST { action: "config", maxActive?, scanMinutes? } — настройки
// POST { action: "scan" } — форс-скан прямо сейчас (только если бот включён)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cfg = await getBotConfig();

    if (body.action === "toggle") {
      const enabled = !cfg.enabled;
      await saveBotConfig({
        ...cfg, enabled,
        enabledAt: enabled ? new Date().toISOString() : cfg.enabledAt,
      });
      return NextResponse.json({ ok: true, enabled });
    }

    if (body.action === "config") {
      const maxActive = Math.max(1, Math.min(10, Number(body.maxActive ?? cfg.maxActive)));
      const scanMinutes = Math.max(5, Math.min(240, Number(body.scanMinutes ?? cfg.scanMinutes)));
      await saveBotConfig({ ...cfg, maxActive, scanMinutes });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "scan") {
      if (!cfg.enabled) {
        return NextResponse.json(
          { error: "Бот на паузе — сначала запусти его" }, { status: 400 },
        );
      }
      const report = await runBotTick({ forceScan: true });
      return NextResponse.json({ ok: true, report });
    }

    return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
