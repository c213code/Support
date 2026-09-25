import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { stepRun } from "@/lib/reconcileRun";

// Шаг — 3–6 тикетов одновременно (см. stepRun), так что он длится как самый
// медленный из них: в худшем случае таймаут 110 с, пауза 3 с и повтор ещё
// 110 с — 223 с из 300.
export const maxDuration = 300;

type Params = { params: Promise<{ runId: string }> };

// Разобрать следующие несколько тикетов запуска. Окно вызывает это в цикле,
// пока remaining не станет 0, и показывает прогресс.
export async function POST(_request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { runId } = await params;
  return NextResponse.json(await stepRun(runId));
}
