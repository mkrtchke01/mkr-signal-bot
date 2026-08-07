// Тексты телеграм-сообщений бота. Сигнал содержит готовую инструкцию для Bybit:
// всё выставляется один раз сразу после входа и дальше не трогается.

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

// Инструкция «поставил и забыл»: три экрана Bybit, дальше позиция ведёт себя сама
export function bybitSetupLines(s: BotSetup): string[] {
  return [
    `⚙️ КАК ВЫСТАВИТЬ НА BYBIT (один раз, потом не трогаем)`,
    ``,
    `1) Вход по рынку${s.plan ? `, плечо ×${s.plan.leverage}, изолированная маржа` : ""}.`,
    `2) В позиции открой «TP/SL» → режим «Частичная позиция»:`,
    `   • Стоп-лосс: ${fmtPrice(s.initialStop)} — на весь объём`,
    `   • Тейк-профит: ${fmtPrice(s.tp1)} — на 50% объёма`,
    `3) Там же колонка «Скользящий стоп-ордер» → «+ Добавить»:`,
    `   • Коррекция: ${fmtPrice(s.trailAbs)} (режим «По сумме»)`,
    `   • Цена активации: ✅ ${fmtPrice(s.activateAt)}`,
    ``,
    `Дальше ничего менять не надо. Половина фиксируется на ${fmtPrice(s.tp1)},`,
    `а если цена дойдёт до ${fmtPrice(s.activateAt)} — остаток подхватит трейлинг`,
    `и сам закроется на откате.`,
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
    `🎯 TP1: ${fmtPrice(s.tp1)} (${s.rr1}R)${money(p?.pnl.tp1)} — фикс 50%`,
    `📈 Остаток: трейлинг с шагом ${fmtPrice(s.trailAbs)}, `
      + `включается на ${fmtPrice(s.activateAt)}`,
    ...(p ? [``, ...planLines(p)] : []),
    ``,
    ...bybitSetupLines(s),
    ``,
    `Почему вход: ${s.reasons.entry}`,
    `Почему стоп: ${s.reasons.stop}`,
    `TP1: ${s.reasons.tp1}`,
    `Трейлинг: ${s.reasons.trail}`,
    ``,
    `⚠️ Стратегия трендовая: около половины сделок — мелкие минусы по стопу, `
      + `а основной заработок дают редкие длинные движения. Смысл есть только на дистанции.`,
  ].join("\n");
}

export function botTp1Caption(s: BotSetup): string {
  const p = s.plan;
  return [
    `🎯 TP1 ДОСТИГНУТ ${dirBadge(s)} #${s.symbol}`,
    `Зафиксировано 50% по ${fmtPrice(s.tp1)} (${s.rr1}R)`
      + (p ? ` → ${fmtUsd(p.pnl.tp1)}` : ""),
    `Сделка уже в плюсе при любом исходе: даже если остаток выбьет стопом, `
      + `итог будет${p ? ` ${fmtUsd(p.pnl.part)}` : " положительным"}.`,
    `Остаток идёт к ${fmtPrice(s.activateAt)} — там подхватит трейлинг. `
      + `Делать ничего не нужно.`,
  ].join("\n");
}

// Сетап вернули в работу: позиция на бирже жива, меняются только уровни
export function botRearmCaption(s: BotSetup): string {
  return [
    `♻️ ОБНОВЛЁННЫЕ НАСТРОЙКИ ${dirBadge(s)} #${s.symbol}`,
    ``,
    `Позиция открыта и остаётся в работе — бот ошибочно закрыл её у себя `
      + `и вернул в отслеживание. Вход ${fmtPrice(s.entryPrice)} и стоп `
      + `${fmtPrice(s.initialStop)} прежние, под них уже посчитан объём.`,
    ``,
    `Обнови на бирже только цели:`,
    `   • Тейк-профит: ${fmtPrice(s.tp1)} — на 50% объёма (${s.rr1}R)`,
    `   • Скользящий стоп: коррекция ${fmtPrice(s.trailAbs)}, `
      + `цена активации ${fmtPrice(s.activateAt)}`,
    `   • Стоп-лосс ${fmtPrice(s.initialStop)} оставь как есть`,
    ``,
    `Если старый скользящий стоп-ордер уже стоит — удали его и добавь заново `
      + `с новой ценой активации.`,
  ].join("\n");
}

export function botCloseCaption(s: BotSetup): string {
  const head = {
    TRAIL: `✅ ТРЕЙЛИНГ ЗАКРЫЛ ОСТАТОК`,
    PART: `🟩 ПЛЮС ПО ЧАСТИЧНОЙ ФИКСАЦИИ`,
    SL: `⛔ СТОП`,
    TIME: `⌛ ПОРА ВЫХОДИТЬ ПО ВРЕМЕНИ`,
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
  // Стоп и трейлинг срабатывают на бирже сами, а выход по времени — нет
  if (s.status === "TIME") {
    lines.push(`❗ Закрой остаток по рынку руками и сними скользящий стоп-ордер.`);
  }
  return lines.join("\n");
}
