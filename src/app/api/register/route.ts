import { NextRequest, NextResponse } from "next/server";
import { startSession } from "@/lib/auth";
import { countUsers, registerUser } from "@/lib/dbUsers";
import { hashPassword, MIN_PASSWORD, normalizeEmail } from "@/lib/secrets";

export const dynamic = "force-dynamic";

// Регистрация по инвайт-коду. Самый первый аккаунт — без кода, он же админ.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const password = String(body.password ?? "");
    const invite = String(body.invite ?? "").trim() || null;
    if (!email) return NextResponse.json({ error: "Некорректный email" }, { status: 400 });
    if (password.length < MIN_PASSWORD) {
      return NextResponse.json(
        { error: `Пароль — минимум ${MIN_PASSWORD} символов` }, { status: 400 },
      );
    }
    const r = await registerUser(email, hashPassword(password), invite);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: 400 });
    const res = NextResponse.json({ ok: true, isAdmin: r.user.isAdmin });
    await startSession(res, r.user.id);
    return res;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// Нужен ли инвайт: пока нет ни одного пользователя — нет
export async function GET() {
  try {
    return NextResponse.json({ needInvite: (await countUsers()) > 0 });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
