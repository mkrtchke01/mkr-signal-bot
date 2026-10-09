import { NextRequest, NextResponse } from "next/server";

// Без сессионной куки — на страницу входа (API отвечает 401). Здесь, на edge,
// базы нет, поэтому проверяется только наличие куки, а сама сессия —
// в каждом API-обработчике (lib/auth.ts).
// Крон, вебхук Telegram и og-картинки имеют собственную защиту/должны быть публичны.
const PUBLIC_PREFIXES = [
  "/api/cron",
  "/api/telegram",
  "/api/og",
  "/api/login",
  "/api/register",
  "/login",
  "/register",
  "/_next",
  "/favicon",
];

const SESSION_COOKIE = "mkr_session"; // то же имя, что в lib/auth.ts

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (req.cookies.get(SESSION_COOKIE)?.value) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Нужно войти" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
