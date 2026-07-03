import type { ExitRule, Rule, Signal } from "./types";

export function fmtPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return "—";
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (p >= 1) return p.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return p.toPrecision(4);
}

export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(2)}%`;
}

export function ruleLabel(r: Rule): string {
  switch (r.type) {
    case "rsi":
      return `RSI(${r.period}) ${r.op === "lte" ? "≤" : "≥"} ${r.value} @ ${r.tf}`;
    case "macd":
      return `MACD: ${r.candles} разв. свечи @ ${r.tf}`;
    case "ema": {
      const cond = {
        price_above: "цена выше",
        price_below: "цена ниже",
        cross_up: "пересечение снизу вверх",
        cross_down: "пересечение сверху вниз",
      }[r.condition];
      return `EMA(${r.period}): ${cond} @ ${r.tf}`;
    }
  }
}

export function exitLabel(e: ExitRule): string {
  return e.type === "percent"
    ? `${e.value}% движения цены`
    : `RSI(${e.period}) достигнет ${e.value} @ ${e.tf}`;
}

export function signalOpenCaption(s: Signal): string {
  const c = s.config;
  const dir = s.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  const lines = [
    `${dir} #${s.symbol} ×${s.leverage}`,
    `Трейдер: ${c.name}`,
    ``,
    `📍 Вход: ${fmtPrice(s.entryPrice)}`,
    `🎯 Тейк: ${s.takePrice !== null ? fmtPrice(s.takePrice) : exitLabel(c.takeProfit)}`,
    `🛑 Стоп: ${s.stopPrice !== null ? fmtPrice(s.stopPrice) : exitLabel(c.stopLoss)}`,
    ``,
    `Правила входа:`,
    ...c.rules.map((r) => `• ${ruleLabel(r)}`),
  ];
  return lines.join("\n");
}

export function signalCloseCaption(s: Signal): string {
  const win = (s.profitPct ?? 0) >= 0;
  const icon = s.status === "TP" ? "✅" : s.status === "TIME" ? (win ? "⏱✅" : "⏱⛔") : "⛔";
  const what = s.status === "TP" ? "ТЕЙК" : s.status === "TIME" ? "ЗАКРЫТ ПО ВРЕМЕНИ" : "СТОП";
  return [
    `${icon} ${what} #${s.symbol} ${s.direction} ×${s.leverage}`,
    `Трейдер: ${s.config.name}`,
    `Вход: ${fmtPrice(s.entryPrice)} → Выход: ${fmtPrice(s.exitPrice)}`,
    `Результат: ${fmtPct(s.profitPct)} (с плечом ×${s.leverage})`,
  ].join("\n");
}
