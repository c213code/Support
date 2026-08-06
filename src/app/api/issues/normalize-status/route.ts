import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";

// Разовое ручное действие с кнопки "Пендинг → Отправлено": PENDING был
// старым дефолтным статусом для новых тикетов до перехода на SENT, так что
// тикеты в этом статусе за выбранный день никто осознанно не выставлял —
// переносим их в "Отправлено", не трогая тикеты с явно выбранными статусами.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body?.reportDate) {
    return NextResponse.json(
      { error: "reportDate is required" },
      { status: 400 }
    );
  }

  const result = await prisma.issue.updateMany({
    where: { reportDate: body.reportDate, status: "PENDING" },
    data: { status: "SENT" },
  });

  return NextResponse.json({ ok: true, updated: result.count });
}
