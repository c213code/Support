import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { isReconcileScope, MAX_CHAT_MESSAGE, type ReconcileChatOptions } from "@/lib/reconcileChat";
import { runsForDay, startRun } from "@/lib/reconcileRun";

// Журнал «Авто-репорта» за день: запуски и решения по тикетам.
export async function GET(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const date = request.nextUrl.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }
  return NextResponse.json(await runsForDay(date));
}

// Новый запуск разбора по дню. Сам ничего не разбирает — только заводит
// список тикетов; разбирает их /api/reconcile/[runId]/step по нескольку.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { reportDate?: unknown; instruction?: unknown; scope?: unknown; previousRunId?: unknown } | null;
  const reportDate = typeof body?.reportDate === "string" ? body.reportDate : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
    return NextResponse.json({ error: "reportDate must be YYYY-MM-DD" }, { status: 400 });
  }
  if (body?.instruction !== undefined &&
      (typeof body.instruction !== "string" || !body.instruction.trim() || body.instruction.length > MAX_CHAT_MESSAGE)) {
    return NextResponse.json({ error: `Напишите сообщение от 1 до ${MAX_CHAT_MESSAGE} символов` }, { status: 400 });
  }
  if (body?.scope !== undefined && !isReconcileScope(body.scope)) {
    return NextResponse.json({ error: "Неизвестная область поиска" }, { status: 400 });
  }
  if (body?.previousRunId !== undefined && (typeof body.previousRunId !== "string" || body.previousRunId.length > 100)) {
    return NextResponse.json({ error: "Неверный диалог" }, { status: 400 });
  }
  const options: ReconcileChatOptions = {
    instruction: body?.instruction as string | undefined,
    scope: body?.scope as ReconcileChatOptions["scope"],
    previousRunId: body?.previousRunId as string | undefined,
  };
  try {
    const run = await startRun(reportDate, identity.name, options);
    return NextResponse.json({ runId: run.id });
  } catch (error) {
    if (error instanceof Error && /^(Диалог не найден|В диалоге уже)/.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[reconcile] start failed", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Не удалось начать разбор. Попробуйте ещё раз." }, { status: 500 });
  }
}
