import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { mergeIssueInto } from "@/lib/mergeIssue";

type Params = { params: Promise<{ id: string }> };

// Схлопывает тикет [id] в тикет targetId: все его ссылки переезжают в
// целевой, привязанные сообщения перецепляются туда же, исходный тикет
// удаляется.
//
// Нужно именно объединение тикетов, а не только приклеивание сообщений:
// для чата с уже известной группой вебхук заводит тикет на КАЖДОЕ
// сообщение, так что три просьбы про один и тот же доступ приезжают на
// доску тремя карточками — объединять приходится уже готовые тикеты.
export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.targetId !== "string") {
    return NextResponse.json({ error: "targetId is required" }, { status: 400 });
  }
  if (body.targetId === id) {
    return NextResponse.json(
      { error: "cannot merge an issue into itself" },
      { status: 400 }
    );
  }

  const updated = await mergeIssueInto(id, body.targetId, identity.name);
  if (!updated) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }

  return NextResponse.json({ issue: updated });
}
