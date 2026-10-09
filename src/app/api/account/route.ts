import { NextResponse } from "next/server";
import { getAccount } from "@/lib/account";

export const dynamic = "force-dynamic";

// Баланс счёта ботов: стартовый + результат закрытых сделок, и свободная маржа
export async function GET() {
  try {
    return NextResponse.json(await getAccount());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}
