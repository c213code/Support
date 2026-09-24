import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { applyVerdicts, type ApplyItem } from "@/lib/reconcileRun";
import type { IssueStatus } from "@/lib/status";

type Params = { params: Promise<{ runId: string }> };

// Применить решения, которые человек отметил в окне «Авто-репорт».
export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { runId } = await params;
  // items: [{ verdictId, status? }] — status, если человек выбрал свой.
  // Статус проверяет applyVerdicts: применимы только «Решено», «В работе»
  // и «Пендинг»; «Передано» идёт через обычное окно передачи с командой.
  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const items: ApplyItem[] = Array.isArray(body?.items)
    ? body.items.flatMap((raw): ApplyItem[] => {
        const item = raw as { verdictId?: unknown; status?: unknown };
        if (typeof item?.verdictId !== "string") return [];
        return [
          {
            verdictId: item.verdictId,
            status: typeof item.status === "string" ? (item.status as IssueStatus) : undefined,
          },
        ];
      })
    : [];
  if (items.length === 0) {
    return NextResponse.json({ error: "Ничего не отмечено" }, { status: 400 });
  }
  const outcomes = await applyVerdicts(runId, items, identity.name);
  return NextResponse.json({ outcomes });
}
