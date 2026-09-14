import { prisma } from "@/lib/prisma";
import type { IssueStatus } from "@/lib/status";
import { sendTelegramMessage } from "@/lib/telegram";
import { isSubmitterNotifyEnabled } from "@/lib/settings";

// Ответ автору обращения, поданного формой мини-аппа: бот пишет ему в личку,
// когда дежурный двигает статус.
//
// Для таких тикетов это единственный канал обратной связи. У обращения из
// рабочей группы есть сообщение, на которое бот отвечает «жұмысқа алдық»
// (см. reactToStatusChange); у обращения из формы сообщения в группе нет —
// reactToStatusChange по нему молчит, и куратор отправлял заявку в пустоту.
//
// Текст — на казахском, как и вся форма: пишем тому же человеку, который её
// заполнял.
const STATUS_TEXT: Partial<Record<IssueStatus, string>> = {
  IN_PROGRESS: "🔄 Өтінішіңіз жұмысқа алынды",
  PENDING: "⏳ Өтінішіңіз күтуде — жаңалық болса, хабарлаймыз",
  ESCALATED: "⚠️ Өтінішіңіз басқа командаға берілді",
  RESOLVED: "✅ Өтінішіңіз шешілді",
};

// note — заметка, которую дежурный написал в этот же момент («как решили»):
// в ней и есть ответ, ради которого куратор писал.
export async function notifySubmitter(
  issueId: string,
  status: IssueStatus,
  note?: string | null
): Promise<void> {
  // SENT — исходный статус обращения, сообщать о нём нечего.
  const line = STATUS_TEXT[status];
  if (!line) return;

  try {
    if (!(await isSubmitterNotifyEnabled())) return;

    const submission = await prisma.issueSubmission.findUnique({
      where: { issueId },
      select: {
        telegramUserId: true,
        issue: { select: { description: true, note: true } },
      },
    });
    // Обычный тикет из группы — там у бота свои ответы, дублировать в личку
    // некому и незачем.
    if (!submission) return;

    const parts = [line, "", `«${submission.issue.description}»`];
    // Итог показываем только на «решено»: на промежуточных статусах в заметке
    // лежит рабочая пометка дежурного, а не ответ куратору.
    const outcome = status === "RESOLVED" ? (note ?? submission.issue.note)?.trim() : null;
    if (outcome) parts.push("", outcome);

    const sent = await sendTelegramMessage(Number(submission.telegramUserId), parts.join("\n"));
    if (!sent) {
      // Частый и безобидный случай — куратор заблокировал бота; причину
      // (403 и т.п.) уже написал callBotApi строкой [telegram] sendMessage.
      console.warn(`[miniapp] автор обращения ${issueId} не получил статус ${status}`);
    }
  } catch (err) {
    // Сообщить автору — приятный довесок к смене статуса, а не её часть:
    // упавшая база или Telegram не должны отменять сам перевод тикета.
    console.warn(`[miniapp] не смог сообщить автору обращения ${issueId}: ${String(err).slice(0, 200)}`);
  }
}
