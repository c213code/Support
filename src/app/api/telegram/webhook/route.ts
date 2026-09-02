import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { isNoiseOnly } from "@/lib/textClean";
import { buildDescription } from "@/lib/ticketDescription";
import { STATUS_META } from "@/lib/status";
import { changeIssueStatus } from "@/lib/issueStatus";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { advanceReviewSession } from "@/lib/dailyReview";
import { handleBotCommand } from "@/lib/webhook/commands";
import { handleCallbackQuery, RESOLVED_NOTE_LABEL } from "@/lib/webhook/callbacks";
import { detectAgentIntent } from "@/lib/agentIntent";
import { resolveAgentTarget, type AgentTarget } from "@/lib/agentThread";
import {
  buildReplyVariants,
  requestAutoReplyApproval,
} from "@/lib/autoReplyApproval";
import { findRelatedRecentIssue } from "@/lib/relatedIssue";
import { collectResolutionContext } from "@/lib/resolutionNote";
import {
  classifyAckAsk,
  classifySituation,
  isSameRequestFollowUp,
  summarizeResolutionNote,
} from "@/lib/ai";
import { missingSlotsFor } from "@/lib/situations";
import {
  buildStatusReplyText,
  hasIdentifier,
  pickLanguage,
  type AckAskKind,
} from "@/lib/autoReply";
import {
  sendBotReply,
  hasBotReplied,
  agentAlreadyReplied,
} from "@/lib/botReply";
import {
  isAutoReplyEnabled,
  isAutoReplyConfirmEnabled,
  isChatIntentEnabled,
  isAiAskEnabled,
  isAiCleaningEnabled,
} from "@/lib/settings";
import {
  NOTIFY_RESOLVED_PREFIX,
  AGENT_TARGET_PREFIX,
  CONFIRM_RESOLVED_PREFIX,
  RESOLVE_WITH_DRAFT_PREFIX,
} from "@/lib/telegramCallbacks";
import {
  AUTO_ISSUE_CREATOR,
  buildMessageLink,
  extractAuthorName,
  extractReplyContextLine,
  extractText,
  isOwnAgentMessage,
  ownAgentTelegramIdList,
  sendTelegramMessage,
  type TelegramMessagePayload,
  type TelegramUpdate,
} from "@/lib/telegram";

// Заводит тикет "Отправлено" для уже известной группы, чтобы он сразу был
// виден на доске без ручного "Создать тикет". Возвращает null, если по
// сообщению заводить нечего (см. buildDescription).
async function createAutoIssue(
  groupName: string,
  groupEmoji: string | null,
  own: string,
  contextual: string,
  telegramLink: string,
  skipAutoCreate = false
) {
  const reportDate = todayDateString();
  const [last, cleaned] = await Promise.all([
    prisma.issue.findFirst({
      where: { reportDate, groupName },
      orderBy: { position: "desc" },
    }),
    buildDescription(own, contextual, skipAutoCreate),
  ]);
  if (cleaned === null) return null;
  return prisma.issue.create({
    data: {
      reportDate,
      groupName,
      groupEmoji,
      position: (last?.position ?? 0) + 1,
      description: cleaned,
      telegramLink,
      status: "SENT",
      createdBy: AUTO_ISSUE_CREATOR,
    },
  });
}

// Подтверждение приёма: бот отвечает реплаем сразу, как завёлся тикет —
// "жақсы, қарап береміз", и если в обращении не было ни почты, ни ссылки,
// ни номера, тут же просит их прислать (60% обращений приходят без них, и
// первый ответ агента уходит именно на это).
//
// Два предохранителя от дубля: один ACK на тикет (сообщения одного автора
// склеиваются, а вебхук может доставиться повторно) и молчание, если по
// этому обращению уже успел ответить живой человек.
// regex (hasIdentifier) уже решил "просить почту/ссылку" или "не просить" —
// ИИ, если включён тоглом, может это уточнить (см. classifyAckAsk в
// lib/ai.ts): общий вопрос без привязки к ученику ("во сколько работает
// платформа") не становится решаемым от присланной почты, а обращение про
// конкретное задание по программе ("тапсырма фото не показывает") просит
// не только почту, но и ай-апту — иначе агент знает, у кого проблема, но не
// знает, какое задание смотреть. null/выключенный тогл/сбой модели —
// остаёмся на исходном "просить почту/ссылку".
async function decideAskKind(incomingText: string): Promise<AckAskKind> {
  if (hasIdentifier(incomingText)) return "none";
  if (!(await isAiAskEnabled())) return "contact";

  const aiDecision = await classifyAckAsk(incomingText);
  return aiDecision ?? "contact";
}

