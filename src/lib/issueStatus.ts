import { prisma } from "@/lib/prisma";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { setMessageReaction } from "@/lib/telegram";
import { buildStatusReplyText, pickLanguage } from "@/lib/autoReply";
import { sendBotReply, type BotReplyKind } from "@/lib/botReply";

// Откуда пришла смена статуса. Различать обязательно: если статус
// изменился потому, что агент сам написал в группу ("әріптестеріме
// жібердім"), то отвечать туда же тем же самым — значит попугайничать за
// живым человеком. Правило одно: бот пишет в группу только то, чего там
// ещё не прозвучало.
export type StatusChangeSource =
  // Сайт или кнопка в разборе — в группе об этом ещё не знают, бот пишет.
  | "app"
  // Разбор собственной реплики агента в группе — там уже всё сказано,
  // бот молчит и только двигает статус.
  | "chat";

// Реакция бота на смену статуса: эмодзи на исходном сообщении (👀 взяли,
// 👍 решили) плюс, если включены автоответы, текстовый ответ реплаем.
// Общая для PATCH /api/issues/[id] (сайт) и callback-кнопок в Telegram,
// чтобы эти два места не разъезжались логикой.
export async function reactToStatusChange(
  previousStatus: IssueStatus,
  nextStatus: IssueStatus,
  telegramLink: string | null,
  source: StatusChangeSource = "app",
  issueId?: string
): Promise<void> {
  if (nextStatus === previousStatus || !telegramLink) return;

  const emoji = STATUS_META[nextStatus].reactionEmoji;
  const message = await prisma.telegramMessage.findFirst({
    where: { messageLink: telegramLink },
    select: { chatId: true, messageId: true, text: true },
  });
  if (!message) return;

  await setMessageReaction(message.chatId, message.messageId, emoji);

  // "Решено" сюда не попадает намеренно: это единственный ответ, который
  // утверждает факт, поэтому уходит только после подтверждения человеком
  // (см. ISSUE_RESOLVE_PREFIX в вебхуке), а не автоматически при смене
  // статуса.
  if (source !== "app" || !issueId || nextStatus === "RESOLVED") return;

  const text = buildStatusReplyText(
    nextStatus,
    pickLanguage(message.text ?? "")
  );
  if (!text) return;

  await sendBotReply({
    issueId,
    chatId: message.chatId,
    replyToMessageId: message.messageId,
    kind: nextStatus as BotReplyKind,
    text,
  });
}
