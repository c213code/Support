import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { applyVerdicts } from "@/lib/reconcileRun";

type Params = { params: Promise<{ runId: string }> };

// Применить решения, которые человек отметил в окне «Авто-репорт».
export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { runId } = await params;
  const body = (await request.json().catch(() => null)) as { verdictIds?: unknown } | null;
  const verdictIds = Array.isArray(body?.verdictIds)
    ? body.verdictIds.filter((id): id is string => typeof id === "string")
    : [];
  if (verdictIds.length === 0) {
    return NextResponse.json({ error: "Ничего не отмечено" }, { status: 400 });
  }
  const outcomes = await applyVerdicts(runId, verdictIds, identity.name);
  return NextResponse.json({ outcomes });
}
