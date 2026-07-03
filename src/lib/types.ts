export type TF =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "12h" | "1d";

export const TIMEFRAMES: TF[] = [
  "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d",
];

export const TF_MS: Record<TF, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "12h": 43_200_000,
  "1d": 86_400_000,
};

export type Direction = "LONG" | "SHORT";

export interface RsiRule {
  type: "rsi";
  tf: TF;
  period: number; // обычно 14
  op: "lte" | "gte";
  value: number;
}

export interface MacdRule {
  type: "macd";
  tf: TF;
  candles: number; // сколько разворотных баров гистограммы подряд
}

export type EmaCondition = "price_above" | "price_below" | "cross_up" | "cross_down";

export interface EmaRule {
  type: "ema";
  tf: TF;
  period: number;
  condition: EmaCondition;
}

export type Rule = RsiRule | MacdRule | EmaRule;

export type ExitRule =
  | { type: "percent"; value: number } // % движения цены (без плеча)
  | { type: "rsi"; tf: TF; period: number; value: number };

export interface TraderConfig {
  symbol: string;
  direction: Direction;
  leverage: number;
  timeframe: TF; // базовый ТФ трейдера
  rules: Rule[];
  stopLoss: ExitRule;
  takeProfit: ExitRule;
  maxHoldHours?: number | null; // закрыть по рынку через N часов (null = без лимита)
}

export type TraderStatus = "RUNNING" | "PAUSED";

export interface Trader extends TraderConfig {
  id: string;
  name: string;
  status: TraderStatus;
  lastEntryCandle: number; // openTime базовой свечи последнего входа
  createdAt: string;
}

export interface TraderStats {
  total: number;
  open: number;
  tp: number;
  sl: number;
  time: number; // закрыто по лимиту времени
  profitPct: number; // суммарный профит в % с учётом плеча
}

export type SignalStatus = "OPEN" | "TP" | "SL" | "TIME";

export interface Signal {
  id: string;
  traderId: string;
  symbol: string;
  direction: Direction;
  leverage: number;
  entryPrice: number;
  entryTime: string;
  stopPrice: number | null; // null если стоп по RSI
  takePrice: number | null;
  status: SignalStatus;
  exitPrice: number | null;
  exitTime: string | null;
  profitPct: number | null;
  config: TraderConfig & { name: string };
  lastCheckedMs: number;
}

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface BacktestTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number | null;
  exitPrice: number | null;
  result: "TP" | "SL" | "TIME" | "OPEN";
  profitPct: number | null;
}

export interface BacktestResult {
  days: number;
  candles: number;
  trades: BacktestTrade[];
  stats: {
    total: number;
    tp: number;
    sl: number;
    time: number;
    open: number;
    winRate: number; // 0..100: доля закрытых с профитом > 0
    profitPct: number; // сумма % с плечом
  };
}
