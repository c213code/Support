import { prisma } from "@/lib/prisma";
import { changeIssueStatus } from "@/lib/issueStatus";
import { agentTelegramId } from "@/lib/agentTelegram";
import { SUBMISSION_PICK_PREFIX } from "@/lib/telegramCallbacks";
import {
  answerCallbackQuery,
  editMessageText,
  extractAuthorName,
  largestPhotoFileId,
  sendTelegramMessage,
  type TelegramCallbackQuery,
  type TelegramMessagePayload,
} from "@/lib/telegram";

// Переписка дежурного с куратором, подавшим обращение формой мини-аппа.
//
// Зачем вообще: у заявки из формы нет сообщения в группе, где можно было бы
// переспросить. Дежурный видел «ДТ шықпайды» и скриншот — и не мог уточнить
// ни почту ученика, ни что именно нажимали. Единственной связью было
// одностороннее уведомление о статусе (submitterNotify.ts).
//
// Где живёт: в личке куратора с ботом, а не отдельным чатом в мини-аппе.
// Кураторы и так весь день в Telegram; ещё один экран, куда надо заходить за
// ответом, означал бы, что ответа не будет. Со стороны куратора это разговор
// с ботом — имя дежурного ему не показывается, оно нужно только на сайте,
// чтобы было видно, кто из своих писал.
//
// Как бот понимает, о какой заявке речь, когда у куратора их несколько:
// 1) ответ (Reply) на сообщение бота — точная привязка, telegramMessageId;
// 2) без Reply — если ровно у одной заявки висит неотвеченный вопрос
//    дежурного, ответ идёт туда (по-человечески: спросили одно, ответили);
// 3) иначе бот спрашивает кнопками и держит текст в PendingCuratorMessage.
// Гадать нельзя: ответ, приклеенный не к той заявке, хуже лишнего вопроса.

// Сколько заявок показывать кнопками и за какой срок. Тот же месяц, что и в
// списке «Менің өтініштерім» (api/miniapp/mine): о чём куратор писал раньше,
// он и сам уже не помнит.
const PICK_WINDOW_DAYS = 30;
const PICK_LIMIT = 3;

// Сколько времени вопрос дежурного считается «ждущим ответа» (правило 2).
// Сутки: ответ через день после вопроса — всё ещё ответ на него, а вот через
// неделю это уже, скорее, новая история.
const OPEN_QUESTION_HOURS = 24;

// Казахские сокращения месяцев — те же, что в списке обращений мини-аппа
// (MySubmissions.tsx). Свои, а не Intl: у Chrome нет казахских названий
// месяцев, kk-KZ отдаёт «M09».
const MONTHS_KK = [
  "қаң",
  "ақп",
  "нау",
  "сәу",
  "мам",
  "мау",
  "шіл",
  "там",
  "қыр",
  "қаз",
  "қар",
  "жел",
];

// Длина цитаты обращения в шапке сообщения и на кнопках. Шапка нужна, чтобы
// куратор с тремя открытыми заявками понял, о которой его спрашивают, —
// но не занимала собой весь экран телефона.
const EXCERPT_LENGTH = 60;
const BUTTON_EXCERPT_LENGTH = 30;

export type ChatMessageDTO = {
  id: string;
  fromAgent: boolean;
  // Имя дежурного (для сайта) либо имя куратора из Telegram.
  authorName: string;
  text: string;
  photoCount: number;
  createdAt: string;
  // false — Telegram не принял сообщение (куратор заблокировал бота и т.п.).
  // Такое видно на сайте: иначе дежурный ждал бы ответа на письмо, которое
  // не ушло.
  delivered: boolean;
};

export type ChatThreadDTO = {
  submissionId: string;
  curatorName: string;
  // Начало текста заявки — по нему дежурный понимает, с кем из нескольких
  // авторов склеенного тикета он говорит.
  excerpt: string;
  submittedAt: string;
  messages: ChatMessageDTO[];
};

function excerptOf(text: string, limit = EXCERPT_LENGTH): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function formatDayKk(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Almaty",
    day: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = Number(parts.find((p) => p.type === "month")?.value ?? "1");
  return `${day} ${MONTHS_KK[month - 1] ?? ""}`.trim();
}