// Текст подтверждения приёма. Основной путь — разбор по каталогу ситуаций
// (см. lib/situations.ts): он выбирает обещание под суть просьбы
// ("өзгертілгенде кб береміз" на правку, "ашылғанда кб береміз" на доступ)
// и просит ровно то, чего не хватает, вместо почты по умолчанию.
//
// Откат — прежний троичный ACK. Он срабатывает, когда тогл выключен или
// модель не ответила: без ИИ бот всё равно должен подтвердить приём, просто
// более общими словами.
// Варианты ответа на обращение. Первый — то, что бот отправил бы сам;
// остальные отличаются решением "просить данные или нет" (см.
// buildReplyVariants). Когда подтверждение выключено, берётся только
// первый — поведение ровно прежнее.
async function buildAckVariants(incomingText: string): Promise<string[]> {
  if (await isAiAskEnabled()) {
    const result = await classifySituation(incomingText);
    if (result) {
      return buildReplyVariants({
        incomingText,
        situation: result.situation,
        missing: missingSlotsFor(result.situation, result.missing, incomingText),
        fallbackAskKind: "none",
      });
    }
  }

  return buildReplyVariants({
    incomingText,
    situation: null,
    missing: [],
    fallbackAskKind: await decideAskKind(incomingText),
  });
}

async function sendAcknowledgement(
  issueId: string,
  chatId: string,
  messageId: number,
  incomingText: string,
  groupName: string,
  authorId: bigint | null
): Promise<void> {
  // Главный рубильник проверяем здесь, а не только внутри sendBotReply:
  // режим подтверждения пишет в личку раньше него, и без этой строки
  // выключённые автоответы всё равно слали бы черновики.
  if (!(await isAutoReplyEnabled())) return;
  if (await hasBotReplied(issueId, "ACK")) return;
  if (await agentAlreadyReplied(chatId, messageId, ownAgentTelegramIdList())) return;

  const variants = await buildAckVariants(incomingText);

  // Режим подтверждения: в группу сейчас не пишем вовсе — показываем
  // черновик дежурному в личку, и ответ уходит только по его кнопке.
  if (await isAutoReplyConfirmEnabled()) {
    // Про одну и ту же поломку часто пишут несколько человек подряд. Если
    // похожее обращение уже есть, предлагаем ответить всем разом — но
    // только предлагаем: склейка удаляет тикет, а однотипные по форме
    // заявки разных учеников выглядят похоже, не будучи одним случаем.
    const related = await findRelatedRecentIssue({
      chatId,
      issueId,
      description: incomingText,
      authorId,
    });

    await requestAutoReplyApproval({
      issueId,
      groupName,
      incomingText,
      targetChatId: chatId,
      targetMessageId: messageId,
      variants,
      related,
    });
    return;
  }

  await sendBotReply({
    issueId,
    chatId,
    replyToMessageId: messageId,
    kind: "ACK",
    text: variants[0],
  });
}

// Обратная связь из чата в статус: агент отвечает в группе как привык, а
// система понимает, что произошло, и двигает статус сама — чтобы вечерний
// разбор был проверкой, а не пересказом собственного дня.
//
// Тикет определяем консервативно: либо агент ответил реплаем на конкретное
// обращение, либо в этом чате за сегодня открыт ровно один разбираемый
// тикет. Если кандидатов несколько и реплая нет — молчим: ошибиться
// статусом хуже, чем не проставить его вовсе, потому что статус уходит в
// репорт боссам.

// Черновик заметки "как решили" из того, что агент уже написал в чате.
// Ровно та же связка, что в модалке "Как решили?" на сайте
// (api/issues/[id]/suggest-note): тот же тогл, тот же сбор контекста, то же
// правило дописывать имя кодом, а не моделью.
async function buildResolvedNoteDraft(
  issueId: string,
  agentName: string | null
): Promise<string | null> {
  if (!(await isAiCleaningEnabled())) return null;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { description: true },
  });
  if (!issue) return null;

  const context = await collectResolutionContext(issueId);
  if (!context.ok) return null;

  const summary = await summarizeResolutionNote(
    issue.description,
    context.context.agentTexts
  );
  if (!summary.ok) return null;

  return agentName ? `${agentName} шешті, ${summary.note}` : summary.note;
}

