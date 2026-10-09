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

// Результат сделки: со знаком, чтобы плюс/минус читались с первого взгляда
export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${s}$${Math.abs(v).toFixed(2)}`;
}

// Абсолютная сумма (маржа, объём) — без знака
export function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `$${v.toFixed(2)}`;
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

// Сколько сделка прожила: минуты для скальпа, дни для позиционки
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 90) return `${m} мин`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h.toFixed(1)} ч`;
  return `${(h / 24).toFixed(1)} дн`;
}

// Ожидаемое соотношение риск/прибыль сетапа: сколько стопов до цели.
// Берём записанное ботом rr1, а у старых записей без него — считаем по уровням.
// Если остаток ведётся до второй цели (tpFinal), ожидание считаем по ней.
export function expectedRR(s: {
  entryPrice: number; initialStop: number; tp1: number; rr1?: number | null;
  tpFinal?: number | null;
}): number | null {
  const risk = Math.abs(s.entryPrice - s.initialStop);
  if (s.tpFinal && s.tpFinal > 0 && risk > 0) return Math.abs(s.tpFinal - s.entryPrice) / risk;
  if (s.rr1 && s.rr1 > 0) return s.rr1;
  if (!(risk > 0) || !Number.isFinite(s.tp1)) return null;
  return Math.abs(s.tp1 - s.entryPrice) / risk;
}

// «1:3», «1:2.5» — риск всегда единица, цель в стопах
export function fmtRR(rr: number | null | undefined): string {
  if (rr === null || rr === undefined || !Number.isFinite(rr) || rr <= 0) return "—";
  return `1:${(Math.round(rr * 10) / 10).toString()}`;
}
