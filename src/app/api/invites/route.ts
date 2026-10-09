import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isResponse, requireAdmin } from "@/lib/auth";
import { createInvite, listInvites, revokeInvite } from "@/lib/dbUsers";

export const dynamic = "force-dynamic";

const fail = (e: unknown) => NextResponse.json(
  { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
);

export async function GET() {
  try {
    const admin = await requireAdmin();
    if (isResponse(admin)) return admin;
    return NextResponse.json(await listInvites());
  } catch (e) { return fail(e); }
}

// Новый одноразовый код: 10 символов без похожих букв и цифр
export async function POST() {
  try {
    const admin = await requireAdmin();
    if (isResponse(admin)) return admin;
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(randomBytes(10), (b) => abc[b % abc.length]).join("");
    await createInvite(code, admin.id);
    return NextResponse.json({ ok: true, code });
  } catch (e) { return fail(e); }
}

export async function DELETE(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    if (isResponse(admin)) return admin;
    const code = req.nextUrl.searchParams.get("code") ?? "";
    if (!await revokeInvite(code)) {
      return NextResponse.json({ error: "Код не найден или уже использован" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e); }
}
