import { NextResponse, type NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { featureAgentState, LOCAL_FEATURE_AGENT_ID } from "@/lib/featureAgentState";

export async function GET() {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const control = await prisma.localFeatureAgentControl.findUnique({ where: { id: LOCAL_FEATURE_AGENT_ID } });
  return NextResponse.json(featureAgentState(control, todayDateString()), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be boolean" }, { status: 400 });
  }
  const control = await prisma.localFeatureAgentControl.upsert({
    where: { id: LOCAL_FEATURE_AGENT_ID },
    create: { id: LOCAL_FEATURE_AGENT_ID, enabled: body.enabled },
    update: { enabled: body.enabled },
  });
  return NextResponse.json(featureAgentState(control, todayDateString()));
}
