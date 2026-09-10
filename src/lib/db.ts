import postgres from "postgres";
import type {
  BotSetup, BotSetupStatus, BotStats, Direction, ExitRule, Rule,
  Signal, SignalStatus, TF, TradePlan, Trader, TraderConfig, TraderStats,
  TraderStatus,
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
      // Денежный план сделки и фактический результат в долларах
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS plan jsonb`;
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS profit_usd double precision`;
      // Несколько кастомных ботов живут в одной таблице, различаются по slug
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS
        bot text NOT NULL DEFAULT 'breakout-trend'`;
      // Сопровождение остатка трейлингом: точка включения, шаг, лучшая цена
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS trail_abs double precision`;
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS best_price double precision`;
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS activate_at double precision`;
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS
        trail_on boolean NOT NULL DEFAULT false`;
      // Стратегии без частичной фиксации выходят на цели целиком
      await sql`ALTER TABLE bot_setups ADD COLUMN IF NOT EXISTS
        tp_full boolean NOT NULL DEFAULT false`;
      // Досыпаем значения сетапам, созданным до появления этих колонок:
      // без этого NULL превращается в 0 и трейлинг «активируется» сразу же.
      await sql`UPDATE bot_setups SET activate_at = tp1
        WHERE activate_at IS NULL AND tp1 IS NOT NULL`;
      await sql`UPDATE bot_setups SET best_price = entry_price WHERE best_price IS NULL`;
      await sql`UPDATE bot_setups SET trail_abs = 0 WHERE trail_abs IS NULL`;
      // Фиксированной второй цели больше нет
      await sql`ALTER TABLE bot_setups ALTER COLUMN tp2 DROP NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bot_setups_status ON bot_setups(status)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_bot_setups_bot ON bot_setups(bot, created_at DESC)`;
      // Боты «Откат к уровням» и «Мемкоины перед выносом» удалены — чистим их
      // данные. Повторный запуск ничего не находит и ничего не делает.
      await sql`DELETE FROM bot_setups WHERE bot IN ('pullback-levels', 'prepump')`;
      // Вместе с мемкоин-ботом ушли и адреса пулов: кроме него их никто
      // не заполнял и не читал.
      await sql`ALTER TABLE bot_setups DROP COLUMN IF EXISTS chain`;
      await sql`ALTER TABLE bot_setups DROP COLUMN IF EXISTS token_address`;
      await sql`ALTER TABLE bot_setups DROP COLUMN IF EXISTS pool_address`;
      await sql`CREATE TABLE IF NOT EXISTS bot_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL
      )`;
      // Состояние именуется как "<бот>:<ключ>". Ключи удалённых ботов
      // и безымянные предшественники больше не нужны.
      await sql`DELETE FROM bot_state
        WHERE key IN ('config', 'regime', 'lastScanMs')
           OR key LIKE 'pullback-levels:%'
           OR key LIKE 'prepump:%'`;
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

// У сетапов, созданных до появления колонки, значение NULL. Number(null) даёт 0,
// а нулевая цена активации срабатывает на первой же свече — поэтому подставляем
// осмысленный запасной вариант, а не приводим напрямую.
function numOr(v: unknown, fallback: number): number {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function rowToBotSetup(r: Row): BotSetup {
  const entry = Number(r.entry_price);
  const tp1 = Number(r.tp1);
  return {
    id: r.id,
    bot: r.bot,
    symbol: r.symbol,
    direction: r.direction as Direction,
    status: r.status as BotSetupStatus,
    entryPrice: entry,
    stopPrice: Number(r.stop_price),
    initialStop: Number(r.initial_stop),
    tp1,
    rr1: Number(r.rr1),
    activateAt: numOr(r.activate_at, tp1),
    trailAbs: numOr(r.trail_abs, 0), // 0 = трейлинга у сетапа нет
    trailOn: Boolean(r.trail_on),
    bestPrice: numOr(r.best_price, entry),
    tpFull: Boolean(r.tp_full),
    reasons: j(r.reasons),
    regime: r.regime,
    plan: r.plan ? j<TradePlan>(r.plan) : null,
    tp1Done: Boolean(r.tp1_done),
    createdAt: new Date(r.created_at).toISOString(),
    filledAt: r.filled_at ? new Date(r.filled_at).toISOString() : null,
    closedAt: r.closed_at ? new Date(r.closed_at).toISOString() : null,
    exitPrice: r.exit_price === null ? null : Number(r.exit_price),
    profitPct: r.profit_pct === null ? null : Number(r.profit_pct),
    profitUsd: r.profit_usd === null || r.profit_usd === undefined
      ? null : Number(r.profit_usd),
    closeReason: r.close_reason ?? null,
    lastCheckedMs: Number(r.last_checked_ms),
  };
}

export async function listBotSetups(bot: string, limit = 100): Promise<BotSetup[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM bot_setups WHERE bot = ${bot}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(rowToBotSetup);
}

export async function activeBotSetups(bot: string): Promise<BotSetup[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM bot_setups
    WHERE bot = ${bot} AND status = 'OPEN' ORDER BY created_at`;
  return rows.map(rowToBotSetup);
}

