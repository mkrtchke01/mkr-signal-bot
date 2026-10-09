import { NextResponse } from "next/server";
import { isResponse, requireUser } from "@/lib/auth";
import { topSymbols } from "@/lib/bingx";

export const revalidate = 900; // топ-20 обновляется раз в 15 минут

export async function GET() {
  const who = await requireUser();
  if (isResponse(who)) return who;
  try {
    const symbols = await topSymbols(20);
    return NextResponse.json(symbols);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "BingX недоступен" }, { status: 502 },
    );
  }
}
