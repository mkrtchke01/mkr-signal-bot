// Тексты телеграм-сообщений кастомных ботов: сигнал публикуется в момент,
// когда вход актуален, — вход по рынку сразу, дальше бот сопровождает позицию.
// Цели и стоп подписаны деньгами: риск на сделку фиксирован, плечо и объём
// рассчитаны так, чтобы стоп стоил ровно эту сумму вместе с комиссиями Bybit.

import { fmtMoney, fmtPct, fmtPrice, fmtUsd } from "./format";
import type { BotSetup, TradePlan } from "./types";

function dirBadge(s: BotSetup): string {
  return s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
}

// Блок с плечом, объёмом и ликвидацией — то, что нужно ввести на бирже
function planLines(p: TradePlan): string[] {
  const gap = p.stopPct > 0 ? (p.liqPct / p.stopPct).toFixed(1) : "—";
  return [
    `💵 Плечо ×${p.leverage} (изолированная) · маржа ${fmtMoney(p.margin)} `
    + `· объём ${fmtMoney(p.notional)}`,
    `🧯 Ликвидация ~${fmtPrice(p.liqPrice)} (${p.liqPct.toFixed(2)}% от входа) — `
    + `в ${gap} раза дальше стопа, до неё дело не дойдёт`,
    `🧾 Риск ${fmtMoney(p.riskUsd)} на сделку — комиссия Bybit `
    + `(тейкер ${(p.feeRate * 100).toFixed(3)}% × 2 ≈ ${fmtMoney(p.feeUsd)}) уже учтена`,
  ];
}

export function botSetupCaption(s: BotSetup): string {
  const p = s.plan;
  const money = (v: number | undefined) => (v === undefined ? "" : ` → ${fmtUsd(v)}`);
  return [
    `🚀 ПРОБОЙ ${dirBadge(s)} #${s.symbol} — ВХОД СЕЙЧАС`,
    ``,
    `⚡ Вход по рынку: ${fmtPrice(s.entryPrice)} (текущая цена)`,
    `🛑 Стоп: ${fmtPrice(s.initialStop)}`
      + (p ? ` (${p.stopPct.toFixed(2)}% от входа)` : "") + money(p?.pnl.sl),
    `🎯 TP1: ${fmtPrice(s.tp1)} (${s.rr1}R)${money(p?.pnl.tp1)}`
      + ` — фикс 50% + стоп в безубыток`,
    `🏁 TP2: ${fmtPrice(s.tp2)} (${s.rr2}R)${money(p?.pnl.tp2)} суммарно`,
    ...(p ? [``, ...planLines(p)] : []),
    ``,
    `Почему вход: ${s.reasons.entry}`,
    `Почему стоп: ${s.reasons.stop}`,
    `TP1: ${s.reasons.tp1}`,
    `TP2: ${s.reasons.tp2}`,
    ``,
    `⚠️ Стратегия трендовая: большинство сделок — небольшие минусы, заработок `
      + `приносят редкие длинные движения. Смысл есть только на дистанции.`,
  ].join("\n");
}

export function botTp1Caption(s: BotSetup): string {
  const p = s.plan;
  return [
    `🎯 TP1 ДОСТИГНУТ ${dirBadge(s)} #${s.symbol}`,
    `Зафиксировано 50% по ${fmtPrice(s.tp1)} (${s.rr1}R)`
      + (p ? ` → ${fmtUsd(p.pnl.tp1)}` : ""),
    `Стоп перенесён в безубыток: ${fmtPrice(s.entryPrice)}`
      + (p ? ` — минимальный итог сделки теперь ${fmtUsd(p.pnl.be)}.` : "."),
    `Остаток едет к TP2 ${fmtPrice(s.tp2)}`
      + (p ? `: ещё ${fmtUsd(p.pnl.tp2 - p.pnl.tp1)} при исполнении.` : "."),
  ].join("\n");
}

export function botCloseCaption(s: BotSetup): string {
  const head = {
    TP: `✅ TP2 ВЗЯТ`,
    SL: `⛔ СТОП`,
    BE: `🟨 БЕЗУБЫТОК`,
    TIME: `⌛ ЗАКРЫТ ПО ВРЕМЕНИ`,
    CANCELLED: `✖️ ЗАКРЫТ ВРУЧНУЮ`,
  }[s.status as Exclude<BotSetup["status"], "OPEN">] ?? `Закрыт`;
  const lines = [`${head} ${dirBadge(s)} #${s.symbol}`];
  if (s.exitPrice !== null) {
    lines.push(`Вход: ${fmtPrice(s.entryPrice)} → Выход: ${fmtPrice(s.exitPrice)}`);
    if (s.profitUsd !== null) {
      lines.push(`💰 Итог: ${fmtUsd(s.profitUsd)}`
        + (s.plan ? ` (плечо ×${s.plan.leverage}, комиссии учтены)` : ""));
    }
    lines.push(`Движение цены: ${fmtPct(s.profitPct)}`);
  }
  if (s.closeReason) lines.push(s.closeReason);
  return lines.join("\n");
}
