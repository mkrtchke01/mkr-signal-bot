import { NextRequest, NextResponse } from "next/server";
import { isResponse, requireAdmin } from "@/lib/auth";
import { listChannels, setChannelActive } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const who = await requireAdmin();
  if (isResponse(who)) return who;
  try {
    return NextResponse.json(await listChannels());
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) }, { status: 500 },
    );
  }
}

// PATCH { chatId: string, active: boolean }
export async function PATCH(req: NextRequest) {
  const who = await requireAdmin();
  if (isResponse(who)) return who;
  const body = await req.json();
  await setChannelActive(String(body.chatId), Boolean(body.active));
  return NextResponse.json({ ok: true });
}
