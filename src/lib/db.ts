import postgres from "postgres";
import type {
  BotSetup, BotSetupStatus, BotStats, Direction, ExitRule, Rule, Signal,
  SignalStatus, TF, Trader, TraderConfig, TraderStats, TraderStatus,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

let client: ReturnType<typeof postgres> | null = null;

// Универсальный Postgres-клиент: работает и с Supabase (POSTGRES_URL из
// интеграции Vercel, pooler 6543), и с Neon (DATABASE_URL), и с любым другим PG.
function getSql() {
  if (client) return client;
  const url = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "Нет строки подключения к БД: подключи Supabase или Neon в Vercel → Storage "
      + "(появится POSTGRES_URL / DATABASE_URL) и сделай Redeploy.",
    );
  }
  client = postgres(url, {
    ssl: "require",
    prepare: false, // обязательно для пулера Supabase (pgbouncer, transaction mode)
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  return client;
}

let schemaReady: Promise<void> | null = null;

// Схема создаётся автоматически при первом обращении — миграции не нужны.
export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const sql = getSql();
      await sql`CREATE TABLE IF NOT EXISTS traders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        symbol text NOT NULL,
        direction text NOT NULL,
        leverage int NOT NULL DEFAULT 1,
        timeframe text NOT NULL,
        rules jsonb NOT NULL DEFAULT '[]',
        stop_loss jsonb NOT NULL,
        take_profit jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PAUSED',
        last_entry_candle bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS signals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        trader_id uuid NOT NULL REFERENCES traders(id) ON DELETE CASCADE,
        symbol text NOT NULL,
        direction text NOT NULL,
        leverage int NOT NULL,
        entry_price double precision NOT NULL,
        entry_time timestamptz NOT NULL DEFAULT now(),
        stop_price double precision,
        take_price double precision,
        status text NOT NULL DEFAULT 'OPEN',
        exit_price double precision,
        exit_time timestamptz,
        profit_pct double precision,
        config jsonb NOT NULL,
        last_checked_ms bigint NOT NULL DEFAULT 0
      )`;
      await sql`ALTER TABLE traders ADD COLUMN IF NOT EXISTS max_hold_hours int`;
      await sql`CREATE INDEX IF NOT EXISTS idx_signals_trader ON signals(trader_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status)`;
      await sql`CREATE TABLE IF NOT EXISTS channels (
        chat_id bigint PRIMARY KEY,
        title text NOT NULL DEFAULT '',
        type text NOT NULL DEFAULT 'channel',
        active boolean NOT NULL DEFAULT true,
        added_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS bot_setups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        symbol text NOT NULL,
        direction text NOT NULL,
        status text NOT NULL DEFAULT 'PENDING',
        entry_price double precision NOT NULL,
        stop_price double precision NOT NULL,
        initial_stop double precision NOT NULL,
        tp1 double precision NOT NULL,
        tp2 double precision NOT NULL,
        rr1 double precision NOT NULL DEFAULT 0,
        rr2 double precision NOT NULL DEFAULT 0,
        reasons jsonb NOT NULL DEFAULT '{}',
        regime text NOT NULL DEFAULT '',
        tp1_done boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        filled_at timestamptz,
        closed_at timestamptz,
        exit_price double precision,
        profit_pct double precision,
        close_reason text,
        last_checked_ms bigint NOT NULL DEFAULT 0
      )`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bot_setups_status ON bot_setups(status)`;
      await sql`CREATE TABLE IF NOT EXISTS bot_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL
      )`;
    })().catch((e) => {
      schemaReady = null; // позволить повторить при следующем запросе
      throw e;
    });
  }
  return schemaReady;
}

export async function db() {
  await ensureSchema();
  return getSql();
}

// Через пулер Supabase postgres.js может отдавать jsonb строкой — разбираем сами
function j<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}

function rowToTrader(r: Row): Trader {
  return {
    id: r.id,
    name: r.name,
    symbol: r.symbol,
    direction: r.direction as Direction,
    leverage: Number(r.leverage),
    timeframe: r.timeframe as TF,
    rules: j<Rule[]>(r.rules),
    stopLoss: j<ExitRule>(r.stop_loss),
    takeProfit: j<ExitRule>(r.take_profit),
    maxHoldHours: r.max_hold_hours === null || r.max_hold_hours === undefined
      ? null : Number(r.max_hold_hours),
    status: r.status as TraderStatus,
    lastEntryCandle: Number(r.last_entry_candle),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function rowToSignal(r: Row): Signal {
  return {
    id: r.id,
    traderId: r.trader_id,
    symbol: r.symbol,
    direction: r.direction as Direction,
    leverage: Number(r.leverage),
    entryPrice: Number(r.entry_price),
    entryTime: new Date(r.entry_time).toISOString(),
    stopPrice: r.stop_price === null ? null : Number(r.stop_price),
    takePrice: r.take_price === null ? null : Number(r.take_price),
    status: r.status as SignalStatus,
    exitPrice: r.exit_price === null ? null : Number(r.exit_price),
    exitTime: r.exit_time ? new Date(r.exit_time).toISOString() : null,
    profitPct: r.profit_pct === null ? null : Number(r.profit_pct),
    config: j(r.config),
    lastCheckedMs: Number(r.last_checked_ms),
  };
}

export async function listTraders(): Promise<Trader[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM traders ORDER BY created_at DESC`;
  return rows.map(rowToTrader);
}

