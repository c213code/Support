import { prisma } from "@/lib/prisma";
import { dayRangeUtc } from "@/lib/date";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { agentTelegramEntries } from "@/lib/agentTelegram";
import {
  sendTelegramMessage,
  editMessageText,
  escapeHtml,
  type InlineKeyboard,
} from "@/lib/telegram";
import { generateReportText } from "@/lib/report";
import {
  ISSUE_STATUS_PREFIX,
  ISSUE_ESCALATE_PREFIX,
  ISSUE_NOTE_PREFIX,
  ISSUE_RESOLVE_PREFIX,
  ISSUE_PENDING_PREFIX,
  SKIP_TICKET_PREFIX,
  REPORT_SEND_PREFIX,
} from "@/lib/telegramCallbacks";

const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "PENDING", "ESCALATED"]);
// Лимит длины сообщения в Telegram — 4096 символов.
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRUNCATION_NOTE = "…\n\n(обрезано, полный текст — на сайте)";

export type DailyReviewResult =
  | { sent: true; recipientId: number }
  | { sent: false; reason: "no tickets" | "no recipient" };

// Общая логика для двух cron-эндпоинтов: вечерней сводки за сегодня
// (`/api/cron/evening-report`, ~22:00) и утреннего напоминания по
// вчерашнему репорту, если его вечером так и не отправили
// (`/api/cron/morning-report-check`, ~09:00). Обе дёргают одно и то же —
// разница только в том, для какой даты и при каком условии (см. каждый
// роут).
//
// Показывает не просто цифры, а сам текст будущего репорта
// (`generateReportText` — то же, что строится на сайте) — иначе "ревью"
// по кнопке было бы вслепую: агент видел бы только количество тикетов, а
// не то, что реально уйдёт в чат с боссами.
export async function sendDailyReviewMessage(
  reportDate: string
): Promise<DailyReviewResult> {
  const [issues, presets] = await Promise.all([
    prisma.issue.findMany({
      where: { reportDate },
      orderBy: { position: "asc" },
    }),
    prisma.groupPreset.findMany(),
  ]);

  if (issues.length === 0) {
    return { sent: false, reason: "no tickets" };
  }

  const recipientId = await pickRecipient(reportDate);
  if (!recipientId) {
    return { sent: false, reason: "no recipient" };
  }

  const sentCount = issues.filter((i) => i.status === "SENT").length;
  const activeCount = issues.filter((i) => ACTIVE_STATUSES.has(i.status)).length;
  const resolvedCount = issues.filter((i) => i.status === "RESOLVED").length;

  const reportText = generateReportText(issues, presets);
  const body =
    reportText ||
    "Пока нечего показать — все тикеты ещё «Отправлено», статус по ним не выставлен.";
  const header = [
    `🌙 Репорт — ${reportDate}`,
    `📨 Отправлено: ${sentCount} · 🔄 В работе/Пендинг/Передано: ${activeCount} · ✅ Решено: ${resolvedCount}`,
    "",
    "Вот что уйдёт в группу:",
    "",
  ].join("\n");

  let preview = header + body;
  if (preview.length > TELEGRAM_MESSAGE_LIMIT) {
    preview =
      preview.slice(0, TELEGRAM_MESSAGE_LIMIT - TRUNCATION_NOTE.length) +
      TRUNCATION_NOTE;
  }

  const summaryKeyboard: InlineKeyboard = [
    [{ text: "📤 Отправить в группу", callback_data: `${REPORT_SEND_PREFIX}${reportDate}` }],
  ];
  await sendTelegramMessage(recipientId, preview, summaryKeyboard);

  await startReviewSession(recipientId, reportDate);

  return { sent: true, recipientId };
}

type TicketCard = { text: string; keyboard: InlineKeyboard };

// Карточка одного тикета — текст + до 4 кнопок действий (пропускаются,
// если уже неактуальны для текущего статуса) плюс "⏭ Пропустить". Номер
// в заголовке — позиция в очереди этого прохода, не id и не место на
// доске.
function buildTicketCard(
  issue: { id: string; groupName: string; description: string; status: IssueStatus; telegramLink: string | null },
  position: number,
  total: number
): TicketCard {
  const meta = STATUS_META[issue.status];
  const link = issue.telegramLink
    ? `\n<a href="${escapeHtml(issue.telegramLink)}">🔗 Открыть в Telegram</a>`
    : "";
  const text = `Тикет ${position}/${total}\n\n${meta.emoji} ${escapeHtml(issue.groupName)}\n${escapeHtml(issue.description)}${link}`;

  const actionRow: InlineKeyboard[number] = [];
  if (issue.status !== "IN_PROGRESS") {
    actionRow.push({
      text: "🔄 В работе",
      callback_data: `${ISSUE_STATUS_PREFIX}${issue.id}:IN_PROGRESS`,
    });
  }
  if (issue.status !== "PENDING") {
    // Как и "✅ Решено" — не меняет статус сразу, сначала спрашивает "что
    // сейчас с этим тикетом" тем же реплай-механизмом, что и заметка (см.
    // ISSUE_PENDING_PREFIX в вебхуке).
    actionRow.push({
      text: "⏳ Пендинг",
      callback_data: `${ISSUE_PENDING_PREFIX}${issue.id}`,
    });
  }
  if (issue.status !== "ESCALATED") {
    actionRow.push({
      text: "⚠️ Передать",
      callback_data: `${ISSUE_ESCALATE_PREFIX}${issue.id}`,
    });
  }
  const secondRow: InlineKeyboard[number] = [
    { text: "📝 Заметка", callback_data: `${ISSUE_NOTE_PREFIX}${issue.id}` },
    // "✅ Решено" тоже сначала спрашивает "как решили" — по аналогии с
    // ResolveDialog на сайте: заметка о решении и есть то, что попадёт в
    // репорт, применять статус без неё означало бы пустую строку "Статус:"
    // в тексте, который уйдёт боссам.
    { text: "✅ Решено", callback_data: `${ISSUE_RESOLVE_PREFIX}${issue.id}` },
  ];
  const skipRow: InlineKeyboard[number] = [
    { text: "⏭ Пропустить", callback_data: `${SKIP_TICKET_PREFIX}${issue.id}` },
  ];

  const keyboard = actionRow.length > 0 ? [actionRow, secondRow, skipRow] : [secondRow, skipRow];
  return { text, keyboard };
}

