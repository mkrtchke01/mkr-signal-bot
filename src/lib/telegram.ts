import { activeChannelIds } from "./db";
import { signalCloseCaption, signalOpenCaption } from "./format";
import type { Signal } from "./types";

const API = "https://api.telegram.org";

export function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

export function appUrl(): string | null {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const v = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return v ? `https://${v}` : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function tg(method: string, payload: Record<string, any>): Promise<any> {
  const token = botToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
  return json.result;
}

async function sendCard(chatId: string, photoUrl: string | null, caption: string): Promise<void> {
  if (photoUrl) {
    try {
      await tg("sendPhoto", { chat_id: chatId, photo: photoUrl, caption });
      return;
    } catch {
      // если Telegram не смог скачать картинку — шлём текстом
    }
  }
  await tg("sendMessage", { chat_id: chatId, text: caption });
}

export async function broadcastSignalOpen(s: Signal): Promise<string[]> {
  return broadcast(s, "open", signalOpenCaption(s));
}

export async function broadcastSignalClose(s: Signal): Promise<string[]> {
  return broadcast(s, "closed", signalCloseCaption(s));
}

async function broadcast(s: Signal, state: string, caption: string): Promise<string[]> {
  if (!botToken()) return ["TELEGRAM_BOT_TOKEN не задан — сигнал не отправлен"];
  const channels = await activeChannelIds();
  if (!channels.length) return ["Нет подключённых каналов — сигнал не отправлен"];
  const base = appUrl();
  const photoUrl = base ? `${base}/api/og/signal?id=${s.id}&state=${state}` : null;
  const errors: string[] = [];
  for (const chatId of channels) {
    try {
      await sendCard(chatId, photoUrl, caption);
    } catch (e) {
      errors.push(`chat ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errors;
}
