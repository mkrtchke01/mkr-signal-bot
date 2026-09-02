// Тексты телеграм-сообщений бота. Сигнал содержит готовую инструкцию для биржи:
// всё выставляется один раз сразу после входа и дальше не трогается.
// Биржа у каждого бота своя — она приходит в CaptionStyle вместе с шапкой.

import { fmtMoney, fmtPct, fmtPrice, fmtUsd } from "./format";
import { BYBIT } from "./market";
import type { MarketData } from "./market";
import type { BotSetup, TradePlan } from "./types";

const pct3 = (v: number) => `${(v * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;

function dirBadge(s: BotSetup): string {
  return s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
}

// Блок с плечом, объёмом и ликвидацией — то, что нужно ввести на бирже
function planLines(p: TradePlan, ex: MarketData): string[] {
  const gap = p.stopPct > 0 ? (p.liqPct / p.stopPct).toFixed(1) : "—";
  return [
    `💵 Плечо ×${p.leverage} (изолированная) · маржа ${fmtMoney(p.margin)} `
    + `· объём ${fmtMoney(p.notional)}`,
    `🧯 Ликвидация ~${fmtPrice(p.liqPrice)} (${p.liqPct.toFixed(2)}% от входа) — `
    + `в ${gap} раза дальше стопа, до неё дело не дойдёт`,
    `🧾 Риск ${fmtMoney(p.riskUsd)} на сделку — комиссия ${ex.name} `
    + `(тейкер ${pct3(p.feeRate)} × 2 ≈ ${fmtMoney(p.feeUsd)}) уже учтена`,
  ];
}

// Трейлинг может включаться на том же уровне, где фиксируется половина
// (стратегии импульса), либо заметно дальше (пробойная) — тексты разные.
function trailAtTp1(s: BotSetup): boolean {
  return Math.abs(s.activateAt - s.tp1) < 1e-9;
}

// Инструкция «поставил и забыл»: три экрана биржи, дальше позиция ведёт себя сама
export function exchangeSetupLines(s: BotSetup, ex: MarketData): string[] {
  // Без частичной фиксации всё проще: стоп и тейк на весь объём, и это всё
  if (s.tpFull) {
    return [
      `⚙️ КАК ВЫСТАВИТЬ НА ${ex.name.toUpperCase()} (один раз, потом не трогаем)`,
      ``,
      `1) Вход по рынку${s.plan ? `, плечо ×${s.plan.leverage}, изолированная маржа` : ""}.`,
      `2) В позиции открой «TP/SL» → на весь объём:`,
      `   • Стоп-лосс: ${fmtPrice(s.initialStop)}`,
      `   • Тейк-профит: ${fmtPrice(s.tp1)}`,
      ``,
      `Дальше ничего менять не надо: биржа сама закроет позицию по одной из цен.`,
      `Тейк лучше поставить лимитным ордером — комиссия мейкера ${pct3(ex.makerFee)}`,
      `вместо ${pct3(ex.takerFee)} по рынку, на коротком стопе эта разница заметна.`,
    ];
  }
  return [
    `⚙️ КАК ВЫСТАВИТЬ НА ${ex.name.toUpperCase()} (один раз, потом не трогаем)`,
    ``,
    `1) Вход по рынку${s.plan ? `, плечо ×${s.plan.leverage}, изолированная маржа` : ""}.`,
    `2) В позиции открой «TP/SL» → режим «Частичная позиция»:`,
    `   • Стоп-лосс: ${fmtPrice(s.initialStop)} — на весь объём`,
    `   • Тейк-профит: ${fmtPrice(s.tp1)} — на 50% объёма`,
    `3) Там же колонка «Скользящий стоп-ордер» → «+ Добавить»:`,
    `   • Коррекция: ${fmtPrice(s.trailAbs)} (режим «По сумме»)`,
    `   • Цена активации: ✅ ${fmtPrice(s.activateAt)}`,
    ``,
    ...(trailAtTp1(s)
      ? [`Дальше ничего менять не надо. На ${fmtPrice(s.tp1)} половина фиксируется,`,
        `и там же остаток подхватывает трейлинг — он сам закроет его на откате.`]
      : [`Дальше ничего менять не надо. Половина фиксируется на ${fmtPrice(s.tp1)},`,
        `а если цена дойдёт до ${fmtPrice(s.activateAt)} — остаток подхватит трейлинг`,
        `и сам закроется на откате.`]),
  ];
}

export interface CaptionStyle {
  head: string;            // шапка сигнала: у каждого бота своя
  note: string;            // предупреждение в конце — про характер стратегии
  exchange?: MarketData;   // где торгуем; по умолчанию Bybit
}

export function botSetupCaption(s: BotSetup, style: CaptionStyle): string {
  const p = s.plan;
  const ex = style.exchange ?? BYBIT;
  const money = (v: number | undefined) => (v === undefined ? "" : ` → ${fmtUsd(v)}`);
  return [
    `${style.head} ${dirBadge(s)} #${s.symbol} — ВХОД СЕЙЧАС`,
    ``,
    `⚡ Вход по рынку: ${fmtPrice(s.entryPrice)} (текущая цена)`,
    `🛑 Стоп: ${fmtPrice(s.initialStop)}`
      + (p ? ` (${p.stopPct.toFixed(2)}% от входа)` : "") + money(p?.pnl.sl),
    ...(s.tpFull
      ? [`🎯 Тейк: ${fmtPrice(s.tp1)} (${s.rr1}R)${money(p?.pnl.tpFull)} — выход целиком`]
      : [
        `🎯 TP1: ${fmtPrice(s.tp1)} (${s.rr1}R)${money(p?.pnl.tp1)} — фикс 50%`,
        `📈 Остаток: трейлинг с шагом ${fmtPrice(s.trailAbs)}, `
          + (trailAtTp1(s) ? `включается там же` : `включается на ${fmtPrice(s.activateAt)}`),
      ]),
    ...(p ? [``, ...planLines(p, ex)] : []),
    ``,
    ...exchangeSetupLines(s, ex),
    ``,
    `Почему вход: ${s.reasons.entry}`,
    `Почему стоп: ${s.reasons.stop}`,
    ...(s.tpFull
      ? [`Почему тейк: ${s.reasons.tp1}`]
      : [`TP1: ${s.reasons.tp1}`, `Трейлинг: ${s.reasons.trail}`]),
    ``,
    style.note,
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
    trailAtTp1(s)
      ? `Остаток уже под трейлингом с шагом ${fmtPrice(s.trailAbs)} — он закроет `
        + `позицию сам на откате. Делать ничего не нужно.`
      : `Остаток идёт к ${fmtPrice(s.activateAt)} — там подхватит трейлинг. `
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
    ...(s.tpFull
      ? [
        `   • Тейк-профит: ${fmtPrice(s.tp1)} — на весь объём (${s.rr1}R)`,
        `   • Стоп-лосс ${fmtPrice(s.initialStop)} оставь как есть`,
      ]
      : [
        `   • Тейк-профит: ${fmtPrice(s.tp1)} — на 50% объёма (${s.rr1}R)`,
        `   • Скользящий стоп: коррекция ${fmtPrice(s.trailAbs)}, `
          + `цена активации ${fmtPrice(s.activateAt)}`,
        `   • Стоп-лосс ${fmtPrice(s.initialStop)} оставь как есть`,
        ``,
        `Если старый скользящий стоп-ордер уже стоит — удали его и добавь заново `
          + `с новой ценой активации.`,
      ]),
  ].join("\n");
}

export function botCloseCaption(s: BotSetup): string {
  const head = {
    TP: `🎯 ТЕЙК ВЗЯТ`,
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
    lines.push(s.tpFull
      ? `❗ Закрой позицию по рынку руками и сними стоп с тейком.`
      : `❗ Закрой остаток по рынку руками и сними скользящий стоп-ордер.`);
  }
  return lines.join("\n");
}
