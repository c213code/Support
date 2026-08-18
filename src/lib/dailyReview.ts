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
import { bestSolution } from "@/lib/solutionLibrary";
import { extractTicketHints } from "@/lib/ticketHints";
import {
  ISSUE_STATUS_PREFIX,
  ISSUE_ESCALATE_PREFIX,
  ISSUE_NOTE_PREFIX,
  ISSUE_RESOLVE_PREFIX,
  ISSUE_PENDING_PREFIX,
  SKIP_TICKET_PREFIX,
  BACK_TICKET_PREFIX,
  REPORT_SEND_PREFIX,
  START_REVIEW_PREFIX,
  START_DEDUPE_PREFIX,
  SOLVE_LIKE_PREFIX,
  BOT_REPLIES_PREFIX,
} from "@/lib/telegramCallbacks";

const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "PENDING", "ESCALATED"]);
// Разбор по одному — только то, что реально ждёт первого действия
// сегодня. ESCALATED уже передан другой команде (следить за этим — не
// ежедневная задача дежурного, а RESOLVED и так не в очереди.
const REVIEWABLE_STATUSES = new Set<IssueStatus>(["SENT", "PENDING", "IN_PROGRESS"]);
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
// Собирает текст + клавиатуру сводки за день — общее между вечерней
// рассылкой (sendDailyReviewMessage ниже, получатель вычисляется по
// pickRecipient) и командой /report (отправляется прямо тому, кто спросил,
// в любое время дня, не только по расписанию cron). Возвращает null, если
// за дату вообще нет тикетов — тогда слать нечего.
//
// Показывает не просто цифры, а сам текст будущего репорта
// (`generateReportText` — то же, что строится на сайте) — иначе "ревью"
// было бы вслепую: агент видел бы только количество тикетов, а не то, что
// реально уйдёт в чат с боссами.
export async function buildReviewSummary(
  reportDate: string
): Promise<{ text: string; keyboard: InlineKeyboard } | null> {
  const [issues, presets] = await Promise.all([
    prisma.issue.findMany({
      where: { reportDate },
      orderBy: { position: "asc" },
    }),
    prisma.groupPreset.findMany(),
  ]);

  if (issues.length === 0) {
    return null;
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

  const keyboard: InlineKeyboard = [
    [{ text: "📤 Отправить в группу", callback_data: `${REPORT_SEND_PREFIX}${reportDate}` }],
  ];
  const reviewableCount = issues.filter((i) => REVIEWABLE_STATUSES.has(i.status)).length;
  if (reviewableCount > 0) {
    // Разбор запускается по кнопке, не сам — сначала видно сводку целиком
    // (сколько чего и в каком статусе), и уже дежурный решает, начинать
    // ли прямо сейчас идти по тикетам одному за другим.
    keyboard.push([
      {
        text: `🔍 Начать разбор тикетов (${reviewableCount})`,
        callback_data: `${START_REVIEW_PREFIX}${reportDate}`,
      },
    ]);
  }
  // Похожие/дублирующиеся тикеты имеет смысл предлагать искать, только
  // если ИИ вообще настроен (иначе кнопка вела бы в тупик) и тикетов
  // хватает хотя бы на пару.
  if (process.env.GROQ_API_KEY && issues.length >= 2) {
    keyboard.push([
      {
        text: "🔗 Найти похожие тикеты",
        callback_data: `${START_DEDUPE_PREFIX}${reportDate}`,
      },
    ]);
  }

  return { text: preview, keyboard };
}

export async function sendDailyReviewMessage(
  reportDate: string
): Promise<DailyReviewResult> {
  const summary = await buildReviewSummary(reportDate);
  if (!summary) {
    return { sent: false, reason: "no tickets" };
  }

  const recipientId = await pickRecipient(reportDate);
  if (!recipientId) {
    return { sent: false, reason: "no recipient" };
  }

  await sendTelegramMessage(recipientId, summary.text, summary.keyboard);

  return { sent: true, recipientId };
}

type TicketCard = { text: string; keyboard: InlineKeyboard };

// Поля тикета, которых хватает для карточки разбора — держим одним типом,
// чтобы select'ы в трёх местах не разъезжались с тем, что читает
// buildTicketCard.
type ReviewCardIssue = {
  id: string;
  groupName: string;
  description: string;
  status: IssueStatus;
  telegramLink: string | null;
};

// Карточка одного тикета — текст + до 4 кнопок действий (пропускаются,
// если уже неактуальны для текущего статуса) плюс "⏭ Пропустить". Номер
// в заголовке — позиция в очереди этого прохода, не id и не место на
// доске.
function buildTicketCard(
  issue: {
    id: string;
    groupName: string;
    description: string;
    status: IssueStatus;
    telegramLink: string | null;
    botReplies?: string[];
    // Почта/телефон/вложение из исходного сообщения — без них по тикету
    // вроде "Логин пароль жұмыс істемейді" в админке искать нечего.
    hints?: { emails: string[]; phones: string[]; hasAttachment: boolean };
    // Заметка похожего уже решённого тикета — если такая нашлась, на
    // карточке появляется кнопка "решить так же" (см. solutionLibrary.ts).
    suggestedNote?: string | null;
  },
  position: number,
  total: number
): TicketCard {
  const meta = STATUS_META[issue.status];
  const link = issue.telegramLink
    ? `\n<a href="${escapeHtml(issue.telegramLink)}">🔗 Открыть в Telegram</a>`
    : "";
  // Что бот уже сказал в группе по этому тикету — чтобы вечером не
  // написать второй раз то же самое (это и была бы двойная работа, только
  // теперь уже в чате у коллег).
  const said =
    issue.botReplies && issue.botReplies.length > 0
      ? `\n\n<i>🤖 бот уже ответил: ${escapeHtml(issue.botReplies.join(" · "))}</i>`
      : "";
  // Зацепки для поиска ученика: чистка описания их выкидывает (в репорт
  // они не нужны), но именно с них начинается работа по тикету.
  const hintParts: string[] = [];
  if (issue.hints?.emails.length) hintParts.push(`✉️ <code>${escapeHtml(issue.hints.emails.join(", "))}</code>`);
  if (issue.hints?.phones.length) hintParts.push(`📞 <code>${escapeHtml(issue.hints.phones.join(", "))}</code>`);
  if (issue.hints?.hasAttachment) hintParts.push("📎 есть вложение — суть может быть в нём");
  const hints = hintParts.length > 0 ? `\n\n${hintParts.join("\n")}` : "";
  const text = `Тикет ${position}/${total}\n\n${meta.emoji} ${escapeHtml(issue.groupName)}\n${escapeHtml(issue.description)}${hints}${link}${said}`;

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
  // Отдельной строкой и выше "Пропустить": если подсказка подошла, это
  // самое быстрое действие на карточке — одно нажатие вместо набора
  // заметки руками.
  const solutionRow: InlineKeyboard[number] = [];
  if (issue.suggestedNote) {
    const short =
      issue.suggestedNote.length > 40
        ? `${issue.suggestedNote.slice(0, 40)}…`
        : issue.suggestedNote;
    solutionRow.push({
      text: `💡 Решить так же: ${short}`,
      callback_data: `${SOLVE_LIKE_PREFIX}${issue.id}`,
    });
  }

  const skipRow: InlineKeyboard[number] = [];
  // Кнопка появляется, только если боту есть что убирать — иначе она
  // просто занимала бы место на каждой карточке.
  if (issue.botReplies && issue.botReplies.length > 0) {
    skipRow.push({
      text: "🤖 Ответы бота",
      callback_data: `${BOT_REPLIES_PREFIX}${issue.id}`,
    });
  }
  // "Назад" бессмысленна на первом тикете очереди — некуда возвращаться.
  if (position > 1) {
    skipRow.push({
      text: "⬅️ Назад",
      callback_data: `${BACK_TICKET_PREFIX}${issue.id}`,
    });
  }
  skipRow.push({
    text: "⏭ Пропустить",
    callback_data: `${SKIP_TICKET_PREFIX}${issue.id}`,
  });

  const keyboard = [
    ...(actionRow.length > 0 ? [actionRow] : []),
    secondRow,
    ...(solutionRow.length > 0 ? [solutionRow] : []),
    skipRow,
  ];
  return { text, keyboard };
}

// Открывает разбор дня по кнопке "🔍 Начать разбор тикетов" — очередь id
// фиксируется сразу (не пересчитывается по ходу, кроме пропуска тикетов,
// выпавших из области разбора — см. advanceReviewSession), первая карточка
// уходит отдельным сообщением, его id и запоминаем в ReviewSession, чтобы
// дальше редактировать на месте, а не слать новое на каждый шаг. Область
// разбора — только SENT/PENDING/IN_PROGRESS (см. REVIEWABLE_STATUSES):
// ESCALATED уже не на дежурном, каждый день пересматривать не нужно.
export async function startReviewSession(
  recipientId: number,
  reportDate: string
): Promise<void> {
  const reviewable = await prisma.issue.findMany({
    where: { reportDate, status: { in: Array.from(REVIEWABLE_STATUSES) } },
    orderBy: { position: "asc" },
    select: { id: true, groupName: true, description: true, status: true, telegramLink: true },
  });
  if (reviewable.length === 0) return;

  const chatId = String(recipientId);
  const card = buildTicketCard(
    {
      ...reviewable[0],
      botReplies: await botRepliesFor(reviewable[0].id),
      suggestedNote: (await bestSolution(reviewable[0]))?.note ?? null,
      hints: await hintsFor(reviewable[0]),
    },
    1,
    reviewable.length
  );
  const sent = await sendTelegramMessage(recipientId, card.text, card.keyboard, undefined, "HTML");
  if (!sent) return;

  await prisma.reviewSession.upsert({
    where: { chatId },
    update: {
      reportDate,
      messageId: sent.message_id,
      ticketIds: reviewable.map((i) => i.id),
      currentIndex: 0,
    },
    create: {
      chatId,
      reportDate,
      messageId: sent.message_id,
      ticketIds: reviewable.map((i) => i.id),
    },
  });
}

// Тексты, которые бот уже отправил в рабочую группу по этому тикету —
// показываются на карточке разбора, чтобы не продублировать сказанное.
// Зацепки (почта/телефон/вложение) из сырых сообщений тикета — см.
// ticketHints.ts. Отдельным запросом, потому что на карточке разбора их
// нужно ровно столько же, сколько ответов бота.
async function hintsFor(issue: { telegramLink: string | null }) {
  const links = issue.telegramLink ? [issue.telegramLink] : [];
  if (links.length === 0) return undefined;
  const sources = await prisma.telegramMessage.findMany({
    where: { messageLink: { in: links } },
    select: { text: true },
  });
  return extractTicketHints(sources.map((s) => s.text));
}

async function botRepliesFor(issueId: string): Promise<string[]> {
  const replies = await prisma.botReply.findMany({
    where: { issueId, deleted: false },
    orderBy: { sentAt: "asc" },
    select: { text: true },
  });
  return replies.map((r) => r.text);
}

// Двигает активную сессию разбора к следующему тикету — после того, как
// по текущему что-то сделали (статус/эскалация/заметка) или явно
// пропустили. Молча выходит, если для этого чата сессии нет (действие
// пришло не из карточки разбора — такого сейчас не бывает, но на будущее
// безопаснее, чем падать). Если следующий тикет по дороге кем-то уже
// решён (например, на сайте) — пропускает его тоже, а не показывает
// неактуальную карточку.
export async function advanceReviewSession(chatId: string): Promise<void> {
  await moveReviewSession(chatId, 1);
}

// Возвращает карточку к предыдущему тикету очереди — та же логика, что и
// вперёд, только шаг -1: пропускает тикеты, выпавшие из
// REVIEWABLE_STATUSES по дороге (например, уже решённые где-то ещё), и
// молча ничего не делает, если возвращаться некуда (уже на первом).
export async function goBackReviewSession(chatId: string): Promise<void> {
  await moveReviewSession(chatId, -1);
}

// Общий шаг разбора в обе стороны. Раньше это были две почти одинаковые
// функции, каждая из которых тянула тикеты из очереди по одному в цикле —
// на длинной очереди с уже решёнными тикетами это давало десяток
// последовательных запросов на одно нажатие кнопки. Теперь оставшийся
// кусок очереди забирается разом, а нужный элемент ищется уже в памяти.
async function moveReviewSession(chatId: string, step: 1 | -1): Promise<void> {
  const session = await prisma.reviewSession.findUnique({ where: { chatId } });
  if (!session) return;

  // Кандидаты в направлении движения, в порядке просмотра.
  const order =
    step === 1
      ? session.ticketIds.slice(session.currentIndex + 1)
      : session.ticketIds.slice(0, session.currentIndex).reverse();

  let issue: ReviewCardIssue | null = null;
  let idx = session.currentIndex;

  if (order.length > 0) {
    const found = await prisma.issue.findMany({
      where: { id: { in: order }, status: { in: Array.from(REVIEWABLE_STATUSES) } },
      select: { id: true, groupName: true, description: true, status: true, telegramLink: true },
    });
    const byId = new Map(found.map((i) => [i.id, i]));
    // Первый по порядку просмотра, а не первый из выдачи базы: порядок
    // очереди задан на старте разбора и его надо сохранить.
    const nextId = order.find((id) => byId.has(id));
    if (nextId) {
      issue = byId.get(nextId)!;
      idx = session.ticketIds.indexOf(nextId);
    }
  }

  if (!issue) {
    // Назад идти некуда — просто остаёмся на текущей карточке.
    if (step === -1) return;
    await editMessageText(chatId, session.messageId, "✅ Все тикеты дня разобраны!", null);
    await prisma.reviewSession.delete({ where: { chatId } });
    return;
  }

  const [botReplies, suggestion, hints] = await Promise.all([
    botRepliesFor(issue.id),
    bestSolution(issue),
    hintsFor(issue),
  ]);
  const card = buildTicketCard(
    { ...issue, botReplies, suggestedNote: suggestion?.note ?? null, hints },
    idx + 1,
    session.ticketIds.length
  );
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
