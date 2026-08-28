import { prisma } from "@/lib/prisma";
import { stemSimilarity } from "@/lib/similarity";

// «Про одно и то же пишут несколько человек».
//
// Типичная картина: в 16:09 методист пишет "квал тесттер мүлдем шықпайды",
// в 16:11 второй — "менде КВАЛЛ тамыз 2026 - куратор деген курс жоқ", в
// 16:13 третий про то же. Это одна поломка, а не три задачи: отвечать
// каждому отдельно значит трижды написать одно и то же и завести три
// тикета, которые вечером придётся схлопывать руками.
//
// Ищем только кандидата. Решение — за человеком: по выгрузке видно, почему.
// Обращения в этих чатах устроены одинаково ("имя, почта, ссылка керек"),
// поэтому текстовая похожесть уверенно находит и настоящие совпадения, и
// пять разных заявок подряд одного формата. Отличить их можно только по
// сути, и дешевле спросить, чем ошибиться: склейка удаляет тикет.

// Насколько назад смотрим. Люди подхватывают чужую жалобу почти сразу —
// в примере выше все три сообщения уложились в четыре минуты.
const WINDOW_MINUTES = 30;

// Порог похожести по основам слов. Разные люди про одну поломку пишут
// сильно по-разному ("квал тесттер мүлдем шықпайды" и "КВАЛЛ тамыз 2026 -
// куратор деген курс жоқ болып тұр"), общих основ у них немного — отсюда
// невысокий порог. Он же ловит и однотипные по форме, но разные по сути
// заявки; поэтому кандидат только предлагается кнопкой, а не склеивается
// сам.
const MIN_SIMILARITY = 0.15;

const OPEN_STATUSES = ["SENT", "IN_PROGRESS", "PENDING"] as const;

export type RelatedIssue = {
  id: string;
  description: string;
  authorName: string | null;
  minutesAgo: number;
};

export async function findRelatedRecentIssue(params: {
  chatId: string;
  issueId: string;
  description: string;
  authorId: bigint | null;
}): Promise<RelatedIssue | null> {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

  // Сообщения этого чата за окно, у которых есть свой тикет. Через
  // сообщения, а не через Issue: связь "чат → тикет" живёт именно там.
  const recent = await prisma.telegramMessage.findMany({
    where: {
      chatId: params.chatId,
      receivedAt: { gte: since },
      usedForIssueId: { not: null },
    },
    select: {
      usedForIssueId: true,
      fromId: true,
      authorName: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: "desc" },
    take: 30,
  });

  const candidates = recent.filter(
    (m) =>
      m.usedForIssueId !== params.issueId &&
      // Тот же человек — это уточнение к своему же обращению, им занимается
      // attachFollowUpToTicket. Здесь речь про РАЗНЫХ людей.
      (params.authorId == null || m.fromId !== params.authorId)
  );
  if (candidates.length === 0) return null;

  const issues = await prisma.issue.findMany({
    where: {
      id: {
        in: Array.from(
          new Set(
            candidates
              .map((m) => m.usedForIssueId)
              .filter((id): id is string => id != null)
          )
        ),
      },
      status: { in: [...OPEN_STATUSES] },
    },
    select: { id: true, description: true },
  });
  if (issues.length === 0) return null;

  let best: RelatedIssue | null = null;
  let bestScore = MIN_SIMILARITY;
  for (const issue of issues) {
    const score = stemSimilarity(params.description, issue.description);
    if (score < bestScore) continue;
    const message = candidates.find((m) => m.usedForIssueId === issue.id);
    bestScore = score;
    best = {
      id: issue.id,
      description: issue.description,
      authorName: message?.authorName ?? null,
      minutesAgo: message
        ? Math.max(0, Math.round((Date.now() - message.receivedAt.getTime()) / 60000))
        : 0,
    };
  }
  return best;
}
