import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { cleanTicketDescription } from "@/lib/textClean";

// Разовое ручное действие с кнопки на доске: перегоняет уже существующие
// тикеты "Отправлено" через cleanTicketDescription — для тех, что успели
// завестись до того, как автоочистка вебхука начала применяться к
// описанию, и всё ещё занимают место ссылками/приветствиями/логинами.
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

  const issues = await prisma.issue.findMany({
    where: { reportDate: body.reportDate, status: "SENT" },
    select: { id: true, description: true },
  });

  const updates = issues
    .map((issue) => ({
      id: issue.id,
      original: issue.description,
      cleaned: cleanTicketDescription(issue.description),
    }))
    .filter((issue) => issue.cleaned !== issue.original);

  await Promise.all(
    updates.map(({ id, cleaned }) =>
      prisma.issue.update({ where: { id }, data: { description: cleaned } })
    )
  );

  return NextResponse.json({ ok: true, updated: updates.length });
}