async function applyAgentIntent(
  message: TelegramMessagePayload,
  chatId: string,
  ownText: string,
  target: AgentTarget
): Promise<void> {
  if (!(await isChatIntentEnabled())) return;

  const intent = detectAgentIntent(ownText);
  if (!intent) return;

  // Тикет ищет resolveAgentTarget: стрелка реплая → свой же разговор →
  // ближайшее обращение выше. Раньше здесь было только первое и правило
  // "если в чате за день открыт ровно один тикет" — из-за него реплика без
  // Reply в Сервисе и Сату почти всегда пропадала.
  if (target.kind === "ambiguous") {
    // Кандидатов несколько — не гадаем. Ошибка уедет в репорт боссам,
    // поэтому спрашиваем в личке у того, кто написал: одно нажатие вместо
    // ручного проставления статуса вечером.
    if (message.from?.id == null) return;
    await sendTelegramMessage(
      message.from.id,
      `Ты написал «${ownText.trim().slice(0, 60)}» в группе, но не реплаем — к какому тикету это относится?`,
      target.candidates.map((candidate) => [
        {
          text: `${STATUS_META[intent.status].emoji} ${candidate.description.slice(0, 55)}`,
          callback_data: `${AGENT_TARGET_PREFIX}${intent.status}:${candidate.id}`,
        },
      ])
    );
    return;
  }
  if (target.kind !== "found") return;
  const issueId = target.issueId;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { status: true, telegramLink: true, createdBy: true },
  });
  if (!issue || issue.status === intent.status) return;

  const actorName =
    message.from?.id != null ? telegramIdToAgent(message.from.id) : null;


  // "Решено" молча не ставим: оно уходит в репорт боссам, а само
  // "жөңделді" — плохая заметка. Спрашиваем в личке у того, кто написал,
  // и заодно просим нормальный текст.
  if (intent.needsConfirmation) {
    if (message.from?.id == null) return;

    // Заметка из собственных слов агента в чате. Без неё закрытие стоит
    // двух шагов (нажать "да", потом написать текст реплаем), и тикет
    // застревает в "В работе" не потому, что работа не сделана, а потому
    // что её лень оформлять. По выгрузке слово о готовности звучит в чате
    // лишь в трети разговоров — остальное доделывают молча, и вот эта
    // разница и оседает на доске.
    const draft = await buildResolvedNoteDraft(issueId, actorName);
    const link = issue.telegramLink ?? "";
    await sendTelegramMessage(
      message.from.id,
      draft
        ? `Похоже, этот тикет решён — отметить?\n\n${link}\n\n${RESOLVED_NOTE_LABEL} «${draft}»`.trim()
        : `Похоже, этот тикет решён — отметить?\n\n${link}`.trim(),
      draft
        ? [
            [
              {
                text: "✅ Решено, с этой заметкой",
                callback_data: `${RESOLVE_WITH_DRAFT_PREFIX}${issueId}`,
              },
            ],
            [
              {
                text: "✍️ Написать свою",
                callback_data: `${CONFIRM_RESOLVED_PREFIX}${issueId}`,
              },
            ],
          ]
        : [
            [
              {
                text: "✅ Да, решено",
                callback_data: `${CONFIRM_RESOLVED_PREFIX}${issueId}`,
              },
            ],
          ]
    );
    return;
  }

  // source: "chat" — в группе агент уже всё сказал сам, повторять за ним
  // не нужно; ставим только реакцию на исходном сообщении.
  await changeIssueStatus({
    issueId,
    status: intent.status,
    actor: actorName,
    source: "chat",
  });
}

// ATTACH_LINK_POLICY — чем "привязка сообщения к тикету" отличается от
// "ещё одной ссылки на карточке", и почему автоматика делает только первое.
//
// Список ссылок на карточке (`Issue.extraLinks`, "Ещё обращение №2") задуман
// как список РАЗНЫХ обращений по одной и той же проблеме: Али написал про
// пароль, потом Айжан написала про пароль — дежурному нужен один тикет с
// двумя ссылками, а не два тикета. Это решение всегда принимает человек
// (кнопки "Прикрепить"/"Объединить", см. api/issues/[id]/attach-message и
// lib/mergeIssue.ts) — только он знает, что это два разных ученика с общей
// причиной.
//
// Автоматические пути ниже ловят прямо противоположное: тот же человек по
// тому же случаю досылает уточнения — отвечает на вопрос бота, дописывает
// подробности, реплаит сам себе. Раньше каждое такое сообщение добавляло
// ссылку, и карточка одного обращения обрастала списком "Ещё обращение
// №2..№6", в котором ни одна ссылка не вела к формулировке проблемы.
//
// Поэтому автоматика ставит только `usedForIssueId` (сообщение разобрано и
// принадлежит тикету), но НЕ трогает extraLinks. Ничего при этом не
// теряется: почта/телефон/вложение из уточнений собираются именно по
// `usedForIssueId` (см. hints в api/issues и lib/dailyReview), так что
// присланная почта по-прежнему видна на карточке — просто без лишней
// ссылки рядом с ней.

