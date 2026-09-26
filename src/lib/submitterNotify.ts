import { prisma } from "@/lib/prisma";
import type { IssueStatus } from "@/lib/status";
import { sendTelegramMessage, sendWebAppButton } from "@/lib/telegram";
import { isSubmitterNotifyEnabled } from "@/lib/settings";
import { miniAppUrl, submissionFormEnabled } from "@/lib/miniapp";
import { STATUS_KK } from "@/lib/statusKk";
import { buildSummary, findLabel } from "@/lib/submissionLabels";
import { cleanTicketDescription } from "@/lib/textClean";

// Ответ автору обращения, поданного формой мини-аппа: бот пишет ему в личку,
// когда дежурный двигает статус.
//
// Для таких тикетов это единственный канал обратной связи. У обращения из
// рабочей группы есть сообщение, на которое бот отвечает «жұмысқа алдық»
// (см. reactToStatusChange); у обращения из формы сообщения в группе нет —
// reactToStatusChange по нему молчит, и куратор отправлял заявку в пустоту.
//
// Авторов может быть несколько: одну поломку присылают разные кураторы, и
// после склейки их заявки живут на одном тикете (mergeIssue.ts). Пишем
// каждому — узнать, чем кончилось, нужно всем, кто спрашивал.
//
// Текст — на казахском, как и мини-апп; слова статусов общие с его списком
// (statusKk.ts).

// note — заметка, которую дежурный написал в этот же момент («как решили»):
// в ней и есть ответ, ради которого куратор писал.
export async function notifySubmitter(
  issueId: string,
  status: IssueStatus,
  note?: string | null
): Promise<void> {
  // SENT — исходный статус обращения, сообщать о нём нечего.
  const notice = STATUS_KK[status].notice;
  if (!notice) return;

  try {
    if (!(await isSubmitterNotifyEnabled())) return;

    const submissions = await prisma.issueSubmission.findMany({
      where: { issueId },
      orderBy: { createdAt: "asc" },
      select: { telegramUserId: true, labelId: true, labelFields: true },
    });
    // Обычный тикет из группы — там у бота свои ответы, дублировать в личку
    // некому и незачем.
    if (submissions.length === 0) return;

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { description: true, note: true, groupName: true },
    });
    if (!issue) return;

    // Куратору цитируем его же обращение — «ярлык — что он написал», как
    // было при подаче. Описание тикета на сайте пишет ИИ коротко
    // (rewriteSubmissionDescription), но это для доски и репорта, а в личке
    // человек должен узнать свои слова.
    const first = submissions[0];
    const label = first.labelId ? findLabel(issue.groupName, first.labelId) : null;
    const summary = label
      ? buildSummary(label, (first.labelFields ?? {}) as Record<string, string | string[]>)
      : null;
    const quote = summary ? cleanTicketDescription(summary) || summary : issue.description;

    const parts = [`${STATUS_KK[status].emoji} ${notice}`, "", `«${quote}»`];
    // Итог показываем только на «решено»: на промежуточных статусах в заметке
    // лежит рабочая пометка дежурного, а не ответ куратору.
    const outcome = status === "RESOLVED" ? (note ?? issue.note)?.trim() : null;
    if (outcome) parts.push("", outcome);
    const text = parts.join("\n");

    // Кнопка «Көру» открывает мини-апп сразу на списке своих обращений. Без
    // адреса мини-аппа (или с выключенной формой) — обычное сообщение.
    const baseUrl = submissionFormEnabled() ? miniAppUrl() : null;
    const listUrl = baseUrl ? withMineTab(baseUrl) : null;

    const recipients = [...new Set(submissions.map((s) => s.telegramUserId.toString()))];
    for (const recipient of recipients) {
      const chatId = Number(recipient);
      const sent = listUrl
        ? await sendWebAppButton(chatId, text, "📋 Көру", listUrl)
        : Boolean(await sendTelegramMessage(chatId, text));
      if (!sent) {
        // Частый и безобидный случай — куратор заблокировал бота; причину
        // (403 и т.п.) уже написал callBotApi строкой [telegram] sendMessage.
        console.warn(`[miniapp] автор обращения ${issueId} не получил статус ${status}`);
      }
    }
  } catch (err) {
    // Сообщить автору — приятный довесок к смене статуса, а не её часть:
    // упавшая база или Telegram не должны отменять сам перевод тикета.
    console.warn(
      `[miniapp] не смог сообщить автору обращения ${issueId}: ${String(err).slice(0, 200)}`
    );
  }
}

function withMineTab(url: string): string {
  const withTab = new URL(url);
  withTab.searchParams.set("tab", "mine");
  return withTab.toString();
}
