import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";
import { issueLinks } from "@/lib/report";

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

  const [source, target] = await Promise.all([
    prisma.issue.findUnique({ where: { id } }),
    prisma.issue.findUnique({ where: { id: body.targetId } }),
  ]);

  if (!source || !target) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }

  // Ссылки обоих тикетов без дублей; порядок сохраняем — сначала то, что
  // уже было в целевом.
  const mergedLinks = Array.from(
    new Set([...issueLinks(target), ...issueLinks(source)])
  ).filter((link) => link !== target.telegramLink);

  const updated = await prisma.$transaction(async (tx) => {
    const nextTarget = await tx.issue.update({
      where: { id: target.id },
      data: {
        extraLinks: mergedLinks,
        createdBy:
          target.createdBy === AUTO_ISSUE_CREATOR ? identity.name : undefined,
      },
    });

    // Сообщения, которые вели на схлопнутый тикет, должны вести на
    // целевой — иначе во "Входящих" останутся кнопки в никуда.
    await tx.telegramMessage.updateMany({
      where: { usedForIssueId: source.id },
      data: { usedForIssueId: target.id },
    });

    await tx.issue.delete({ where: { id: source.id } });

    return nextTarget;
  });

  return NextResponse.json({ issue: updated });
}
