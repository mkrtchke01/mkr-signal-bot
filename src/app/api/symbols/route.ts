import { NextResponse } from "next/server";
import { topSymbols } from "@/lib/binance";

export const revalidate = 900; // топ-20 обновляется раз в 15 минут

export async function GET() {
  try {
    const symbols = await topSymbols(20);
    return NextResponse.json(symbols);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Binance недоступен" }, { status: 502 },
    );
  }
}