// Ответ на сообщение самого бота — почти всегда это присланная по его же
// просьбе почта/ссылка ("Тексеру үшін оқушының почтасын жібере аласыз
// ба?"). Такой ответ обязан приклеиться к тому тикету, по которому бот
// спрашивал.
//
// Отдельно от attachFollowUpToTicket по двум причинам: ответы бота лежат в
// BotReply, а не в TelegramMessage (там их искать бесполезно), и проверку
// на мусор тут делать нельзя — голая почта для isNoiseOnly и есть мусор
// (после чистки не остаётся ничего), хотя это ровно то, что мы просили.
// Ответ на наш вопрос — не запрос, и мерить его меркой запроса неверно.
async function attachReplyToBotMessage(
  message: TelegramMessagePayload,
  chatId: string,
  contextualText: string
): Promise<boolean> {
  const repliedId = message.reply_to_message?.message_id;
  if (repliedId == null) return false;

  const botReply = await prisma.botReply.findUnique({
    where: { chatId_messageId: { chatId, messageId: repliedId } },
    select: { issueId: true },
  });
  if (!botReply) return false;

  const issue = await prisma.issue.findUnique({
    where: { id: botReply.issueId },
    select: { id: true, groupName: true, groupEmoji: true },
  });
  if (!issue) return false;

  const messageLink = buildMessageLink(message.chat.id, message.message_id);

  // Ссылку в extraLinks НЕ добавляем: это уточнение по тому же случаю (мы
  // сами попросили почту), а не отдельное обращение — см. комментарий у
  // ATTACH_LINK_POLICY выше. Привязка (usedForIssueId) остаётся: по ней
  // считаются зацепки на карточке, поэтому присланная почта всё равно
  // окажется у агента перед глазами.
  await prisma.telegramMessage.upsert({
    where: { chatId_messageId: { chatId, messageId: message.message_id } },
    update: { usedForIssueId: issue.id, archived: true, viewed: true },
    create: {
      chatId,
      messageId: message.message_id,
      chatTitle: message.chat.title ?? null,
      groupName: issue.groupName,
      groupEmoji: issue.groupEmoji,
      fromId: message.from?.id != null ? BigInt(message.from.id) : null,
      authorName: extractAuthorName(message.from),
      text: contextualText,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      messageLink,
      usedForIssueId: issue.id,
      archived: true,
      viewed: true,
    },
  });

  return true;
}

// Ищет активный (не решённый, за сегодня) тикет, который уже завёлся по
// более раннему сообщению этого же Telegram-автора в этом же чате — узкий,
// дешёвый DB-lookup-кандидат для isSameRequestFollowUp (см. lib/ai.ts),
// сам по себе ничего не решает про смысл сообщений.
async function findSameAuthorActiveIssue(
  chatId: string,
  fromId: bigint | null
): Promise<{ id: string; description: string } | null> {
  if (!fromId) return null;

  const lastUsed = await prisma.telegramMessage.findFirst({
    where: { chatId, fromId, usedForIssueId: { not: null } },
    orderBy: { receivedAt: "desc" },
    select: { usedForIssueId: true },
  });
  if (!lastUsed?.usedForIssueId) return null;

  const issue = await prisma.issue.findUnique({
    where: { id: lastUsed.usedForIssueId },
    select: {
      id: true,
      description: true,
      status: true,
      reportDate: true,
    },
  });
  if (!issue || issue.status === "RESOLVED" || issue.reportDate !== todayDateString()) {
    return null;
  }

  return issue;
}

