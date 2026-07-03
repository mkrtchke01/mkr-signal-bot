import { NextRequest, NextResponse } from "next/server";
import { appUrl, tg } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Разовая настройка вебхука: GET /api/telegram/setup?secret=CRON_SECRET
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.nextUrl.searchParams.get("secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const base = appUrl();
  if (!base) {
    return NextResponse.json({ error: "APP_URL не определён" }, { status: 500 });
  }
  try {
    await tg("setWebhook", {
      url: `${base}/api/telegram/webhook`,
      secret_token: secret,
      allowed_updates: ["message", "my_chat_member"],
    });
    const me = await tg("getMe", {});
    return NextResponse.json({
      ok: true,
      bot: `@${me.username}`,
      webhook: `${base}/api/telegram/webhook`,
      next: "Добавь бота в канал как администратора — канал зарегистрируется сам.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
