import { prisma } from "@/lib/prisma";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { setMessageReaction } from "@/lib/telegram";

// Реакция бота на исходное сообщение при смене статуса — общая для
// PATCH /api/issues/[id] (смена через сайт) и callback-кнопок в Telegram
// (смена прямо в чате, см. handleCallbackQuery в вебхуке), чтобы эти два
// места не разъезжались логикой.
export async function reactToStatusChange(
  previousStatus: IssueStatus,
  nextStatus: IssueStatus,
  telegramLink: string | null
): Promise<void> {
  if (nextStatus === previousStatus || !telegramLink) return;

  const emoji = STATUS_META[nextStatus].reactionEmoji;
  const message = await prisma.telegramMessage.findFirst({
    where: { messageLink: telegramLink },
    select: { chatId: true, messageId: true },
  });
  if (message) {
    await setMessageReaction(message.chatId, message.messageId, emoji);
  }
}
