import { NextRequest, NextResponse } from "next/server";
import { getAccount } from "@/lib/account";
import { isResponse, requireUser } from "@/lib/auth";
import { futuresBalance } from "@/lib/bingxPrivate";
import { CUSTOM_BOTS } from "@/lib/customBots";
import {
  clearUserKeys, DEFAULT_USER_RISK_PCT, getUserSecretEnc, MAX_USER_RISK_PCT, MIN_USER_RISK_PCT,
  setUserBingxBalance, setUserBot, setUserCapital, setUserKeys, userBotSettings,
} from "@/lib/dbUsers";
import { decryptSecret, encryptSecret, maskKey } from "@/lib/secrets";

export const dynamic = "force-dynamic";

const fail = (e: unknown, status = 500) => NextResponse.json(
  { error: e instanceof Error ? e.message : String(e) }, { status },
);

// Профиль: кто я, мой счёт, ключ BingX (только маской) и мои боты
export async function GET() {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const [account, settings] = await Promise.all([getAccount(user), userBotSettings(user.id)]);
    return NextResponse.json({
      user: {
        email: user.email, isAdmin: user.isAdmin,
        capital: user.capital, capitalSetAt: user.capitalSetAt,
        apiKey: maskKey(user.apiKey), hasSecret: user.hasSecret,
        bingxBalance: user.bingxBalance, bingxCheckedAt: user.bingxCheckedAt,
      },
      account,
      bots: CUSTOM_BOTS.map((b) => {
        const s = settings.get(b.slug);
        return {
          slug: b.slug, name: b.name,
          enabled: s?.enabled ?? false, riskPct: s?.riskPct ?? DEFAULT_USER_RISK_PCT,
        };
      }),
      limits: { minRisk: MIN_USER_RISK_PCT, maxRisk: MAX_USER_RISK_PCT },
    });
  } catch (e) { return fail(e); }
}

// { action: "capital", capital } — новая сумма становится текущим балансом
// { action: "keys", apiKey, secret } — сохранить ключ BingX (секрет шифруется)
// { action: "deleteKeys" }
// { action: "checkKeys" } — запросить баланс фьючерсного счёта BingX
// { action: "bot", bot, enabled?, riskPct? } — торговать ботом на мой капитал
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    const body = await req.json().catch(() => ({}));

    if (body.action === "capital") {
      const capital = Number(body.capital);
      if (!Number.isFinite(capital) || capital < 0 || capital > 10_000_000) {
        return fail(new Error("Капитал — число от 0"), 400);
      }
      await setUserCapital(user.id, Math.round(capital * 100) / 100);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "keys") {
      const apiKey = String(body.apiKey ?? "").trim();
      const secret = String(body.secret ?? "").trim();
      if (apiKey.length < 10 || secret.length < 10) return fail(new Error("Нужны API Key и Secret Key"), 400);
      await setUserKeys(user.id, apiKey, encryptSecret(secret));
      return NextResponse.json({ ok: true });
    }

    if (body.action === "deleteKeys") {
      await clearUserKeys(user.id);
      return NextResponse.json({ ok: true });
    }

    if (body.action === "checkKeys") {
      const k = await getUserSecretEnc(user.id);
      if (!k) return fail(new Error("Сначала сохрани API-ключ"), 400);
      try {
        const b = await futuresBalance(k.apiKey, decryptSecret(k.secretEnc));
        await setUserBingxBalance(user.id, b.balance);
        return NextResponse.json({ ok: true, balance: b });
      } catch (e) {
        return fail(new Error(`BingX не принял ключ: ${e instanceof Error ? e.message : String(e)}`), 400);
      }
    }

    if (body.action === "bot") {
      const bot = String(body.bot ?? "");
      if (!CUSTOM_BOTS.some((b) => b.slug === bot)) return fail(new Error("Неизвестный бот"), 400);
      let riskPct: number | undefined;
      if (body.riskPct !== undefined) {
        riskPct = Number(body.riskPct);
        if (!Number.isFinite(riskPct) || riskPct < MIN_USER_RISK_PCT || riskPct > MAX_USER_RISK_PCT) {
          return fail(new Error(`Риск — от ${MIN_USER_RISK_PCT}% до ${MAX_USER_RISK_PCT}%`), 400);
        }
      }
      const enabled = body.enabled === undefined ? undefined : Boolean(body.enabled);
      await setUserBot(user.id, bot, { enabled, riskPct });
      return NextResponse.json({ ok: true });
    }

    return fail(new Error("Неизвестное действие"), 400);
  } catch (e) { return fail(e); }
}
