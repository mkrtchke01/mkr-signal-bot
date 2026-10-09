import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  await endSession(res);
  return res;
}
