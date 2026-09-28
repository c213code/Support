import { prisma } from "@/lib/prisma";
import { changeIssueStatus } from "@/lib/issueStatus";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { isChatIntentEnabled } from "@/lib/settings";
import { isOwnAgentMessage, type TelegramMessageReaction } from "@/lib/telegram";

// Реакция агента на обращение — «ок, қараймын» без слов: 👌 на пост
// «Өтініш #…» или на сообщение куратора. Раньше тикет от неё не менялся и
// висел «Отправлено», хотя дежурный уже взялся; куратор видел под постом
// «кезекші қарайды» до самого решения.
//
// Поэтому реакция своего агента переводит тикет «Отправлено» → «В работе».
// Только из «Отправлено»: реакцию ставят и на решённое («рахмет» → 👍), и
// откатывать статус по ней нельзя. Какая именно реакция — не важно: любая
// значит «увидел», а «решено» реакцией не ставится — ему нужна заметка.
// Снятая реакция ничего не откатывает.
//
// Тот же рубильник, что у реплик агентов (chatIntentEnabled, «👂 Читать мои
// ответы»): и то и другое молча меняет статус, который уйдёт в репорт.
// source "chat": в группе реакцию уже видно — бот туда не пишет, только
// обновляет строку статуса под своим постом.
export async function applyAgentReaction(reaction: TelegramMessageReaction): Promise<void> {
  const userId = reaction.user?.id;
  if (!userId || reaction.user?.is_bot || !isOwnAgentMessage(userId)) return;
  const added = reaction.new_reaction.some(
    (r) => !reaction.old_reaction.some((o) => JSON.stringify(o) === JSON.stringify(r))
  );
  if (!added) return;
  if (!(await isChatIntentEnabled())) return;

  const issueId = await issueForMessage(String(reaction.chat.id), reaction.message_id);
  if (!issueId) return;
  const issue = await prisma.issue.findUnique({ where: { id: issueId }, select: { status: true } });
  if (issue?.status !== "SENT") return;

  await changeIssueStatus({
    issueId,
    status: "IN_PROGRESS",
    actor: telegramIdToAgent(userId),
    source: "chat",
  });
}

// К какому тикету сообщение: пост бота («Өтініш #…», подтверждение приёма)
// знает BotReply, сообщение куратора — TelegramMessage.usedForIssueId.
async function issueForMessage(chatId: string, messageId: number): Promise<string | null> {
  const post = await prisma.botReply.findFirst({
    where: { chatId, messageId, deleted: false },
    select: { issueId: true },
  });
  if (post) return post.issueId;
  const message = await prisma.telegramMessage.findUnique({
    where: { chatId_messageId: { chatId, messageId } },
    select: { usedForIssueId: true },
  });
  return message?.usedForIssueId ?? null;
}