export async function getBotSetup(id: string): Promise<BotSetup | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM bot_setups WHERE id = ${id}`;
  return rows.length ? rowToBotSetup(rows[0]) : null;
}

// Сигнал — вход по рынку: сетап создаётся сразу в статусе OPEN, без ожидания налива
export async function insertBotSetup(s: {
  bot: string; symbol: string; direction: Direction;
  entryPrice: number; stopPrice: number;
  tp1: number; rr1: number; activateAt: number; trailAbs: number;
  reasons: BotSetup["reasons"]; regime: string; plan: TradePlan;
  tpFull?: boolean;
}): Promise<BotSetup> {
  const sql = await db();
  const rows = await sql`INSERT INTO bot_setups
    (bot, symbol, direction, status, entry_price, stop_price, initial_stop,
     tp1, rr1, activate_at, trail_abs, best_price, tp_full, reasons, regime, plan,
     filled_at, last_checked_ms)
    VALUES (${s.bot}, ${s.symbol}, ${s.direction}, 'OPEN', ${s.entryPrice},
            ${s.stopPrice}, ${s.stopPrice},
            ${s.tp1}, ${s.rr1}, ${s.activateAt}, ${s.trailAbs}, ${s.entryPrice},
            ${s.tpFull ?? false},
            ${JSON.stringify(s.reasons)}::jsonb,
            ${s.regime}, ${JSON.stringify(s.plan)}::jsonb, now(), ${Date.now()})
    RETURNING *`;
  return rowToBotSetup(rows[0]);
}

// Возврат ошибочно закрытого сетапа в работу: позиция на бирже жива, а бот
// закрыл только свою запись. Стоп и объём остаются прежними — под них посчитан
// риск; пересчитываются только цели и параметры трейлинга.
export async function reopenBotSetup(id: string, s: {
  tp1: number; rr1: number; activateAt: number; trailAbs: number;
  reasons: BotSetup["reasons"]; plan: TradePlan;
}): Promise<BotSetup | null> {
  const sql = await db();
  const rows = await sql`UPDATE bot_setups SET
      status = 'OPEN', stop_price = initial_stop,
      tp1 = ${s.tp1}, rr1 = ${s.rr1},
      activate_at = ${s.activateAt}, trail_abs = ${s.trailAbs},
      trail_on = false, tp1_done = false, best_price = entry_price,
      exit_price = NULL, profit_pct = NULL, profit_usd = NULL,
      closed_at = NULL, close_reason = NULL,
      reasons = ${JSON.stringify(s.reasons)}::jsonb,
      plan = ${JSON.stringify(s.plan)}::jsonb,
      last_checked_ms = ${Date.now()}
    WHERE id = ${id} AND status <> 'OPEN'
    RETURNING *`;
  return rows.length ? rowToBotSetup(rows[0]) : null;
}

// Трейлинг подтянул стоп за ценой — сохраняем новый стоп и лучшую цену
export async function updateBotTrail(
  id: string, stopPrice: number, bestPrice: number,
): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET stop_price = ${stopPrice}, best_price = ${bestPrice},
      trail_on = true
    WHERE id = ${id} AND status = 'OPEN'`;
}

// TP1 достигнут: половина зафиксирована. Стоп остаётся на месте до активации трейлинга
export async function markBotTp1(id: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET tp1_done = true
    WHERE id = ${id} AND status = 'OPEN'`;
}

// result = null для сетапов, закрытых без сделки (отмена/истечение лимитки)
export interface BotCloseResult {
  exitPrice: number;
  profitPct: number; // движение цены, %
  profitUsd: number | null; // деньги с плечом и комиссиями (null — если плана нет)
}

export async function closeBotSetup(
  id: string, status: BotSetupStatus, reason: string,
  result: BotCloseResult | null = null,
): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET status = ${status},
    exit_price = ${result?.exitPrice ?? null},
    profit_pct = ${result?.profitPct ?? null},
    profit_usd = ${result?.profitUsd ?? null},
    close_reason = ${reason}, closed_at = now()
    WHERE id = ${id} AND status = 'OPEN'`;
}

// Полный сброс истории бота: сетапы и открытые позиции удаляются безвозвратно.
export async function wipeBotSetups(bot: string): Promise<number> {
  const sql = await db();
  const rows = await sql`DELETE FROM bot_setups WHERE bot = ${bot} RETURNING id`;
  return rows.length;
}

export async function touchBotSetup(id: string, lastCheckedMs: number): Promise<void> {
  const sql = await db();
  await sql`UPDATE bot_setups SET last_checked_ms = ${lastCheckedMs} WHERE id = ${id}`;
}

export async function botStats(bot: string): Promise<BotStats> {
  const sql = await db();
  const rows = await sql`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status = 'OPEN')::int AS open,
      count(*) FILTER (WHERE status = 'TP')::int AS tp,
      count(*) FILTER (WHERE status = 'TRAIL')::int AS trail,
      count(*) FILTER (WHERE status = 'PART')::int AS part,
      count(*) FILTER (WHERE status = 'SL')::int AS sl,
      count(*) FILTER (WHERE status = 'TIME')::int AS "time",
      count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
      count(*) FILTER (WHERE tp1_done)::int AS tp1_reached,
      coalesce(sum(profit_pct), 0)::float8 AS profit,
      coalesce(sum(profit_usd), 0)::float8 AS profit_usd
    FROM bot_setups WHERE bot = ${bot}`;
  const r = rows[0];
  return {
    total: r.total, open: r.open, tp: r.tp, trail: r.trail, part: r.part, sl: r.sl,
    time: r.time, cancelled: r.cancelled, tp1Reached: r.tp1_reached,
    profitPct: r.profit,
    profitUsd: Math.round(r.profit_usd * 100) / 100,
  };
}

// Состояние ботов лежит в одной таблице — ключ всегда с префиксом бота
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getBotState<T = any>(bot: string, key: string): Promise<T | null> {
  const sql = await db();
  const rows = await sql`SELECT value FROM bot_state WHERE key = ${`${bot}:${key}`}`;
  return rows.length ? j<T>(rows[0].value) : null;
}

export async function setBotState(bot: string, key: string, value: unknown): Promise<void> {
  const sql = await db();
  const k = `${bot}:${key}`;
  await sql`INSERT INTO bot_state (key, value) VALUES (${k}, ${JSON.stringify(value)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}::jsonb`;
}
