// Тексты телеграм-сообщений мемкоин-бота. Торговля ручная и спотовая: ни плеча,
// ни биржевых стопов — бот присылает «покупай», ведёт позицию сам и присылает
// «выходи». Поэтому в сообщениях нет инструкций для терминала, только суть.

import { dexScreenerUrl } from "./geckoterminal";
import type { PrepumpSignal } from "./strategyPrepump";
import type { BotSetup } from "./types";

// Цена мемкоина бывает крошечной (0.00000000123). toPrecision даёт научную
// запись — разворачиваем её в читаемый вид с нужным числом значащих цифр.
export function fmtTiny(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return "—";
  if (p === 0) return "0";
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  const s = p.toPrecision(4);
  if (!s.includes("e")) return s;
  // Разворачиваем экспоненту: 1.234e-8 → 0.00000001234
  const neg = p < 0;
  const abs = Math.abs(p);
  const str = abs.toFixed(20).replace(/0+$/, "");
  return (neg ? "-" : "") + str;
}

const usd0 = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const gainPct = (g: number) => `${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%`;

// Сигнал на вход — «покупай сейчас»
export function dexEntryAlert(sig: PrepumpSignal): string {
  const p = sig.pool;
  const ageH = (Date.now() - p.createdMs) / 3_600_000;
  return [
    `🚀 РАННИЙ СИГНАЛ — ПОКУПАЙ СЕЙЧАС`,
    `#${p.symbol} · ${p.net} · спот, вручную`,
    ``,
    `💰 Цена входа: ${fmtTiny(sig.entry)}`,
    `🎯 Ориентир: ${fmtTiny(sig.target)} (+100%) · отметка ${fmtTiny(sig.milestone)} (+50%)`,
    `📊 Ликвидность ${usd0(p.liqUsd)} · кап ${usd0(p.marketCap)} · возраст ${ageH.toFixed(1)}ч`,
    `⚡ Разгон объёма ×${sig.metrics.volAccel} · покупки ${Math.round(sig.metrics.buyR5 * 100)}% · час ${gainPct(p.priceChange.h1 / 100)}`,
    ``,
    `Почему сейчас: ${sig.reasons.entry}`,
    ``,
    `📈 График: ${dexScreenerUrl(p)}`,
    ``,
    `⚠️ Мемкоин — высокий риск. Заходи только на сумму, которую готов потерять. `
    + `Стоп на бирже не ставь: бот сам следит за ценой и пришлёт «ВЫХОДИ» — `
    + `по цели, по откату от пика или если идея не сыграет.`,
  ].join("\n");
}

// Пройдена отметка +50%
export function dexMilestoneAlert(s: BotSetup, price: number): string {
  return [
    `🚀 +50% по #${s.symbol}`,
    `Вход ${fmtTiny(s.entryPrice)} → сейчас ${fmtTiny(price)}`,
    `Можешь снять часть и убрать риск. Остаток веду дальше — до цели +100% `
    + `или до сигнала на выход по откату.`,
  ].join("\n");
}

// Достигнут ориентир +100%
export function dexTargetAlert(s: BotSetup, price: number): string {
  return [
    `🎯 +100% по #${s.symbol} — ЦЕЛЬ ВЗЯТА`,
    `Вход ${fmtTiny(s.entryPrice)} → сейчас ${fmtTiny(price)}`,
    `План выполнен — зафиксируй бОльшую часть. Остаток веду по пику: `
    + `пришлю «ВЫХОДИ», как только начнётся заметный откат.`,
  ].join("\n");
}

// Сигнал на выход
export function dexExitAlert(s: BotSetup, price: number, reason: string): string {
  const g = price / s.entryPrice - 1;
  const head = g >= 0 ? "🏁 ВЫХОДИ — ФИКСИРУЙ" : "🛑 ВЫХОДИ";
  return [
    `${head} #${s.symbol}`,
    `Вход ${fmtTiny(s.entryPrice)} → выход ${fmtTiny(price)} (${gainPct(g)})`,
    reason,
  ].join("\n");
}