// Реплай на уже заведённое сообщение — частый паттерн "напоминание":
// человек отвечает на своё же старое сообщение (или снова пишет по уже
// "решённому" тикету), на которое так и не ответили. Обычная
// regex/ИИ-чистка тут не спасает: сама реплика ("Осы бойынша кері
// байланыс бере аласыздарма?") без исходного вопроса ничего не значит.
// Вместо отдельного, оторванного от контекста тикета — приклеиваем
// сообщение к уже существующему по точному Telegram reply_to_message_id, а
// если тот значился решённым — возвращаем в "Отправлено": RESOLVED был
// явно преждевременным, раз человек написал снова. Возвращает true, если
// сообщение обработано (и вызывающему коду делать больше нечего).
async function attachFollowUpToTicket(
  message: TelegramMessagePayload,
  chatId: string,
  ownText: string,
  contextualText: string
): Promise<boolean> {
  const repliedId = message.reply_to_message?.message_id;
  // Мусор проверяем по "своей" реплике: голое "ок"/"рахмет" в ответ — не
  // повод трогать уже заведённый тикет.
  if (repliedId == null || isNoiseOnly(ownText)) return false;

  const repliedMessage = await prisma.telegramMessage.findUnique({
    where: { chatId_messageId: { chatId, messageId: repliedId } },
    select: { usedForIssueId: true },
  });
  if (!repliedMessage?.usedForIssueId) return false;

  const issue = await prisma.issue.findUnique({
    where: { id: repliedMessage.usedForIssueId },
  });
  if (!issue) return false;

  const messageLink = buildMessageLink(message.chat.id, message.message_id);
  const fromId = message.from?.id != null ? BigInt(message.from.id) : null;
  const authorName = extractAuthorName(message.from);
  const wasResolved = issue.status === "RESOLVED";

  // Ссылку в extraLinks НЕ добавляем — это тот же случай, а не отдельное
  // обращение (см. ATTACH_LINK_POLICY выше). Статус, если тикет считался
  // решённым, всё равно меняем: человек написал снова, значит рано закрыли.
  await prisma.$transaction([
    prisma.telegramMessage.upsert({
      where: { chatId_messageId: { chatId, messageId: message.message_id } },
      update: { usedForIssueId: issue.id, archived: true, viewed: true },
      create: {
        chatId,
        messageId: message.message_id,
        chatTitle: message.chat.title ?? null,
        groupName: issue.groupName,
        groupEmoji: issue.groupEmoji,
        fromId,
        authorName,
        text: contextualText,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        messageLink,
        usedForIssueId: issue.id,
        archived: true,
        viewed: true,
      },
    }),
  ]);

  // Тикет считался решённым, а человек написал снова — возвращаем в
  // "Отправлено". Через ту же точку входа, что и остальные смены статуса:
  // раньше этот путь шёл мимо неё, и в истории такой возврат не оставлял
  // следа, хотя это самый показательный случай в отчёте — «закрыли, а
  // проблема осталась».
  if (wasResolved) {
    await changeIssueStatus({
      issueId: issue.id,
      status: "SENT",
      // Не затираем прежнюю заметку (там могло быть, что именно делали) —
      // дописываем поверх, чтобы было видно обе части истории.
      note: issue.note
        ? `${issue.note} → жауап берілмеді, қайта хабарласты`
        : "Жауап берілмеді, қайта хабарласты",
      actor: null,
      // "chat": ответ в группу этот путь отправляет сам, ниже, — и не
      // реплаем на исходное обращение, а на новое сообщение человека.
      source: "chat",
    });
  }

  // Написали повторно по тому, что считалось решённым, — человек пишет
  // второй раз именно потому, что ему не ответили, и молчание здесь и есть
  // сама проблема. Ответ отправляем здесь явно: reactToStatusChange
  // отвечает реплаем на исходное обращение, а тут нужно ответить на новое
  // сообщение — то, которым человек напомнил о себе.
  if (wasResolved) {
    const language = pickLanguage(ownText);
    const text = buildStatusReplyText("SENT", language);
    if (text) {
      await sendBotReply({
        issueId: issue.id,
        chatId,
        replyToMessageId: message.message_id,
        kind: "FOLLOW_UP",
        text,
      });
    }
  }

  return true;
}

