import { NextRequest, NextResponse } from "next/server";
import { removeChannel, upsertChannel } from "@/lib/db";
import { appUrl, tg } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// Вебхук Telegram: регистрирует каналы/группы, куда добавили бота
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const update = await req.json();

  try {
    const mcm = update.my_chat_member;
    if (mcm?.chat) {
      const chat = mcm.chat;
      const status = mcm.new_chat_member?.status;
      const isChannelOrGroup = ["channel", "group", "supergroup"].includes(chat.type);
      if (isChannelOrGroup) {
        if (["administrator", "member"].includes(status)) {
          await upsertChannel(String(chat.id), chat.title ?? "", chat.type);
        } else if (["left", "kicked"].includes(status)) {
          await removeChannel(String(chat.id));
        }
      }
    }

    // /start в личке — короткая справка
    const msg = update.message;
    if (msg?.chat?.type === "private" && typeof msg.text === "string" && msg.text.startsWith("/start")) {
      const base = appUrl();
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: `Привет! Я шлю торговые сигналы твоих трейдеров.\n\n`
          + `1. Добавь меня в канал или группу как администратора — сигналы пойдут туда.\n`
          + `2. Управление трейдерами: ${base ?? "открой веб-интерфейс"}`,
      });
    }
  } catch (e) {
    // Telegram ретраит при не-200, поэтому всегда отвечаем ok,
    // но ошибку пишем в логи Vercel
    console.error("telegram webhook error:", e);
  }
  return NextResponse.json({ ok: true });
}
