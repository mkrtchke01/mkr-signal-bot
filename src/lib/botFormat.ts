// Тексты телеграм-сообщений трейдер-бота: сетап публикуется заранее
// с уровнями и обоснованием, дальше бот сопровождает позицию.

import { fmtPct, fmtPrice } from "./format";
import type { BotSetup } from "./types";

function dirBadge(s: BotSetup): string {
  return s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
}

function stopPct(s: BotSetup): string {
  const move = (s.initialStop / s.entryPrice - 1) * 100;
  return fmtPct(Math.round(move * 100) / 100);
}

export function botSetupCaption(s: BotSetup): string {
  return [
    `🤖 СЕТАП ${dirBadge(s)} #${s.symbol}`,
    ``,
    `📍 Лимитка: ${fmtPrice(s.entryPrice)}`,
    `🛑 Стоп: ${fmtPrice(s.initialStop)} (${stopPct(s)})`,
    `🎯 TP1: ${fmtPrice(s.tp1)} (RR ${s.rr1}) — фикс 50% + стоп в безубыток`,
    `🏁 TP2: ${fmtPrice(s.tp2)} (RR ${s.rr2})`,
    ``,
    `Почему вход: ${s.reasons.entry}`,
    `Почему стоп: ${s.reasons.stop}`,
    `TP1: ${s.reasons.tp1}`,
    `TP2: ${s.reasons.tp2}`,
    ``,
    `⚠️ Стоп ставится сразу вместе с лимиткой. Если цена дойдёт до TP1 без`,
    `налива или сменится режим BTC — сетап будет отменён отдельным сообщением.`,
  ].join("\n");
}

export function botFilledCaption(s: BotSetup): string {
  return [
    `⚡ ВХОД ${dirBadge(s)} #${s.symbol}`,
    `Лимитка налита: ${fmtPrice(s.entryPrice)}`,
    `🛑 Стоп: ${fmtPrice(s.stopPrice)}`,
    `🎯 TP1: ${fmtPrice(s.tp1)} → 🏁 TP2: ${fmtPrice(s.tp2)}`,
  ].join("\n");
}

export function botTp1Caption(s: BotSetup): string {
  return [
    `🎯 TP1 ДОСТИГНУТ ${dirBadge(s)} #${s.symbol}`,
    `Зафиксировано 50% по ${fmtPrice(s.tp1)} (RR ${s.rr1}).`,
    `Стоп перенесён в безубыток: ${fmtPrice(s.entryPrice)}.`,
    `Остаток едет к TP2 ${fmtPrice(s.tp2)}.`,
  ].join("\n");
}

export function botCloseCaption(s: BotSetup): string {
  const head = {
    TP: `✅ TP2 ВЗЯТ`,
    SL: `⛔ СТОП`,
    BE: `🟨 БЕЗУБЫТОК`,
    CANCELLED: `✖️ СЕТАП ОТМЕНЁН`,
    EXPIRED: `⌛ СЕТАП ИСТЁК`,
  }[s.status as "TP" | "SL" | "BE" | "CANCELLED" | "EXPIRED"] ?? `Закрыт`;
  const lines = [`${head} ${dirBadge(s)} #${s.symbol}`];
  if (s.status === "TP" || s.status === "SL" || s.status === "BE") {
    lines.push(`Вход: ${fmtPrice(s.entryPrice)} → Выход: ${fmtPrice(s.exitPrice)}`);
    lines.push(`Результат: ${fmtPct(s.profitPct)} движения цены (без плеча)`);
  }
  if (s.closeReason) lines.push(s.closeReason);
  return lines.join("\n");
}