export async function getTrader(id: string): Promise<Trader | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM traders WHERE id = ${id}`;
  return rows.length ? rowToTrader(rows[0]) : null;
}

export async function createTrader(name: string, c: TraderConfig): Promise<Trader> {
  const sql = await db();
  const rows = await sql`INSERT INTO traders
    (name, symbol, direction, leverage, timeframe, rules, stop_loss, take_profit, max_hold_hours)
    VALUES (${name}, ${c.symbol}, ${c.direction}, ${c.leverage}, ${c.timeframe},
            ${JSON.stringify(c.rules)}::jsonb, ${JSON.stringify(c.stopLoss)}::jsonb,
            ${JSON.stringify(c.takeProfit)}::jsonb, ${c.maxHoldHours ?? null})
    RETURNING *`;
  return rowToTrader(rows[0]);
}

export async function updateTrader(id: string, name: string, c: TraderConfig): Promise<Trader | null> {
  const sql = await db();
  const rows = await sql`UPDATE traders SET
      name = ${name}, symbol = ${c.symbol}, direction = ${c.direction},
      leverage = ${c.leverage}, timeframe = ${c.timeframe},
      rules = ${JSON.stringify(c.rules)}::jsonb,
      stop_loss = ${JSON.stringify(c.stopLoss)}::jsonb,
      take_profit = ${JSON.stringify(c.takeProfit)}::jsonb,
      max_hold_hours = ${c.maxHoldHours ?? null},
      updated_at = now()
    WHERE id = ${id} RETURNING *`;
  return rows.length ? rowToTrader(rows[0]) : null;
}

export async function setTraderStatus(id: string, status: TraderStatus): Promise<void> {
  const sql = await db();
  await sql`UPDATE traders SET status = ${status}, updated_at = now() WHERE id = ${id}`;
}

export async function setTraderLastEntryCandle(id: string, openTime: number): Promise<void> {
  const sql = await db();
  await sql`UPDATE traders SET last_entry_candle = ${openTime} WHERE id = ${id}`;
}

export async function deleteTrader(id: string): Promise<void> {
  const sql = await db();
  await sql`DELETE FROM traders WHERE id = ${id}`;
}

export async function traderStats(ids: string[]): Promise<Map<string, TraderStats>> {
  const map = new Map<string, TraderStats>();
  if (!ids.length) return map;
  const sql = await db();
  const rows = await sql`SELECT trader_id,
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'OPEN')::int AS open,
      count(*) FILTER (WHERE status = 'TP')::int AS tp,
      count(*) FILTER (WHERE status = 'SL')::int AS sl,
      count(*) FILTER (WHERE status = 'TIME')::int AS "time",
      coalesce(sum(profit_pct), 0)::float8 AS profit
    FROM signals WHERE trader_id = ANY(${ids}::uuid[])
    GROUP BY trader_id`;
  for (const r of rows) {
    map.set(r.trader_id, {
      total: r.total, open: r.open, tp: r.tp, sl: r.sl, time: r.time, profitPct: r.profit,
    });
  }
  return map;
}

export async function openSignals(): Promise<Signal[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM signals WHERE status = 'OPEN' ORDER BY entry_time`;
  return rows.map(rowToSignal);
}

