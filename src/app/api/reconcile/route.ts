import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { runsForDay, startRun } from "@/lib/reconcileRun";

// Журнал «Авто-репорта» за день: запуски и решения по тикетам.
export async function GET(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const date = request.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  return NextResponse.json({ runs: await runsForDay(date) });
}

// Новый запуск разбора по дню. Сам ничего не разбирает — только заводит
// список тикетов; разбирает их /api/reconcile/[runId]/step по нескольку.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { reportDate?: unknown } | null;
  const reportDate = typeof body?.reportDate === "string" ? body.reportDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    return NextResponse.json({ error: "reportDate must be YYYY-MM-DD" }, { status: 400 });
  }
  const run = await startRun(reportDate, identity.name);
  return NextResponse.json({ runId: run.id });
}
