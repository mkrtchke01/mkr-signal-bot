// Пользователи, сессии, инвайты и личные сделки. Схема — в ensureSchema (db.ts).

import { db } from "./db";
import type {
  Invite, TradePlan, User, UserBotSetting, UserBotStats, UserTrade, UserTradeStatus,
} from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

function j<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export const DEFAULT_USER_RISK_PCT = 1;
export const MAX_USER_RISK_PCT = 50;
export const MIN_USER_RISK_PCT = 0.1;

// ---- Пользователи ----

function rowToUser(r: Row): User {
  return {
    id: r.id,
    email: r.email,
    isAdmin: Boolean(r.is_admin),
    capital: Number(r.capital),
    capitalSetAt: new Date(r.capital_set_at).toISOString(),
    apiKey: r.api_key ?? null,
    hasSecret: Boolean(r.api_secret_enc),
    bingxBalance: r.bingx_balance === null ? null : Number(r.bingx_balance),
    bingxCheckedAt: iso(r.bingx_checked_at),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function countUsers(): Promise<number> {
  const sql = await db();
  const rows = await sql`SELECT count(*)::int AS n FROM users`;
  return rows[0].n;
}

/**
 * Регистрация. Первый аккаунт — без инвайта и сразу админ. Остальным нужен
 * свободный одноразовый код: он гасится в той же транзакции, что создаёт
 * пользователя, поэтому один код не сработает дважды.
 */
export async function registerUser(
  email: string, passHash: string, invite: string | null,
): Promise<{ user: User } | { error: string }> {
  const sql = await db();
  return sql.begin(async (tx) => {
    // Блокировка на время транзакции: два «первых» пользователя одновременно не пройдут
    await tx`LOCK TABLE users IN EXCLUSIVE MODE`;
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM users`;
    const first = n === 0;
    if (!first) {
      if (!invite) return { error: "Нужен инвайт-код" };
      const inv = await tx`SELECT code FROM invites
        WHERE code = ${invite} AND used_by IS NULL FOR UPDATE`;
      if (!inv.length) return { error: "Инвайт-код не найден или уже использован" };
    }
    const exists = await tx`SELECT 1 FROM users WHERE email = ${email}`;
    if (exists.length) return { error: "Такой email уже зарегистрирован" };
    const rows = await tx`INSERT INTO users (email, pass_hash, is_admin)
      VALUES (${email}, ${passHash}, ${first}) RETURNING *`;
    const user = rowToUser(rows[0]);
    if (!first) {
      await tx`UPDATE invites SET used_by = ${user.id}, used_at = now() WHERE code = ${invite}`;
    }
    return { user };
  }) as Promise<{ user: User } | { error: string }>;
}

export async function getUserAuth(email: string): Promise<{ user: User; passHash: string } | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
  return rows.length ? { user: rowToUser(rows[0]), passHash: rows[0].pass_hash } : null;
}

export async function getUser(id: string): Promise<User | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
  return rows.length ? rowToUser(rows[0]) : null;
}

// Новая сумма становится текущим балансом: итоги считаются с этого момента
export async function setUserCapital(id: string, capital: number): Promise<void> {
  const sql = await db();
  await sql`UPDATE users SET capital = ${capital}, capital_set_at = now() WHERE id = ${id}`;
}

export async function setUserKeys(id: string, apiKey: string, secretEnc: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE users SET api_key = ${apiKey}, api_secret_enc = ${secretEnc},
    bingx_balance = NULL, bingx_checked_at = NULL WHERE id = ${id}`;
}

export async function clearUserKeys(id: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE users SET api_key = NULL, api_secret_enc = NULL,
    bingx_balance = NULL, bingx_checked_at = NULL WHERE id = ${id}`;
}

export async function getUserSecretEnc(id: string): Promise<{ apiKey: string; secretEnc: string } | null> {
  const sql = await db();
  const rows = await sql`SELECT api_key, api_secret_enc FROM users WHERE id = ${id}`;
  const r = rows[0];
  return r?.api_key && r?.api_secret_enc ? { apiKey: r.api_key, secretEnc: r.api_secret_enc } : null;
}

export async function setUserBingxBalance(id: string, balance: number): Promise<void> {
  const sql = await db();
  await sql`UPDATE users SET bingx_balance = ${balance}, bingx_checked_at = now() WHERE id = ${id}`;
}

// ---- Сессии ----

export const SESSION_DAYS = 30;

export async function createSession(userId: string, tokenHash: string): Promise<void> {
  const sql = await db();
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at)
    VALUES (${tokenHash}, ${userId}, now() + make_interval(days => ${SESSION_DAYS}))`;
  // Заодно подчищаем просроченные — таблица не растёт бесконечно
  await sql`DELETE FROM sessions WHERE expires_at < now()`;
}

export async function sessionUser(tokenHash: string): Promise<User | null> {
  const sql = await db();
  const rows = await sql`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()`;
  return rows.length ? rowToUser(rows[0]) : null;
}

export async function deleteSession(tokenHash: string): Promise<void> {
  const sql = await db();
  await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
}

// ---- Инвайты ----

export async function createInvite(code: string, by: string): Promise<void> {
  const sql = await db();
  await sql`INSERT INTO invites (code, created_by) VALUES (${code}, ${by})`;
}

export async function listInvites(): Promise<Invite[]> {
  const sql = await db();
  const rows = await sql`SELECT i.*, u.email AS used_email FROM invites i
    LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 200`;
  return rows.map((r) => ({
    code: r.code,
    createdAt: new Date(r.created_at).toISOString(),
    usedBy: r.used_email ?? null,
    usedAt: iso(r.used_at),
  }));
}

// Отозвать можно только неиспользованный
export async function revokeInvite(code: string): Promise<boolean> {
  const sql = await db();
  const rows = await sql`DELETE FROM invites WHERE code = ${code} AND used_by IS NULL RETURNING code`;
  return rows.length > 0;
}

// ---- Боты пользователя ----

export async function userBotSettings(userId: string): Promise<Map<string, UserBotSetting>> {
  const sql = await db();
  const rows = await sql`SELECT bot, enabled, risk_pct FROM user_bots WHERE user_id = ${userId}`;
  return new Map(rows.map((r) => [r.bot as string, {
    bot: r.bot, enabled: Boolean(r.enabled), riskPct: Number(r.risk_pct),
  }]));
}

export async function setUserBot(
  userId: string, bot: string, patch: { enabled?: boolean; riskPct?: number },
): Promise<void> {
  const sql = await db();
  await sql`INSERT INTO user_bots (user_id, bot, enabled, risk_pct)
    VALUES (${userId}, ${bot}, ${patch.enabled ?? false}, ${patch.riskPct ?? DEFAULT_USER_RISK_PCT})
    ON CONFLICT (user_id, bot) DO UPDATE SET
      enabled = coalesce(${patch.enabled ?? null}::boolean, user_bots.enabled),
      risk_pct = coalesce(${patch.riskPct ?? null}::float8, user_bots.risk_pct)`;
}

// Кто торгует ботом: включил его и задал капитал
export async function subscribersOf(bot: string): Promise<{ user: User; riskPct: number }[]> {
  const sql = await db();
  const rows = await sql`SELECT u.*, b.risk_pct FROM user_bots b JOIN users u ON u.id = b.user_id
    WHERE b.bot = ${bot} AND b.enabled AND u.capital > 0`;
  return rows.map((r) => ({ user: rowToUser(r), riskPct: Number(r.risk_pct) }));
}

// ---- Личные сделки ----

function rowToTrade(r: Row): UserTrade {
  return {
    id: r.id,
    userId: r.user_id,
    setupId: r.setup_id,
    bot: r.bot,
    status: r.status as UserTradeStatus,
    plan: r.plan ? j<TradePlan>(r.plan) : null,
    note: r.note ?? null,
    profitUsd: r.profit_usd === null ? null : Number(r.profit_usd),
    createdAt: new Date(r.created_at).toISOString(),
    closedAt: iso(r.closed_at),
  };
}

export async function insertUserTrade(t: {
  userId: string; setupId: string; bot: string; status: "OPEN" | "SKIPPED";
  plan: TradePlan | null; note: string | null;
}): Promise<void> {
  const sql = await db();
  await sql`INSERT INTO user_trades (user_id, setup_id, bot, status, plan, note)
    VALUES (${t.userId}, ${t.setupId}, ${t.bot}, ${t.status},
            ${t.plan ? JSON.stringify(t.plan) : null}::jsonb, ${t.note})
    ON CONFLICT (user_id, setup_id) DO NOTHING`;
}

export async function openTradesOfSetup(setupId: string): Promise<UserTrade[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM user_trades WHERE setup_id = ${setupId} AND status = 'OPEN'`;
  return rows.map(rowToTrade);
}

export async function closeUserTrade(
  id: string, status: UserTradeStatus, profitUsd: number | null,
): Promise<void> {
  const sql = await db();
  await sql`UPDATE user_trades SET status = ${status}, profit_usd = ${profitUsd}, closed_at = now()
    WHERE id = ${id} AND status = 'OPEN'`;
}

// Сигнал вернули в работу — вместе с ним открываются сделки, закрытые вместе с ним
export async function reopenTradesOfSetup(setupId: string, closedAfter: string): Promise<void> {
  const sql = await db();
  await sql`UPDATE user_trades SET status = 'OPEN', profit_usd = NULL, closed_at = NULL
    WHERE setup_id = ${setupId} AND status NOT IN ('OPEN', 'SKIPPED', 'CANCELLED')
      AND closed_at >= ${closedAfter}::timestamptz`;
}

export async function getUserTrade(userId: string, setupId: string): Promise<UserTrade | null> {
  const sql = await db();
  const rows = await sql`SELECT * FROM user_trades WHERE user_id = ${userId} AND setup_id = ${setupId}`;
  return rows.length ? rowToTrade(rows[0]) : null;
}

// Отмена ручного закрытия: сделка снова в работе, пока сигнал жив
export async function undoUserClose(userId: string, setupId: string): Promise<boolean> {
  const sql = await db();
  const rows = await sql`UPDATE user_trades t SET status = 'OPEN', profit_usd = NULL, closed_at = NULL
    FROM bot_setups s
    WHERE t.user_id = ${userId} AND t.setup_id = ${setupId} AND t.status = 'CANCELLED'
      AND s.id = t.setup_id AND s.status = 'OPEN'
    RETURNING t.id`;
  return rows.length > 0;
}

export async function userTradesOfBot(userId: string, bot: string, limit = 100): Promise<UserTrade[]> {
  const sql = await db();
  const rows = await sql`SELECT * FROM user_trades WHERE user_id = ${userId} AND bot = ${bot}
    ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(rowToTrade);
}

export async function wipeUserTrades(userId: string, bot: string): Promise<number> {
  const sql = await db();
  const rows = await sql`DELETE FROM user_trades WHERE user_id = ${userId} AND bot = ${bot} RETURNING id`;
  return rows.length;
}

export async function userBotStats(userId: string, bot: string): Promise<UserBotStats> {
  const sql = await db();
  const rows = await sql`SELECT
      count(*) FILTER (WHERE status <> 'SKIPPED')::int AS taken,
      count(*) FILTER (WHERE status = 'OPEN')::int AS open,
      count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
      count(*) FILTER (WHERE status NOT IN ('OPEN', 'SKIPPED') AND profit_usd > 0)::int AS wins,
      count(*) FILTER (WHERE status NOT IN ('OPEN', 'SKIPPED') AND profit_usd IS NOT NULL)::int AS decided,
      coalesce(sum(profit_usd), 0)::float8 AS profit
    FROM user_trades WHERE user_id = ${userId} AND bot = ${bot}`;
  const r = rows[0];
  return {
    taken: r.taken, open: r.open, skipped: r.skipped, wins: r.wins, decided: r.decided,
    profitUsd: Math.round(Number(r.profit) * 100) / 100,
  };
}

// Итоги счёта пользователя: результат сделок, закрытых после установки
// капитала, и маржа открытых
export async function userAccountTotals(userId: string, sinceIso: string): Promise<{
  realized: number; usedMargin: number; open: number;
}> {
  const sql = await db();
  const rows = await sql`SELECT
      coalesce(sum(profit_usd) FILTER (WHERE status NOT IN ('OPEN', 'SKIPPED')
        AND closed_at >= ${sinceIso}::timestamptz), 0)::float8 AS realized,
      coalesce(sum((plan->>'margin')::float8) FILTER (WHERE status = 'OPEN'), 0)::float8 AS used,
      count(*) FILTER (WHERE status = 'OPEN')::int AS open
    FROM user_trades WHERE user_id = ${userId}`;
  const r = rows[0];
  return { realized: Number(r.realized), usedMargin: Number(r.used), open: r.open };
}