export async function openSignalTraderIds(): Promise<Set<string>> {
  const sql = await db();
  const rows = await sql`SELECT DISTINCT trader_id FROM signals WHERE status = 'OPEN'`;
  return new Set(rows.map((r) => r.trader_id as string));
}

export async function getSignal(id: string): Promise<Signal | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM signals WHERE id = ${id}`;
  return rows.length ? rowToSignal(rows[0]) : null;
}

export async function listSignals(traderId: string, limit = 100): Promise<Signal[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM signals WHERE trader_id = ${traderId}
    ORDER BY entry_time DESC LIMIT ${limit}`;
  return rows.map(rowToSignal);
}

export async function insertSignal(s: {
  traderId: string; symbol: string; direction: Direction; leverage: number;
  entryPrice: number; stopPrice: number | null; takePrice: number | null;
  config: TraderConfig & { name: string }; lastCheckedMs: number;
}): Promise<Signal> {
  const sql = await db();
  const rows = await sql`INSERT INTO signals
    (trader_id, symbol, direction, leverage, entry_price, stop_price, take_price, config, last_checked_ms)
    VALUES (${s.traderId}, ${s.symbol}, ${s.direction}, ${s.leverage}, ${s.entryPrice},
            ${s.stopPrice}, ${s.takePrice}, ${JSON.stringify(s.config)}::jsonb, ${s.lastCheckedMs})
    RETURNING *`;
  return rowToSignal(rows[0]);
}

export async function closeSignal(
  id: string, status: "TP" | "SL" | "TIME", exitPrice: number, profitPct: number,
): Promise<void> {
  const sql = await db();
  await sql`UPDATE signals SET status = ${status}, exit_price = ${exitPrice},
    exit_time = now(), profit_pct = ${profitPct} WHERE id = ${id} AND status = 'OPEN'`;
}

export async function touchSignal(id: string, lastCheckedMs: number): Promise<void> {
  const sql = await db();
  await sql`UPDATE signals SET last_checked_ms = ${lastCheckedMs} WHERE id = ${id}`;
}

export interface Channel {
  chatId: string; // bigint как строка
  title: string;
  type: string;
  active: boolean;
}

export async function listChannels(): Promise<Channel[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM channels ORDER BY added_at`;
  return rows.map((r) => ({
    chatId: String(r.chat_id), title: r.title, type: r.type, active: r.active,
  }));
}

export async function activeChannelIds(): Promise<string[]> {
  const sql = await db();
  const rows = await sql`SELECT chat_id FROM channels WHERE active = true`;
  return rows.map((r) => String(r.chat_id));
}

export async function upsertChannel(chatId: string, title: string, type: string): Promise<void> {
  const sql = await db();
  await sql`INSERT INTO channels (chat_id, title, type) VALUES (${chatId}, ${title}, ${type})
    ON CONFLICT (chat_id) DO UPDATE SET title = ${title}, type = ${type}, active = true`;
}

// Бота убрали из канала — убираем канал из списка совсем
export async function removeChannel(chatId: string): Promise<void> {
  const sql = await db();
  await sql`DELETE FROM channels WHERE chat_id = ${chatId}`;
}

export async function setChannelActive(chatId: string, active: boolean): Promise<void> {
  const sql = await db();
  await sql`UPDATE channels SET active = ${active} WHERE chat_id = ${chatId}`;
}

// ---- Трейдер-бот ----

function rowToBotSetup(r: Row): BotSetup {
  return {
    id: r.id,
    symbol: r.symbol,
    direction: r.direction as Direction,
    status: r.status as BotSetupStatus,
    entryPrice: Number(r.entry_price),
    stopPrice: Number(r.stop_price),
    initialStop: Number(r.initial_stop),
    tp1: Number(r.tp1),
    tp2: Number(r.tp2),
    rr1: Number(r.rr1),
    rr2: Number(r.rr2),
    reasons: j(r.reasons),
    regime: r.regime,
    tp1Done: Boolean(r.tp1_done),
    createdAt: new Date(r.created_at).toISOString(),
    filledAt: r.filled_at ? new Date(r.filled_at).toISOString() : null,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    exitPrice: r.exit_price === null ? null : Number(r.exit_price),
    profitPct: r.profit_pct === null ? null : Number(r.profit_pct),
    closeReason: r.close_reason ?? null,
    lastCheckedMs: Number(r.last_checked_ms),
  };
}

export async function listBotSetups(limit = 100): Promise<BotSetup[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM bot_setups ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(rowToBotSetup);
}

export async function activeBotSetups(): Promise<BotSetup[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM bot_setups
    WHERE status IN ('PENDING', 'OPEN') ORDER BY created_at`;
  return rows.map(rowToBotSetup);
}

