// Сессии: случайный токен в httpOnly-куке, в базе — его хеш.
// Middleware проверяет только наличие куки (на edge базы нет), а настоящая
// проверка — здесь, в каждом API-обработчике.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createSession, deleteSession, SESSION_DAYS, sessionUser } from "./dbUsers";
import { newToken, sha256 } from "./secrets";
import type { User } from "./types";

export const SESSION_COOKIE = "mkr_session";

export async function startSession(res: NextResponse, userId: string): Promise<void> {
  const token = newToken();
  await createSession(userId, sha256(token));
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: true, path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
}

export async function endSession(res: NextResponse): Promise<void> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(sha256(token));
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, path: "/", maxAge: 0 });
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return sessionUser(sha256(token));
}

// Пользователь или готовый ответ 401 — обработчик просто возвращает его
export async function requireUser(): Promise<User | NextResponse> {
  const user = await currentUser();
  return user ?? NextResponse.json({ error: "Нужно войти" }, { status: 401 });
}

export async function requireAdmin(): Promise<User | NextResponse> {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  if (!user.isAdmin) return NextResponse.json({ error: "Только для админа" }, { status: 403 });
  return user;
}

export function isResponse(v: unknown): v is NextResponse {
  return v instanceof NextResponse;
}
