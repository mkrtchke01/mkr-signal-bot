import { NextRequest, NextResponse } from "next/server";
import { getBotConfig, saveBotConfig } from "@/lib/bot";
import { PREPUMP_DEFAULTS, PREPUMP_SLUG, tickPrepump } from "@/lib/botPrepump";
import { botMeta } from "@/lib/customBots";
import { botStats, getBotState, listBotSetups, wipeBotSetups } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // ручной скан делает несколько запросов к GeckoTerminal

const meta = () => botMeta(PREPUMP_SLUG);

// Состояние мемкоин-бота для страницы: настройки, позиции, статистика, наблюдение
export async function GET() {
  const m = meta();
  if (!m) return NextResponse.json({ error: "Бот не найден" }, { status: 404 });
  try {
    const [config, setups, stats, watch] = await Promise.all([
      getBotConfig(PREPUMP_SLUG, PREPUMP_DEFAULTS),
      listBotSetups(PREPUMP_SLUG, 80),
      botStats(PREPUMP_SLUG),
      getBotState<unknown[]>(PREPUMP_SLUG, "watch"),
    ]);
    return NextResponse.json({
      meta: m, config, setups, stats,
      watchCount: Array.isArray(watch) ? watch.length : 0,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// toggle — вкл/выкл поиск; config — лимиты; scan — форс-скан; reset — снести историю
export async function POST(req: NextRequest) {
  const m = meta();
  if (!m) return NextResponse.json({ error: "Бот не найден" }, { status: 404 });
  try {
    const body = await req.json();
    const cfg = await getBotConfig(PREPUMP_SLUG, PREPUMP_DEFAULTS);

    if (body.action === "toggle") {
      const enabled = !cfg.enabled;
      await saveBotConfig(PREPUMP_SLUG, {
        ...cfg, enabled,
        enabledAt: enabled ? new Date().toISOString() : cfg.enabledAt,
      });
      return NextResponse.json({ ok: true, enabled });
    }

    if (body.action === "config") {
      const maxActive = Math.max(1, Math.min(10, Number(body.maxActive ?? cfg.maxActive)));
      const scanMinutes = Math.max(2, Math.min(30, Number(body.scanMinutes ?? cfg.scanMinutes)));
      const maxHoldHours = Math.max(2, Math.min(96, Number(body.maxHoldHours ?? cfg.maxHoldHours)));
      await saveBotConfig(PREPUMP_SLUG, { ...cfg, maxActive, scanMinutes, maxHoldHours });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "scan") {
      if (!cfg.enabled) {
        return NextResponse.json({ error: "Бот на паузе — сначала запусти его" }, { status: 400 });
      }
      const report = await tickPrepump({ forceScan: true });
      return NextResponse.json({ ok: true, report });
    }

    if (body.action === "reset") {
      if (body.confirm !== "RESET") {
        return NextResponse.json({ error: "Сброс не подтверждён" }, { status: 400 });
      }
      const removed = await wipeBotSetups(PREPUMP_SLUG);
      return NextResponse.json({ ok: true, removed });
    }

    return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