export async function getBotSetup(id: string): Promise<BotSetup | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM bot_setups WHERE id = ${id}`;
  return rows.length ? rowToBotSetup(rows[0]) : null;
}

// Сигнал — вход по рынку: сетап создаётся сразу в статусе OPEN, без ожидания налива
export async function insertBotSetup(s: {
  symbol: string; direction: Direction; entryPrice: number; stopPrice: number;
  tp1: number; tp2: number; rr1: number; rr2: number;
  reasons: BotSetup["reasons"]; regime: string;
}): Promise<BotSetup> {
  const sql = await db();
  const rows = await sql`INSERT INTO bot_setups
    (symbol, direction, status, entry_price, stop_price, initial_stop, tp1, tp2, rr1, rr2, reasons, regime, filled_at, last_checked_ms)
    VALUES (${s.symbol}, ${s.direction}, 'OPEN', ${s.entryPrice}, ${s.stopPrice}, ${s.stopPrice},
            ${s.tp1}, ${s.tp2}, ${s.rr1}, ${s.rr2}, ${JSON.stringify(s.reasons)}::jsonb,
            ${s.regime}, now(), ${Date.now()})
    RETURNING *`;
  return rowToBotSetup(rows[0]);
}

export async function fillBotSetup(id: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET status = 'OPEN', filled_at = now()
    WHERE id = ${id} AND status = 'PENDING'`;
}

// TP1 достигнут: фиксация 50%, стоп переносится в безубыток (на цену входа)
export async function markBotTp1(id: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET tp1_done = true, stop_price = entry_price
    WHERE id = ${id} AND status = 'OPEN'`;
}

export async function closeBotSetup(
  id: string, status: BotSetupStatus, exitPrice: number | null,
  profitPct: number | null, reason: string,
): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET status = ${status}, exit_price = ${exitPrice},
    profit_pct = ${profitPct}, close_reason = ${reason}, closed_at = now()
    WHERE id = ${id} AND status IN ('PENDING', 'OPEN')`;
}

export async function touchBotSetup(id: string, lastCheckedMs: number): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET last_checked_ms = ${lastCheckedMs} WHERE id = ${id}`;
}

export async function botStats(): Promise<BotStats> {
  const sql = await db();
  const rows = await sql`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
      count(*) FILTER (WHERE status = 'OPEN')::int AS open,
      count(*) FILTER (WHERE status = 'TP')::int AS tp,
      count(*) FILTER (WHERE status = 'SL')::int AS sl,
      count(*) FILTER (WHERE status = 'BE')::int AS be,
      count(*) FILTER (WHERE status IN ('CANCELLED', 'EXPIRED'))::int AS cancelled,
      coalesce(sum(profit_pct), 0)::float8 AS profit
    FROM bot_setups`;
  const r = rows[0];
  return {
    total: r.total, pending: r.pending, open: r.open, tp: r.tp, sl: r.sl,
    be: r.be, cancelled: r.cancelled, profitPct: r.profit,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getBotState<T = any>(key: string): Promise<T | null> {
  const sql = await db();
  const rows = await sql`SELECT value FROM bot_state WHERE key = ${key}`;
  return rows.length ? j<T>(rows[0].value) : null;
}

export async function setBotState(key: string, value: unknown): Promise<void> {
  const sql = await db();
  await sql`INSERT INTO bot_state (key, value) VALUES (${key}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}::jsonb`;
}
