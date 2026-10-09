import { NextRequest, NextResponse } from "next/server";
import { getAccount } from "@/lib/account";
import { isResponse, requireUser } from "@/lib/auth";
import { getBotConfig, saveBotConfig } from "@/lib/bot";
import { botRuntime, tickBot } from "@/lib/botRegistry";
import { botMeta } from "@/lib/customBots";
import { botSetupsByIds, botStats, getBotState, listBotSetups, wipeBotSetups } from "@/lib/db";
import {
  DEFAULT_USER_RISK_PCT, MAX_USER_RISK_PCT, MIN_USER_RISK_PCT, setUserBot,
  userBotSettings, userBotStats, userTradesOfBot, wipeUserTrades,
} from "@/lib/dbUsers";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // ручной скан делает десятки запросов к BingX

// Какой бот — берём из ?bot=<slug>. По умолчанию единственный существующий.
function resolve(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("bot") ?? "breakout-trend";
  const rt = botRuntime(slug);
  const meta = botMeta(slug);
  if (!rt || !meta) return null;
  return { rt, meta };
}

const fail = (e: unknown, status = 500) => NextResponse.json(
  { error: e instanceof Error ? e.message : String(e) }, { status },
);

// Общая часть (сигналы бота и статистика в R) + личная (мои настройки,
// статистика в $ и сделки на мой капитал)
export async function GET(req: NextRequest) {
  const r = resolve(req);
  if (!r) return NextResponse.json({ error: "Неизвестный бот" }, { status: 404 });
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const { slug, defaults } = r.rt;
    const [config, regime, setups, stats, settings, myStats, myTrades, account] = await Promise.all([
      getBotConfig(slug, defaults),
      getBotState(slug, "regime"),
      listBotSetups(slug, 60),
      botStats(slug),
      userBotSettings(user.id),
      userBotStats(user.id, slug),
      userTradesOfBot(user.id, slug, 100),
      getAccount(user),
    ]);
    // Сигналы моих сделок, которых нет среди последних 60
    const known = new Set(setups.map((s) => s.id));
    const extra = await botSetupsByIds(myTrades.map((t) => t.setupId).filter((id) => !known.has(id)));
    const s = settings.get(slug);
    return NextResponse.json({
      meta: r.meta, config, regime, setups: [...setups, ...extra], stats,
      isAdmin: user.isAdmin,
      mine: {
        enabled: s?.enabled ?? false,
        riskPct: s?.riskPct ?? DEFAULT_USER_RISK_PCT,
        stats: myStats,
        trades: myTrades,
        account,
      },
      limits: { minRisk: MIN_USER_RISK_PCT, maxRisk: MAX_USER_RISK_PCT },
    });
  } catch (e) { return fail(e); }
}

// Личные:
//   { action: "enable", enabled } — торговать ботом на мой капитал
//   { action: "risk", riskPct }   — мой риск на сделку
//   { action: "reset", confirm: "RESET" } — стереть мою историю по боту
// Только админ:
//   { action: "scan" } — скан прямо сейчас
//   { action: "config", scanMinutes } — период скана
//   { action: "resetAll", confirm: "RESET" } — стереть общую историю сигналов
export async function POST(req: NextRequest) {
  const r = resolve(req);
  if (!r) return NextResponse.json({ error: "Неизвестный бот" }, { status: 404 });
  const { slug, defaults } = r.rt;
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const body = await req.json().catch(() => ({}));

    if (body.action === "enable") {
      await setUserBot(user.id, slug, { enabled: Boolean(body.enabled) });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "risk") {
      const riskPct = Number(body.riskPct);
      if (!Number.isFinite(riskPct) || riskPct < MIN_USER_RISK_PCT || riskPct > MAX_USER_RISK_PCT) {
        return fail(new Error(`Риск — от ${MIN_USER_RISK_PCT}% до ${MAX_USER_RISK_PCT}%`), 400);
      }
      await setUserBot(user.id, slug, { riskPct });
      return NextResponse.json({ ok: true });
    }

    // Личный сброс: стираются только мои сделки по этому боту, включая открытые
    if (body.action === "reset") {
      if (body.confirm !== "RESET") return fail(new Error("Сброс не подтверждён"), 400);
      const removed = await wipeUserTrades(user.id, slug);
      return NextResponse.json({ ok: true, removed });
    }

    if (!user.isAdmin) return fail(new Error("Только для админа"), 403);

    if (body.action === "config") {
      // Минута — для ботов на одной паре: там скан это один запрос к бирже,
      // зато вход происходит сразу по закрытию свечи
      const cfg = await getBotConfig(slug, defaults);
      const scanMinutes = Math.max(1, Math.min(240, Number(body.scanMinutes ?? cfg.scanMinutes)));
      await saveBotConfig(slug, { ...cfg, scanMinutes });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "scan") {
      const report = await tickBot(slug, { forceScan: true });
      return NextResponse.json({ ok: true, report });
    }

    // Общий сброс: сигналы удаляются безвозвратно вместе со всеми личными
    // сделками по ним, без сообщений в каналы
    if (body.action === "resetAll") {
      if (body.confirm !== "RESET") return fail(new Error("Сброс не подтверждён"), 400);
      const removed = await wipeBotSetups(slug);
      return NextResponse.json({ ok: true, removed });
    }

    return fail(new Error("Неизвестное действие"), 400);
  } catch (e) { return fail(e); }
}