const MERGE_WINDOW_MS = 5 * 60 * 1000;

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json().catch(() => null);

  if (update?.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return NextResponse.json({ ok: true });
  }

  const message = update?.message ?? update?.edited_message;

  // Отвечаем 200 сразу же на всё, что нам не интересно, чтобы Telegram
  // не считал вебхук сломанным и не слал повторно.
  if (!message || message.from?.is_bot) {
    return NextResponse.json({ ok: true });
  }

  const text = extractText(message);
  if (!text) {
    return NextResponse.json({ ok: true });
  }

  // Если это ответ на чужое сообщение — приклеиваем цитату сверху. Хранится
  // уже вместе с цитатой (в TelegramMessage.text), чтобы её было видно и в
  // ленте "Входящих", и в исходнике для кнопки "ИИ написал не то?" — не
  // только на момент построения описания.
  const replyContext = extractReplyContextLine(message);
  // Отвечают не клиенту, а одному из наших агентов — эти цепочки чаще
  // внутреннее уточнение, чем пересказ жалобы, и buildDescription (см.
  // lib/ticketDescription.ts) относится к ним осторожнее.
  const repliesToOwnAgent = isOwnAgentMessage(message.reply_to_message?.from?.id);
  // Ответ на своё же более раннее сообщение — человек продолжает свою же
  // мысль ("а что если..."/"хотя, если подумать..."), а не заводит новое
  // обращение. Если то сообщение уже стало тикетом, attachFollowUpToTicket
  // ниже сам приклеит реплай к нему; если нет (например, было корректно
  // пропущено как рабочая переписка коллег) — эта реплика тоже не должна
  // тихо завести отдельный новый тикет по тем же причинам.
  const isSelfReply =
    message.reply_to_message?.from?.id != null &&
    message.from?.id != null &&
    message.reply_to_message.from.id === message.from.id;
  const skipAutoCreate = repliesToOwnAgent || isSelfReply;
  const contextualText = replyContext ? `${replyContext}\n${text}` : text;

  const authorName = extractAuthorName(message.from);
  const fromId = message.from?.id != null ? BigInt(message.from.id) : null;

  const chatId = String(message.chat.id);

  // Слэш-команды — только в личке с ботом, чтобы ответы с внутренними
  // данными (репорт, разбор тикетов) не улетали в группы поддержки, где их
  // увидели бы клиенты.
  if (message.chat.type === "private" && text.startsWith("/") && message.from?.id != null) {
    await handleBotCommand(message.chat.id, message.from.id, text);
    return NextResponse.json({ ok: true });
  }

  // Ответ (Reply) на prompt-сообщение "📝 Заметка" (см. ISSUE_NOTE_PREFIX
  // выше) — раньше проверки isOwnAgentMessage ниже, потому что сам агент
  // и есть автор такого ответа, а та проверка иначе тихо архивирует
  // сообщение как обычное и до этой ветки просто не дойдёт.
  const repliedToId = message.reply_to_message?.message_id;

  // Ответ реплаем на черновик автоответа ("Свой текст — ответь реплаем"):
  // отправляем в группу ровно то, что человек написал. Проверяется здесь
  // же, до разбора обычных сообщений: это личка, тикетом такое стать не
  // должно.
  if (repliedToId != null && message.chat.type === "private") {
    const draft = await prisma.pendingAutoReply.findUnique({
      where: { chatId_messageId: { chatId, messageId: repliedToId } },
    });
    if (draft) {
      await prisma.pendingAutoReply.delete({ where: { id: draft.id } });
      const own = text.trim();
      if (own) {
        await sendBotReply({
          issueId: draft.issueId,
          chatId: draft.targetChatId,
          replyToMessageId: draft.targetMessageId,
          kind: "ACK",
          text: own,
        });
        await sendTelegramMessage(message.chat.id, `📨 Отправлено: ${own}`);
      }
      return NextResponse.json({ ok: true });
    }
  }

  if (repliedToId != null) {
    const pending = await prisma.pendingNotePrompt.findUnique({
      where: { chatId_messageId: { chatId, messageId: repliedToId } },
    });
    if (pending) {
      const issue = await prisma.issue.findUnique({
        where: { id: pending.issueId },
        select: { status: true, telegramLink: true, createdBy: true },
      });
      if (issue) {
        const actorName =
          message.from?.id != null ? telegramIdToAgent(message.from.id) : null;
        if (pending.targetStatus) {
          await changeIssueStatus({
            issueId: pending.issueId,
            status: pending.targetStatus,
            note: text.trim(),
            actor: actorName,
            source: "app",
          });
        } else {
          await prisma.issue.update({
            where: { id: pending.issueId },
            data: { note: text.trim() },
          });
        }
        // Решили из разбора — в рабочем чате об этом ещё не знают, поэтому
        // предлагаем сообщить туда одной кнопкой. Если решение пришло с
        // догадки по реплике агента в группе, offerChatReply = false:
        // повторять за живым человеком не нужно.
        const offerNotify =
          pending.targetStatus === "RESOLVED" &&
          pending.offerChatReply &&
          issue.telegramLink != null &&
          (await isAutoReplyEnabled());
        await sendTelegramMessage(
          chatId,
          pending.targetStatus
            ? `${STATUS_META[pending.targetStatus].emoji} ${STATUS_META[pending.targetStatus].label}: заметка сохранена`
            : "✅ Заметка сохранена",
          offerNotify
            ? [
                [
                  {
                    text: "💬 Сообщить в чат, что решено",
                    callback_data: `${NOTIFY_RESOLVED_PREFIX}${pending.issueId}`,
                  },
                ],
              ]
            : undefined
        );
        await advanceReviewSession(chatId);
      }
      await prisma.pendingNotePrompt
        .delete({ where: { id: pending.id } })
        .catch(() => {});
      return NextResponse.json({ ok: true });
    }
  }

  const preset = await prisma.groupPreset.findUnique({ where: { chatId } });

  if (isOwnAgentMessage(message.from?.id)) {
    // Само сообщение агента тикетом не станет (см. комментарий у
    // isOwnAgentMessage), но сохранить его всё равно нужно: иначе, если
    // кто-то позже ответит на него реплаем с просьбой дать фидбэк,
    // attachFollowUpToTicket ищет исходное сообщение по chatId+messageId
    // и не находит ничего — реплай проваливается в никуда вместо того,
    // чтобы завестись как обычный тикет с контекстом-цитатой (см. ниже).
    // archived/viewed сразу true — это не запрос, показывать во
    // "Входящих" нечего.
    const messageLink = buildMessageLink(message.chat.id, message.message_id);
    // О каком тикете эта реплика. Считаем ДО записи, чтобы следующая
    // реплика того же агента могла опереться на неё как на "свой
    // разговор" (см. lib/agentThread.ts): без сохранённой связи цепочка
    // "Окей, қазір" → "өшірілді" рассыпается на два независимых сообщения.
    const target = await resolveAgentTarget({
      chatId,
      messageId: message.message_id,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      agentTelegramId: fromId,
      sentAt: new Date(),
    });
    const targetIssueId = target.kind === "found" ? target.issueId : null;
    await prisma.telegramMessage.upsert({
      where: { chatId_messageId: { chatId, messageId: message.message_id } },
      update: { agentIssueId: targetIssueId },
      create: {
        agentIssueId: targetIssueId,
        chatId,
        messageId: message.message_id,
        chatTitle: message.chat.title ?? null,
        groupName: preset?.name ?? null,
        groupEmoji: preset?.emoji ?? null,
        fromId,
        authorName,
        text: contextualText,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        messageLink,
        archived: true,
        viewed: true,
      },
    });
    // Реплика агента в группе — это и есть сигнал "взял в работу /
    // передал / сделал". Двигаем статус по ней, чтобы вечером не
    // проставлять заново то, что уже сделано днём.
    await applyAgentIntent(message, chatId, text, target);
    return NextResponse.json({ ok: true });
  }

  // Ответ на вопрос бота ("пришлите почту") — самый точный признак связи с
  // тикетом, поэтому проверяется первым: иначе присланная почта осталась бы
  // болтаться во "Входящих" отдельным сообщением, не привязанным ни к чему.
  if (await attachReplyToBotMessage(message, chatId, contextualText)) {
    return NextResponse.json({ ok: true });
  }

  // Точное совпадение "ответили на сообщение, у которого уже есть тикет" —
  // приоритетнее склейки по времени ниже: если оно сработало, дальше по
  // этому сообщению обрабатывать нечего.
  if (await attachFollowUpToTicket(message, chatId, text, contextualText)) {
    return NextResponse.json({ ok: true });
  }

  // Если этот же человек только что писал в этот же чат (в пределах
  // MERGE_WINDOW_MS) и это сообщение ещё не разобрано — считаем это
  // продолжением того же запроса и приклеиваем текст, а не заводим
  // новую карточку во "Входящих".
  const recent = fromId
    ? await prisma.telegramMessage.findFirst({
        where: { chatId, fromId, archived: false },
        orderBy: { receivedAt: "desc" },
      })
    : null;

  if (
    recent &&
    Date.now() - recent.receivedAt.getTime() < MERGE_WINDOW_MS
  ) {
    // Пропуск наследуется всей серией. Иначе решение "по этому сообщению
    // тикет не заводим" жило ровно до следующей фразы того же человека:
    // реплай нашему агенту тикета не заводил, а дописанное через две
    // секунды продолжение — заводило, причём вместе с процитированным
    // текстом агента. В проде так появились четыре тикета, включая ответ
    // Алпе на его же разбор.
    const skipSeries = skipAutoCreate || recent.skippedAutoIssue;
    // recent.text уже может содержать свою цитату (если само было
    // ответом) — просто приклеиваем следующее сообщение(с его цитатой)
    // следом, каждое несёт свой контекст само по себе.
    const mergedOwn = [recent.text, text].filter(Boolean).join("\n");
    const mergedContextual = [recent.text, contextualText]
      .filter(Boolean)
      .join("\n");
    await prisma.telegramMessage.update({
      where: { id: recent.id },
      data: {
        text: mergedContextual,
        viewed: false,
        skippedAutoIssue: skipSeries,
        // Подтягиваем время к последнему сообщению в серии — иначе
        // склеенная карточка «застревала» под старым receivedAt первого
        // сообщения и могла выпасть из фильтра «сегодня» во «Входящих»,
        // если серия началась вчера/раньше.
        receivedAt: new Date(),
      },
    });

    // Если по первому сообщению серии уже успел завестись авто-тикет —
    // подтягиваем в него дописанный текст, иначе на доске останется
    // только обрывок исходного запроса.
    let linkedIssueId: string | null = null;
    if (recent.usedForIssueId) {
      const merged = await buildDescription(mergedOwn, mergedContextual, skipSeries);
      // null тут означает "склеенный текст выглядит мусором" — описание не
      // трогаем, тикет уже заведён и затирать его нечем.
      if (merged !== null) {
        await prisma.issue.update({
          where: { id: recent.usedForIssueId },
          data: { description: merged },
        });
      }
      linkedIssueId = recent.usedForIssueId;
    } else if (preset) {
      // Тикета ещё нет: либо первое сообщение серии было голым
      // приветствием ("Қайырлы күн" → проблема следующим сообщением) —
      // самый частый порядок в этих чатах, — либо тогда группа была ещё
      // неизвестна. Теперь по склеенному тексту заводить уже может быть
      // что.
      const issue = await createAutoIssue(
        preset.name,
        preset.emoji,
        mergedOwn,
        mergedContextual,
        recent.messageLink,
        skipSeries
      );
      if (issue) {
        await prisma.telegramMessage.update({
          where: { id: recent.id },
          data: { usedForIssueId: issue.id },
        });
        // Отвечаем на последнее сообщение серии, а не на первое: именно
        // в нём чаще всего и оказывается сама проблема (первое сплошь и
        // рядом — просто "Қайырлы күн").
        await sendAcknowledgement(
          issue.id,
          chatId,
          message.message_id,
          mergedOwn,
          issue.groupName,
          fromId
        );
        linkedIssueId = issue.id;
      }
    }

    // У ЭТОГО message_id раньше не заводилось собственной строки — только
    // recent, keyed по messageId ПЕРВОГО сообщения серии, обновлялся текстом.
    // Из-за этого, если позже кто-то отвечал Telegram-реплаем именно на это
    // (не первое) сообщение серии, attachFollowUpToTicket не находил его в
    // базе вообще и заводил отдельный, оторванный тикет вместо того, чтобы
    // приклеить реплай к уже существующему. Теперь у каждого message_id
    // серии есть своя строка, указывающая на тот же тикет.
    const messageLink = buildMessageLink(message.chat.id, message.message_id);
    await prisma.telegramMessage.upsert({
      where: { chatId_messageId: { chatId, messageId: message.message_id } },
      update: {},
      create: {
        chatId,
        messageId: message.message_id,
        chatTitle: message.chat.title ?? null,
        groupName: preset?.name ?? null,
        groupEmoji: preset?.emoji ?? null,
        fromId,
        authorName,
        text: contextualText,
        replyToMessageId: message.reply_to_message?.message_id ?? null,
        messageLink,
        // Своя строка серии тоже помнит пропуск. Без этого память жила
        // ровно одно сообщение: третья фраза подряд находила эту строку
        // как "последнее сообщение автора", видела в ней пропуск = false и
        // заводила тикет, от которого две первые отказались.
        skippedAutoIssue: skipSeries,
        ...(linkedIssueId
          ? { usedForIssueId: linkedIssueId, archived: true, viewed: true }
          : {}),
      },
    });

    return NextResponse.json({ ok: true });
  }

  const messageLink = buildMessageLink(message.chat.id, message.message_id);
  const savedMessage = await prisma.telegramMessage.upsert({
    where: {
      chatId_messageId: { chatId, messageId: message.message_id },
    },
    update: {},
    create: {
      chatId,
      messageId: message.message_id,
      chatTitle: message.chat.title ?? null,
      groupName: preset?.name ?? null,
      groupEmoji: preset?.emoji ?? null,
      fromId,
      authorName,
      text: contextualText,
      replyToMessageId: message.reply_to_message?.message_id ?? null,
      messageLink,
      // Запоминаем решение, а не только применяем его: следующее сообщение
      // этого же человека склеится с этим, и там о пропуске нужно знать.
      skippedAutoIssue: skipAutoCreate,
    },
  });

  // Тот же человек уже писал сегодня в этот чат и по этому есть активный
  // (не решённый) тикет — это сообщение может быть тем же запросом,
  // присланным без Telegram Reply (типичный случай: попросили почту,
  // человек прислал её отдельным новым сообщением через 10+ минут — в окно
  // склейки MERGE_WINDOW_MS выше это уже не попадает). Слова могут не
  // пересекаться вообще, поэтому не similarity.ts, а ИИ (см.
  // isSameRequestFollowUp в lib/ai.ts). Без этой проверки нарочно не
  // фильтруем мусор регуляркой: голая почта в ответ на просьбу бота — для
  // isNoiseOnly и есть мусор (см. комментарий у attachReplyToBotMessage),
  // а именно её чаще всего и присылают вторым сообщением.
  if (preset && !savedMessage.usedForIssueId && (await isAiCleaningEnabled())) {
    const activeIssue = await findSameAuthorActiveIssue(chatId, fromId);
    if (activeIssue && (await isSameRequestFollowUp(activeIssue.description, text))) {
      // Только привязка, без ссылки в extraLinks — это тот же случай, а не
      // отдельное обращение (см. ATTACH_LINK_POLICY выше).
      await prisma.telegramMessage.update({
        where: { id: savedMessage.id },
        data: { usedForIssueId: activeIssue.id, archived: true, viewed: true },
      });
      return NextResponse.json({ ok: true });
    }
  }

  // Группа уже известна (чат раньше привязали вручную) — заводим тикет
  // сразу, без ручного "Создать тикет". upsert идемпотентен на повторных
  // доставках/edited_message, поэтому создаём тикет только один раз.
  if (preset && !savedMessage.usedForIssueId) {
    const issue = await createAutoIssue(
      preset.name,
      preset.emoji,
      text,
      contextualText,
      messageLink,
      skipAutoCreate
    );
    // issue === null — в сообщении не было запроса; оставляем его во
    // "Входящих" без тикета (см. buildDescription).
    if (issue) {
      await prisma.telegramMessage.update({
        where: { id: savedMessage.id },
        data: { usedForIssueId: issue.id },
      });
      await sendAcknowledgement(
        issue.id,
        chatId,
        message.message_id,
        text,
        issue.groupName,
        fromId
      );
    }
  }

  return NextResponse.json({ ok: true });
}
