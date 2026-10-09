import { NextResponse } from "next/server";
import { getAccount } from "@/lib/account";
import { isResponse, requireUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Баланс счёта текущего пользователя: капитал + итог закрытых сделок, свободная маржа
export async function GET() {
  try {
    const user = await requireUser();
    if (isResponse(user)) return user;
    return NextResponse.json(await getAccount(user));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
