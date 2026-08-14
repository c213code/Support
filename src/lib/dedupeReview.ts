import { prisma } from "@/lib/prisma";
import { findDuplicateGroups } from "@/lib/ai";
import { mergeIssueInto } from "@/lib/mergeIssue";
import { sendTelegramMessage, editMessageText, escapeHtml, type InlineKeyboard } from "@/lib/telegram";
import { DEDUPE_MERGE_PREFIX, DEDUPE_SKIP_PREFIX } from "@/lib/telegramCallbacks";

type DupeIssue = { id: string; groupName: string; description: string; position: number };

function buildDedupeCard(group: DupeIssue[], position: number, total: number) {
  const list = group
    .map((issue, idx) => `${idx + 1}. ${escapeHtml(issue.description)}`)
    .join("\n\n");
  const text = `🔗 Похожие ${position}/${total}\n\n${escapeHtml(group[0].groupName)}\n\n${list}\n\nОбъединить в один тикет (останется самый ранний, ${group.length - 1} остальных удалятся, ссылки переедут)?`;
  const keyboard: InlineKeyboard = [
    [
      { text: "✅ Объединить", callback_data: DEDUPE_MERGE_PREFIX },
      { text: "⏭ Пропустить", callback_data: DEDUPE_SKIP_PREFIX },
    ],
  ];
  return { text, keyboard };
}

// Запускает разбор похожих тикетов дня по кнопке "🔗 Найти дубли" под
// вечерней сводкой — та же ИИ-подсказка, что и у "Найти дубли" во
// "Входящих" (findDuplicateGroups), только вместо панели на сайте здесь
// группы идут по одной, как и разбор тикетов (см. startReviewSession в
// dailyReview.ts). Ничего не объединяет автоматически — только предлагает,
// решение за агентом на каждой группе.
export async function startDedupeReview(recipientId: number, reportDate: string): Promise<void> {
  if (!process.env.GROQ_API_KEY) {
    await sendTelegramMessage(recipientId, "ИИ недоступен — проверь GROQ_API_KEY");
    return;
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate },
    orderBy: { position: "asc" },
    select: { id: true, groupName: true, description: true, position: true },
  });
  if (issues.length < 2) {
    await sendTelegramMessage(recipientId, "Дублей искать не среди чего — тикетов меньше двух");
    return;
  }

  const rawGroups = await findDuplicateGroups(
    issues.map((i) => ({ id: i.id, description: i.description }))
  );
  if (rawGroups === null) {
    await sendTelegramMessage(recipientId, "ИИ недоступен, попробуй позже");
    return;
  }

  const byId = new Map(issues.map((i) => [i.id, i]));
  const groups = rawGroups
    .map((ids) => ids.map((id) => byId.get(id)).filter((i): i is DupeIssue => i != null))
    .filter((group) => group.length >= 2);

  if (groups.length === 0) {
    await sendTelegramMessage(recipientId, "Дублей не нашлось 🎉");
    return;
  }

  const chatId = String(recipientId);
  const sortedGroups = groups.map((g) => [...g].sort((a, b) => a.position - b.position));
  const card = buildDedupeCard(sortedGroups[0], 1, sortedGroups.length);
  const sent = await sendTelegramMessage(recipientId, card.text, card.keyboard, undefined, "HTML");
  if (!sent) return;

  const groupsJson = JSON.stringify(sortedGroups.map((g) => g.map((i) => i.id)));
  await prisma.duplicateReviewSession.upsert({
    where: { chatId },
    update: { reportDate, messageId: sent.message_id, groupsJson, currentIndex: 0 },
    create: { chatId, reportDate, messageId: sent.message_id, groupsJson },
  });
}

// Обрабатывает "✅ Объединить"/"⏭ Пропустить" на текущей группе и
// переходит к следующей — merge всегда схлопывает в самый ранний по
// position тикет группы (та же логика, что у handleMergeDuplicateGroup на
// сайте).
export async function advanceDedupeReview(chatId: string, merge: boolean, actorName: string): Promise<void> {
  const session = await prisma.duplicateReviewSession.findUnique({ where: { chatId } });
  if (!session) return;

  const groups: string[][] = JSON.parse(session.groupsJson);
  const currentIds = groups[session.currentIndex];

  if (merge && currentIds && currentIds.length >= 2) {
    const [targetId, ...sourceIds] = currentIds;
    for (const sourceId of sourceIds) {
      await mergeIssueInto(sourceId, targetId, actorName);
    }
  }

  const nextIndex = session.currentIndex + 1;
  if (nextIndex >= groups.length) {
    await editMessageText(chatId, session.messageId, "✅ Разбор похожих тикетов завершён!", null);
    await prisma.duplicateReviewSession.delete({ where: { chatId } });
    return;
  }

  const nextIds = groups[nextIndex];
  const nextIssues = await prisma.issue.findMany({
    where: { id: { in: nextIds } },
    select: { id: true, groupName: true, description: true, position: true },
  });
  // Группа могла частично исчезнуть между стартом разбора и этим шагом
  // (например, тикет уже объединили или удалили руками на сайте) —
  // тогда группа больше не валидна, просто идём дальше.
  if (nextIssues.length < 2) {
    await prisma.duplicateReviewSession.update({ where: { chatId }, data: { currentIndex: nextIndex } });
    await advanceDedupeReview(chatId, false, actorName);
    return;
  }

  const ordered = nextIds
    .map((id) => nextIssues.find((i) => i.id === id))
    .filter((i): i is DupeIssue => i != null);
  const card = buildDedupeCard(ordered, nextIndex + 1, groups.length);
  await editMessageText(chatId, session.messageId, card.text, card.keyboard, "HTML");
  await prisma.duplicateReviewSession.update({ where: { chatId }, data: { currentIndex: nextIndex } });
}
