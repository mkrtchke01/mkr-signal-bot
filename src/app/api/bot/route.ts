import { NextRequest, NextResponse } from "next/server";
import { getBotConfig, saveBotConfig } from "@/lib/bot";
import { botRuntime, tickBot } from "@/lib/botRegistry";
import { botMeta } from "@/lib/customBots";
import { botStats, getBotState, listBotSetups, wipeBotSetups } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // ручной скан делает десятки запросов к Bybit

// Какой бот — берём из ?bot=<slug>. По умолчанию единственный существующий.
function resolve(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("bot") ?? "breakout-trend";
  const rt = botRuntime(slug);
  const meta = botMeta(slug);
  if (!rt || !meta) return null;
  return { rt, meta };
}

export async function GET(req: NextRequest) {
  const r = resolve(req);
  if (!r) return NextResponse.json({ error: "Неизвестный бот" }, { status: 404 });
  try {
    const { slug, defaults } = r.rt;
    const [config, regime, setups, stats] = await Promise.all([
      getBotConfig(slug, defaults),
      getBotState(slug, "regime"),
      listBotSetups(slug, 60),
      botStats(slug),
    ]);
    return NextResponse.json({ meta: r.meta, config, regime, setups, stats });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// POST ?bot=<slug> { action: "toggle" } — вкл/выкл поиск сетапов
// POST ?bot=<slug> { action: "config", maxActive?, scanMinutes? } — настройки
// POST ?bot=<slug> { action: "scan" } — форс-скан прямо сейчас (только если включён)
// POST ?bot=<slug> { action: "reset", confirm: "RESET" } — снести историю бота
export async function POST(req: NextRequest) {
  const r = resolve(req);
  if (!r) return NextResponse.json({ error: "Неизвестный бот" }, { status: 404 });
  const { slug, defaults } = r.rt;
  try {
    const body = await req.json();
    const cfg = await getBotConfig(slug, defaults);

    if (body.action === "toggle") {
      const enabled = !cfg.enabled;
      await saveBotConfig(slug, {
        ...cfg, enabled,
        enabledAt: enabled ? new Date().toISOString() : cfg.enabledAt,
      });
      return NextResponse.json({ ok: true, enabled });
    }

    if (body.action === "config") {
      const maxActive = Math.max(1, Math.min(10, Number(body.maxActive ?? cfg.maxActive)));
      // Минута — для ботов на одной паре: там скан это один запрос к бирже,
      // зато вход происходит сразу по закрытию свечи
      const scanMinutes = Math.max(1, Math.min(240, Number(body.scanMinutes ?? cfg.scanMinutes)));
      await saveBotConfig(slug, { ...cfg, maxActive, scanMinutes });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "scan") {
      if (!cfg.enabled) {
        return NextResponse.json(
          { error: "Бот на паузе — сначала запусти его" }, { status: 400 },
        );
      }
      const report = await tickBot(slug, { forceScan: true });
      return NextResponse.json({ ok: true, report });
    }

    // Полный сброс: сетапы удаляются безвозвратно и без сообщений в каналы.
    // Настройки бота (пауза, лимиты, период скана) не трогаем.
    if (body.action === "reset") {
      if (body.confirm !== "RESET") {
        return NextResponse.json({ error: "Сброс не подтверждён" }, { status: 400 });
      }
      const removed = await wipeBotSetups(slug);
      return NextResponse.json({ ok: true, removed });
    }

    return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
