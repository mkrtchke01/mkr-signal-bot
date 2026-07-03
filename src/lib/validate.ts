import type { ExitRule, Rule, TF, TraderConfig } from "./types";
import { TIMEFRAMES } from "./types";

export class ValidationError extends Error {}

function isTf(v: unknown): v is TF {
  return typeof v === "string" && (TIMEFRAMES as string[]).includes(v);
}

function num(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${name}: ожидается число от ${min} до ${max}`);
  }
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseRule(raw: any): Rule {
  if (!raw || typeof raw !== "object") throw new ValidationError("Некорректное правило");
  if (!isTf(raw.tf)) throw new ValidationError("Правило: некорректный таймфрейм");
  switch (raw.type) {
    case "rsi":
      if (raw.op !== "lte" && raw.op !== "gte") throw new ValidationError("RSI: условие должно быть ≤ или ≥");
      return {
        type: "rsi", tf: raw.tf,
        period: Math.round(num(raw.period ?? 14, "RSI период", 2, 100)),
        op: raw.op,
        value: num(raw.value, "RSI значение", 1, 99),
      };
    case "macd":
      return {
        type: "macd", tf: raw.tf,
        candles: Math.round(num(raw.candles, "MACD свечи", 1, 20)),
      };
    case "ema":
      if (!["price_above", "price_below", "cross_up", "cross_down"].includes(raw.condition)) {
        throw new ValidationError("EMA: некорректное условие");
      }
      return {
        type: "ema", tf: raw.tf,
        period: Math.round(num(raw.period, "EMA период", 2, 500)),
        condition: raw.condition,
      };
    default:
      throw new ValidationError(`Неизвестный тип правила: ${raw.type}`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseExit(raw: any, name: string): ExitRule {
  if (!raw || typeof raw !== "object") throw new ValidationError(`${name}: не задан`);
  if (raw.type === "percent") {
    return { type: "percent", value: num(raw.value, `${name} %`, 0.05, 500) };
  }
  if (raw.type === "rsi") {
    if (!isTf(raw.tf)) throw new ValidationError(`${name}: некорректный таймфрейм`);
    return {
      type: "rsi", tf: raw.tf,
      period: Math.round(num(raw.period ?? 14, `${name} RSI период`, 2, 100)),
      value: num(raw.value, `${name} RSI значение`, 1, 99),
    };
  }
  throw new ValidationError(`${name}: тип должен быть percent или rsi`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseTraderPayload(raw: any): { name: string; config: TraderConfig } {
  if (!raw || typeof raw !== "object") throw new ValidationError("Пустой запрос");
  const name = String(raw.name ?? "").trim();
  if (!name || name.length > 60) throw new ValidationError("Имя трейдера: 1–60 символов");
  const symbol = String(raw.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) throw new ValidationError("Некорректный символ монеты");
  if (raw.direction !== "LONG" && raw.direction !== "SHORT") {
    throw new ValidationError("Направление: LONG или SHORT");
  }
  if (!isTf(raw.timeframe)) throw new ValidationError("Некорректный базовый таймфрейм");
  const rules = Array.isArray(raw.rules) ? raw.rules.map(parseRule) : [];
  if (!rules.length) throw new ValidationError("Добавь хотя бы одно правило входа");
  if (rules.length > 10) throw new ValidationError("Максимум 10 правил");
  return {
    name,
    config: {
      symbol,
      direction: raw.direction,
      leverage: Math.round(num(raw.leverage, "Плечо", 1, 125)),
      timeframe: raw.timeframe,
      rules,
      stopLoss: parseExit(raw.stopLoss, "Стоп-лосс"),
      takeProfit: parseExit(raw.takeProfit, "Тейк-профит"),
    },
  };
}
