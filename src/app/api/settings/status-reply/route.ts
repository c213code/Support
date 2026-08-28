import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { isStatusReplyEnabled, setStatusReplyEnabled } from "@/lib/settings";

export async function GET() {
  const enabled = await isStatusReplyEnabled();
  return NextResponse.json({ enabled });
}

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }

  await setStatusReplyEnabled(body.enabled);
  return NextResponse.json({ enabled: body.enabled });
}