function toDTO(row: {
  id: string;
  fromAgent: boolean;
  authorName: string;
  text: string;
  photoFileIds: string[];
  telegramMessageId: number | null;
  createdAt: Date;
}): ChatMessageDTO {
  return {
    id: row.id,
    fromAgent: row.fromAgent,
    authorName: row.authorName,
    text: row.text,
    photoCount: row.photoFileIds.length,
    createdAt: row.createdAt.toISOString(),
    // У сообщений куратора telegramMessageId не заполняется — доставлять их
    // нам не нужно, они уже пришли.
    delivered: !row.fromAgent || row.telegramMessageId != null,
  };
}

// Вся переписка по тикету. Тредов несколько, когда тикет склеен из заявок
// разных кураторов (mergeIssue.ts): у каждого свой разговор, мешать их в
// одну ленту нельзя — дежурный отвечал бы одному, а читал другого.
export async function loadIssueThreads(issueId: string): Promise<ChatThreadDTO[]> {
  const submissions = await prisma.issueSubmission.findMany({
    where: { issueId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      authorName: true,
      rawText: true,
      createdAt: true,
      messages: { orderBy: { createdAt: "asc" } },
    },
  });

  return submissions.map((submission) => ({
    submissionId: submission.id,
    curatorName: submission.authorName,
    excerpt: excerptOf(submission.rawText),
    submittedAt: submission.createdAt.toISOString(),
    messages: submission.messages.map(toDTO),
  }));
}

// Дежурный открыл переписку — ответы куратора больше не «новые» (по readAt
// считается метка на карточке доски).
export async function markThreadRead(issueId: string): Promise<void> {
  await prisma.submissionMessage.updateMany({
    where: { submission: { issueId }, fromAgent: false, readAt: null },
    data: { readAt: new Date() },
  });
}

// Сколько ответов куратора дежурный ещё не видел — для метки на карточке.
export async function unreadReplyCounts(
  issueIds: string[]
): Promise<Map<string, number>> {
  if (issueIds.length === 0) return new Map();

  const rows = await prisma.submissionMessage.findMany({
    where: {
      fromAgent: false,
      readAt: null,
      submission: { issueId: { in: issueIds } },
    },
    select: { submission: { select: { issueId: true } } },
  });

  const counts = new Map<string, number>();
  for (const row of rows) {
    const issueId = row.submission.issueId;
    counts.set(issueId, (counts.get(issueId) ?? 0) + 1);
  }
  return counts;
}

// Сообщение дежурного куратору. Уходит от имени бота: куратор не знает, что
// с той стороны сидит конкретный человек, и не ждёт его лично — отвечает
// тому же боту, которому отправлял заявку.
export async function sendToCurator(params: {
  submissionId: string;
  text: string;
  authorName: string;
}): Promise<{ ok: true; message: ChatMessageDTO } | { ok: false; error: string }> {
  const text = params.text.trim();
  if (!text) return { ok: false, error: "Пустое сообщение" };

  const submission = await prisma.issueSubmission.findUnique({
    where: { id: params.submissionId },
    select: {
      id: true,
      telegramUserId: true,
      rawText: true,
      createdAt: true,
      messages: { where: { fromAgent: true }, select: { id: true }, take: 1 },
    },
  });
  if (!submission) return { ok: false, error: "Обращение не найдено" };

  const header = `📌 «${excerptOf(submission.rawText)}» · ${formatDayKk(submission.createdAt)}`;
  // Подсказку про Reply пишем только в первом сообщении треда: дальше куратор
  // уже знает, как отвечать, а повторять одно и то же в каждом письме —
  // ровно то попугайничанье, которого бот избегает в группах.
  const footer =
    submission.messages.length === 0
      ? "\n\n↩️ Жауап беру үшін осы хабарламаға Reply жасаңыз."
      : "";

  const sent = await sendTelegramMessage(
    Number(submission.telegramUserId),
    `${header}\n\n${text}${footer}`
  );

  // Пишем сообщение в базу и когда Telegram его не принял: дежурный должен
  // видеть, что он спрашивал, и что ответа не будет, пока куратор не
  // разблокирует бота. Причину (403 и т.п.) уже написал в лог callBotApi.
  if (!sent) {
    console.warn(`[chat] куратору по обращению ${submission.id} сообщение не ушло`);
  }

  const row = await prisma.submissionMessage.create({
    data: {
      submissionId: submission.id,
      fromAgent: true,
      authorName: params.authorName,
      text,
      telegramMessageId: sent?.message_id ?? null,
    },
  });

  return sent
    ? { ok: true, message: toDTO(row) }
    : { ok: false, error: "Telegram не принял сообщение — возможно, куратор заблокировал бота" };
}

