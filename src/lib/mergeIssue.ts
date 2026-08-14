import { prisma } from "@/lib/prisma";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";
import { issueLinks } from "@/lib/report";

// Схлопывает source в target: ссылки съезжаются в target, привязанные
// сообщения перецепляются туда же, source удаляется. Общая логика между
// POST /api/issues/[id]/merge-into (сайт) и разбором дублей из Telegram
// (dedupeReview.ts) — раньше жила только в роуте, вынесена сюда, чтобы не
// дублировать транзакцию в двух местах.
export async function mergeIssueInto(
  sourceId: string,
  targetId: string,
  actorName: string
) {
  const [source, target] = await Promise.all([
    prisma.issue.findUnique({ where: { id: sourceId } }),
    prisma.issue.findUnique({ where: { id: targetId } }),
  ]);
  if (!source || !target) return null;

  const mergedLinks = Array.from(
    new Set([...issueLinks(target), ...issueLinks(source)])
  ).filter((link) => link !== target.telegramLink);

  return prisma.$transaction(async (tx) => {
    const nextTarget = await tx.issue.update({
      where: { id: target.id },
      data: {
        extraLinks: mergedLinks,
        createdBy:
          target.createdBy === AUTO_ISSUE_CREATOR ? actorName : undefined,
      },
    });

    await tx.telegramMessage.updateMany({
      where: { usedForIssueId: source.id },
      data: { usedForIssueId: target.id },
    });

    await tx.issue.delete({ where: { id: source.id } });

    return nextTarget;
  });
}
