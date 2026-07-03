import { NextRequest, NextResponse } from "next/server";

// Если задан APP_PASSWORD — закрываем интерфейс и CRUD-API паролем.
// Крон, вебхук Telegram и og-картинки имеют собственную защиту/должны быть публичны.
const PUBLIC_PREFIXES = [
  "/api/cron",
  "/api/telegram",
  "/api/og",
  "/api/login",
  "/login",
  "/_next",
  "/favicon",
];

export function middleware(req: NextRequest) {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (req.cookies.get("mkr_auth")?.value === pass) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
