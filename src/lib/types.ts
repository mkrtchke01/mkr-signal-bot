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

// ---- Трейдер-бот (стратегия с уровневыми сетапами) ----

// OPEN — в позиции (новые сетапы создаются сразу OPEN: сигнал = вход по рынку);
// TP/SL/BE — закрыт по тейку/стопу/безубытку; CANCELLED — отменён (вручную).
// Легаси старой лимиточной версии: PENDING — ждал налива лимитки,
// EXPIRED — лимитка не налилась за TTL.
export type BotSetupStatus =
  | "PENDING" | "OPEN" | "TP" | "SL" | "BE" | "CANCELLED" | "EXPIRED";

export interface BotSetup {
  id: string;
  symbol: string;
  direction: Direction;
  status: BotSetupStatus;
  entryPrice: number;
  stopPrice: number;   // текущий стоп (после TP1 переносится в безубыток)
  initialStop: number;
  tp1: number;
  tp2: number;
  rr1: number;
  rr2: number;
  reasons: { entry: string; stop: string; tp1: string; tp2: string };
  regime: string;
  tp1Done: boolean;
  createdAt: string;
  filledAt: string | null;
  closedAt: string | null;
  exitPrice: number | null;
  profitPct: number | null; // % движения цены без плеча (50/50 при частичной фиксации)
  closeReason: string | null;
  lastCheckedMs: number;
}

export interface BotStats {
  total: number;
  pending: number;
  open: number;
  tp: number;
  sl: number;
  be: number;
  cancelled: number;
  profitPct: number;
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