// Входящее сообщение куратора в личке. true — разобрались сами, вебхуку
// дальше это сообщение обрабатывать не нужно.
export async function intakeCuratorMessage(
  message: TelegramMessagePayload,
  chatId: string,
  text: string
): Promise<boolean> {
  const fromId = message.from?.id;
  if (fromId == null) return false;

  const telegramUserId = BigInt(fromId);
  const photoFileId = largestPhotoFileId(message);
  const photoFileIds = photoFileId ? [photoFileId] : [];
  const curatorName = extractAuthorName(message.from) ?? "Куратор";

  // 1. Ответ на конкретное сообщение бота — самая точная привязка.
  const repliedId = message.reply_to_message?.message_id;
  if (repliedId != null) {
    const answered = await prisma.submissionMessage.findFirst({
      where: {
        telegramMessageId: repliedId,
        fromAgent: true,
        submission: { telegramUserId },
      },
      select: { submissionId: true },
    });
    if (answered) {
      await attachCuratorMessage(answered.submissionId, curatorName, text, photoFileIds);
      return true;
    }
  }

  // 2. Ровно один висящий вопрос — ответ, очевидно, на него.
  const openQuestion = await singleOpenQuestion(telegramUserId);
  if (openQuestion) {
    await attachCuratorMessage(openQuestion, curatorName, text, photoFileIds);
    return true;
  }

  // 3. Непонятно — спрашиваем кнопками.
  return askWhichSubmission(message, chatId, telegramUserId, text, photoFileIds);
}

// Заявка, по которой дежурный спросил и ответа ещё не получил — если такая
// ровно одна. Несколько (или ни одной) — привязывать наугад нельзя.
async function singleOpenQuestion(telegramUserId: bigint): Promise<string | null> {
  const since = new Date(Date.now() - OPEN_QUESTION_HOURS * 60 * 60 * 1000);

  const recentAgentMessages = await prisma.submissionMessage.findMany({
    where: {
      fromAgent: true,
      createdAt: { gte: since },
      submission: { telegramUserId },
    },
    orderBy: { createdAt: "desc" },
    select: { submissionId: true, createdAt: true },
  });
  if (recentAgentMessages.length === 0) return null;

  // Вопрос считается отвеченным, если после него в этом треде уже есть
  // сообщение куратора.
  const waiting = new Set<string>();
  for (const question of recentAgentMessages) {
    if (waiting.has(question.submissionId)) continue;
    const replied = await prisma.submissionMessage.findFirst({
      where: {
        submissionId: question.submissionId,
        fromAgent: false,
        createdAt: { gt: question.createdAt },
      },
      select: { id: true },
    });
    if (!replied) waiting.add(question.submissionId);
  }

  return waiting.size === 1 ? [...waiting][0] : null;
}

