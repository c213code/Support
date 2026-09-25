import { prisma } from "@/lib/prisma";
import { escapeHtml, sendTelegramMessage } from "@/lib/telegram";
import { STATUS_KK } from "@/lib/statusKk";
import type { IssueStatus } from "@/lib/status";
import { ticketShortCode, ticketUrl } from "@/lib/miniapp";
import { pickRecipient } from "@/lib/dailyReview";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { formatTimeAlmaty, todayDateString } from "@/lib/date";

// «КБ сұрау» — куратор из мини-аппа спрашивает, что с его обращением (КБ —
// кері байланыс, обратная связь). Раньше он писал в группу «қарадыңыздар
// ма?» словами, и такой вопрос тонул среди новых обращений; теперь бот
// отвечает реплаем прямо на пост «Өтініш #…» этого обращения и отмечает
// дежурного — вопрос привязан к заявке, видно статус и сколько уже ждут.
//
// В группу, а не в личку дежурному: так решили, чтобы вопрос видели и
// коллеги, — любой, кто знает ответ, может ответить реплаем. Пока отправка
// обращений в группы выключена, пост лежит в служебном канале — туда же
// уходит и вопрос (та же репетиция). Поста нет вовсе (старая заявка, группа
// не привязана) — вопрос уходит дежурному в личку, чтобы не потеряться.

export const FEEDBACK_KIND = "FEEDBACK_REQUEST";
// Не раньше чем через полчаса после подачи — сразу спрашивать «что там?»
// бессмысленно, а кнопка под рукой.
const MIN_AGE_MS = 30 * 60 * 1000;
// И не чаще раза в час — иначе кнопка превращается в спам в группе.
const COOLDOWN_MS = 60 * 60 * 1000;

export type FeedbackAvailability = { canAsk: boolean; nextAt: Date | null };

export function feedbackAvailability(opts: {
  status: IssueStatus;
  submittedAt: Date;
  lastAskedAt: Date | null;
  now?: Date;
}): FeedbackAvailability {
  if (opts.status === "RESOLVED") return { canAsk: false, nextAt: null };
  const now = opts.now ?? new Date();
  const next = new Date(
    Math.max(
      opts.submittedAt.getTime() + MIN_AGE_MS,
      opts.lastAskedAt ? opts.lastAskedAt.getTime() + COOLDOWN_MS : 0
    )
  );
  return now >= next ? { canAsk: true, nextAt: null } : { canAsk: false, nextAt: next };
}

// Когда по каждому тикету последний раз просили КБ.
export async function lastFeedbackAt(issueIds: string[]): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = await prisma.botReply.groupBy({
    by: ["issueId"],
    where: { issueId: { in: issueIds }, kind: FEEDBACK_KIND },
    _max: { sentAt: true },
  });
  return new Map(
    rows.filter((r) => r._max.sentAt).map((r) => [r.issueId, r._max.sentAt as Date])
  );
}

// «40 минут», «3 сағат», «2 күн» — сколько куратор уже ждёт.
export function waitedKk(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} минут`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} сағат`;
  return `${Math.round(hours / 24)} күн`;
}

