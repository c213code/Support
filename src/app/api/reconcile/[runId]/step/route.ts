import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { stepRun } from "@/lib/reconcileRun";

// Модели отвечают по 3–8 секунд на тикет, с повтором при перегрузке — дольше.
export const maxDuration = 120;

type Params = { params: Promise<{ runId: string }> };

// Разобрать следующие несколько тикетов запуска. Окно вызывает это в цикле,
// пока remaining не станет 0, и показывает прогресс.
export async function POST(_request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { runId } = await params;
  return NextResponse.json(await stepRun(runId));
}