// Кнопки «о какой заявке речь». Текст куратора при этом не теряется — лежит
// в PendingCuratorMessage до нажатия.
async function askWhichSubmission(
  message: TelegramMessagePayload,
  chatId: string,
  telegramUserId: bigint,
  text: string,
  photoFileIds: string[]
): Promise<boolean> {
  const since = new Date(Date.now() - PICK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const submissions = await prisma.issueSubmission.findMany({
    where: { telegramUserId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: PICK_LIMIT,
    select: { id: true, rawText: true, createdAt: true },
  });
  // Заявок нет вовсе — это просто человек написал боту. Пусть идёт обычным
  // путём вебхука (ляжет во «Входящие»), а не проваливается в переписку.
  if (submissions.length === 0) return false;

  const keyboard = [
    ...submissions.map((submission) => [
      {
        text: `📌 «${excerptOf(submission.rawText, BUTTON_EXCERPT_LENGTH)}» · ${formatDayKk(submission.createdAt)}`,
        callback_data: `${SUBMISSION_PICK_PREFIX}${submission.id}`,
      },
    ]),
    [{ text: "➕ Жаңа өтініш", callback_data: `${SUBMISSION_PICK_PREFIX}x` }],
  ];

  const prompt = await sendTelegramMessage(
    message.chat.id,
    "Қай өтініш бойынша жазып отырсыз?",
    keyboard
  );
  if (!prompt) return false;

  await prisma.pendingCuratorMessage.create({
    data: {
      telegramUserId,
      chatId,
      promptMessageId: prompt.message_id,
      text,
      photoFileIds,
    },
  });
  return true;
}

// Нажатие на кнопку выбора заявки: достаём отложенный текст и кладём его в
// нужный тред.
export async function handleCuratorChoiceCallback(
  query: TelegramCallbackQuery
): Promise<void> {
  if (!query.message) return;
  const choice = (query.data ?? "").slice(SUBMISSION_PICK_PREFIX.length);

  const pending = await prisma.pendingCuratorMessage.findUnique({
    where: {
      chatId_promptMessageId: {
        chatId: String(query.message.chat.id),
        promptMessageId: query.message.message_id,
      },
    },
  });
  if (!pending) {
    await answerCallbackQuery(query.id, "Бұл сұрақ ескірген", true);
    return;
  }
  await prisma.pendingCuratorMessage.delete({ where: { id: pending.id } });

  if (choice === "x") {
    await answerCallbackQuery(query.id, "Жаңа өтініш");
    // Заводить тикет из личной переписки бот не умеет и не должен: у заявки
    // есть обязательные поля (ученик, сілтеме, скриншот), которые собирает
    // форма. Поэтому отправляем туда же, откуда пришла первая заявка.
    await editMessageText(
      query.message.chat.id,
      query.message.message_id,
      "➕ Жаңа өтініш үшін төмендегі мәзір батырмасынан форманы ашыңыз."
    );
    return;
  }

  const submission = await prisma.issueSubmission.findFirst({
    where: { id: choice, telegramUserId: pending.telegramUserId },
    select: { id: true, rawText: true },
  });
  if (!submission) {
    await answerCallbackQuery(query.id, "Өтініш табылмады", true);
    return;
  }

  const curatorName = extractAuthorName(query.from) ?? "Куратор";
  await attachCuratorMessage(submission.id, curatorName, pending.text, pending.photoFileIds);

  await answerCallbackQuery(query.id, "Қабылданды");
  await editMessageText(
    query.message.chat.id,
    query.message.message_id,
    `✅ «${excerptOf(submission.rawText, BUTTON_EXCERPT_LENGTH)}» өтінішіне жазылды.`
  );
}

// Общая часть всех трёх путей: записать ответ куратора, вернуть тикет в
// работу и позвать дежурного.
async function attachCuratorMessage(
  submissionId: string,
  curatorName: string,
  text: string,
  photoFileIds: string[]
): Promise<void> {
  await prisma.submissionMessage.create({
    data: {
      submissionId,
      fromAgent: false,
      authorName: curatorName,
      text,
      photoFileIds,
    },
  });

  const submission = await prisma.issueSubmission.findUnique({
    where: { id: submissionId },
    select: {
      issueId: true,
      rawText: true,
      issue: { select: { status: true } },
    },
  });
  if (!submission) return;

  // Куратор написал по решённому тикету — значит, решённым он его не считает.
  // Возвращаем в «Отправлено»: тикет снова попадает на доску, иначе ответ
  // лежал бы в закрытой карточке, которую никто не открывает.
  // source "chat" — в группе про это не знают, но и писать туда нечего:
  // у заявки из формы своего сообщения в группе нет.
  if (submission.issue.status === "RESOLVED") {
    await changeIssueStatus({
      issueId: submission.issueId,
      status: "SENT",
      actor: null,
      source: "chat",
    });
  }

  await notifyAgent(submissionId, submission.issueId, curatorName, text);
}

// Ответ куратора — дежурному в личку, а не только меткой на доске: спросил
// он полчаса назад и ждёт ответа сейчас, а доску открывают не каждый час.
// Пишем тому, кто в этом треде спрашивал последним.
async function notifyAgent(
  submissionId: string,
  issueId: string,
  curatorName: string,
  text: string
): Promise<void> {
  const lastQuestion = await prisma.submissionMessage.findFirst({
    where: { submissionId, fromAgent: true },
    orderBy: { createdAt: "desc" },
    select: { authorName: true },
  });
  if (!lastQuestion) return;

  // Общий аккаунт «Дежурный» личного Telegram не имеет — там некому писать,
  // такой ответ дежурный увидит меткой на доске.
  const chatId = agentTelegramId(lastQuestion.authorName);
  if (chatId == null) return;

  await sendTelegramMessage(
    chatId,
    `💬 ${curatorName} ответил по тикету ${issueId}:\n\n${excerptOf(text, 400)}`
  );
}