// Текст вопроса в группу. Чистая функция — проверяется без Telegram.
export function buildFeedbackRequest(opts: {
  issueId: string;
  authorName: string;
  telegramUserId: bigint;
  status: IssueStatus;
  waitedMs: number;
  dutyId: number | null;
  dutyName: string | null;
}): { html: string; plain: string } {
  const code = `Өтініш #${ticketShortCode(opts.issueId)}`;
  const url = ticketUrl(opts.issueId);
  const kk = STATUS_KK[opts.status];
  const author = `<a href="tg://user?id=${opts.telegramUserId}">${escapeHtml(opts.authorName)}</a>`;
  const codeHtml = url ? `<a href="${escapeHtml(url)}">${code}</a>` : code;
  const state = `Күйі: ${kk.emoji} ${kk.label} · күтіп тұрғанына ${waitedKk(opts.waitedMs)}`;
  const dutyName = opts.dutyName ?? "Кезекші";
  const askHtml = opts.dutyId
    ? `<a href="tg://user?id=${opts.dutyId}">${escapeHtml(dutyName)}</a>, қарап жібересіз бе?`
    : null;
  const html = [`🔔 ${author} кері байланыс сұрайды: ${codeHtml}`, escapeHtml(state), askHtml]
    .filter(Boolean)
    .join("\n");
  const plain = [
    `🔔 ${opts.authorName} кері байланыс сұрайды: ${code}`,
    state,
    opts.dutyId ? `${dutyName}, қарап жібересіз бе?` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { html, plain };
}

export type FeedbackResult =
  | { ok: true; via: "group" | "dm" }
  | { ok: false; status: number; error: string };

// Спросить КБ по обращению. Право проверяется здесь же: только автор и
// только по нерешённому — кнопка в мини-аппе лишь не показывается зря.
export async function requestFeedback(
  submissionId: string,
  telegramUserId: bigint
): Promise<FeedbackResult> {
  const submission = await prisma.issueSubmission.findUnique({
    where: { id: submissionId },
    select: {
      issueId: true,
      authorName: true,
      telegramUserId: true,
      createdAt: true,
      issue: { select: { status: true } },
    },
  });
  // Чужое и несуществующее — один ответ: по нему нельзя узнать, есть ли чужая.
  if (!submission || submission.telegramUserId !== telegramUserId) {
    return { ok: false, status: 404, error: "Өтініш табылмады" };
  }
  const last = (await lastFeedbackAt([submission.issueId])).get(submission.issueId) ?? null;
  const availability = feedbackAvailability({
    status: submission.issue.status,
    submittedAt: submission.createdAt,
    lastAskedAt: last,
  });
  if (!availability.canAsk) {
    return {
      ok: false,
      status: 429,
      error: availability.nextAt
        ? `Қайта сұрау уақыты: ${formatTimeAlmaty(availability.nextAt)}`
        : "Өтініш шешілген",
    };
  }

  const post = await prisma.botReply.findFirst({
    where: {
      issueId: submission.issueId,
      deleted: false,
      kind: { in: ["SUBMISSION", "SUBMISSION_TEST"] },
    },
    orderBy: { sentAt: "asc" },
    select: { chatId: true, messageId: true },
  });
  const dutyId = await pickRecipient(todayDateString());
  const { html, plain } = buildFeedbackRequest({
    issueId: submission.issueId,
    authorName: submission.authorName,
    telegramUserId: submission.telegramUserId,
    status: submission.issue.status,
    waitedMs: Date.now() - submission.createdAt.getTime(),
    dutyId,
    dutyName: dutyId ? telegramIdToAgent(dutyId) : null,
  });

  const chatId = post?.chatId ?? (dutyId ? String(dutyId) : null);
  if (!chatId) {
    return { ok: false, status: 503, error: "Кезекшіге жеткізу мүмкін болмады — топқа жазыңыз" };
  }
  const sent = await sendTelegramMessage(
    chatId,
    html,
    undefined,
    undefined,
    "HTML",
    post?.messageId
  );
  if (!sent) {
    return { ok: false, status: 502, error: "Жіберілмеді — сәлден соң қайталаңыз" };
  }

  // Запоминаем как сообщение бота по тикету: отсюда считается «не чаще раза
  // в час», и ответ дежурного реплаем на этот вопрос приклеится к тикету
  // (agentThread/resolutionNote ищут BotReply по message_id).
  await prisma.botReply.create({
    data: {
      issueId: submission.issueId,
      chatId,
      messageId: sent.message_id,
      kind: FEEDBACK_KIND,
      text: plain,
    },
  });
  return { ok: true, via: post ? "group" : "dm" };
}
