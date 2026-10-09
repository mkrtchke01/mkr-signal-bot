import { NextRequest, NextResponse } from "next/server";
import { startSession } from "@/lib/auth";
import { getUserAuth } from "@/lib/dbUsers";
import { normalizeEmail, verifyPassword } from "@/lib/secrets";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const found = email ? await getUserAuth(email) : null;
    // Одна и та же ошибка для «нет такого» и «не тот пароль»
    if (!found || !verifyPassword(String(body.password ?? ""), found.passHash)) {
      return NextResponse.json({ error: "Неверный email или пароль" }, { status: 401 });
    }
    const res = NextResponse.json({ ok: true });
    await startSession(res, found.user.id);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