// Открывает разбор дня: очередь id нерешённых тикетов фиксируется сразу
// (не пересчитывается по ходу, кроме пропуска уже решённых где-то ещё —
// см. advanceReviewSession), первая карточка уходит отдельным сообщением,
// его id и запоминаем в ReviewSession, чтобы дальше редактировать на
// месте, а не слать новое на каждый шаг.
async function startReviewSession(
  recipientId: number,
  reportDate: string
): Promise<void> {
  const unresolved = await prisma.issue.findMany({
    where: { reportDate, status: { not: "RESOLVED" } },
    orderBy: { position: "asc" },
    select: { id: true, groupName: true, description: true, status: true, telegramLink: true },
  });
  if (unresolved.length === 0) return;

  const chatId = String(recipientId);
  const card = buildTicketCard(unresolved[0], 1, unresolved.length);
  const sent = await sendTelegramMessage(recipientId, card.text, card.keyboard, undefined, "HTML");
  if (!sent) return;

  await prisma.reviewSession.upsert({
    where: { chatId },
    update: {
      reportDate,
      messageId: sent.message_id,
      ticketIds: unresolved.map((i) => i.id),
      currentIndex: 0,
    },
    create: {
      chatId,
      reportDate,
      messageId: sent.message_id,
      ticketIds: unresolved.map((i) => i.id),
    },
  });
}

// Двигает активную сессию разбора к следующему тикету — после того, как
// по текущему что-то сделали (статус/эскалация/заметка) или явно
// пропустили. Молча выходит, если для этого чата сессии нет (действие
// пришло не из карточки разбора — такого сейчас не бывает, но на будущее
// безопаснее, чем падать). Если следующий тикет по дороге кем-то уже
// решён (например, на сайте) — пропускает его тоже, а не показывает
// неактуальную карточку.
export async function advanceReviewSession(chatId: string): Promise<void> {
  const session = await prisma.reviewSession.findUnique({ where: { chatId } });
  if (!session) return;

  let idx = session.currentIndex + 1;
  let issue: {
    id: string;
    groupName: string;
    description: string;
    status: IssueStatus;
    telegramLink: string | null;
  } | null = null;

  while (idx < session.ticketIds.length) {
    const candidate = await prisma.issue.findUnique({
      where: { id: session.ticketIds[idx] },
      select: { id: true, groupName: true, description: true, status: true, telegramLink: true },
    });
    if (candidate && candidate.status !== "RESOLVED") {
      issue = candidate;
      break;
    }
    idx++;
  }

  if (!issue) {
    await editMessageText(chatId, session.messageId, "✅ Все тикеты дня разобраны!", null);
    await prisma.reviewSession.delete({ where: { chatId } });
    return;
  }

  const card = buildTicketCard(issue, idx + 1, session.ticketIds.length);
  await editMessageText(chatId, session.messageId, card.text, card.keyboard, "HTML");
  await prisma.reviewSession.update({ where: { chatId }, data: { currentIndex: idx } });
}

// "Кто дежурил в этот день" в системе нигде явно не записано, поэтому
// судим по факту — кто больше всех писал агентских сообщений в
// привязанные чаты в тот день (см. isOwnAgentMessage в вебхуке — только
// после того, как свои сообщения агентов начали сохраняться, это стало
// возможно посчитать).
async function pickRecipient(reportDate: string): Promise<number | null> {
  const entries = agentTelegramEntries();
  if (entries.length === 0) return null;

  const { start, end } = dayRangeUtc(reportDate);
  const ids = entries.map(([, id]) => BigInt(id));

  const counts = await prisma.telegramMessage.groupBy({
    by: ["fromId"],
    where: { fromId: { in: ids }, receivedAt: { gte: start, lt: end } },
    _count: { _all: true },
  });

  if (counts.length === 0) {
    // Тихий день без агентской переписки в привязанных чатах — шлём
    // первому из списка, чтобы сводка не потерялась молча.
    return entries[0][1];
  }

  const top = counts.reduce((best, row) =>
    row._count._all > best._count._all ? row : best
  );
  return top.fromId != null ? Number(top.fromId) : entries[0][1];
}
