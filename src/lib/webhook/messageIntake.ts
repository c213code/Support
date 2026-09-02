import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { isNoiseOnly } from "@/lib/textClean";
import { STATUS_META } from "@/lib/status";
import { changeIssueStatus } from "@/lib/issueStatus";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { detectAgentIntent } from "@/lib/agentIntent";
import { type AgentTarget } from "@/lib/agentThread";
import { collectResolutionContext } from "@/lib/resolutionNote";
import { summarizeResolutionNote } from "@/lib/ai";
import { buildStatusReplyText, pickLanguage } from "@/lib/autoReply";
import { sendBotReply } from "@/lib/botReply";
import { isChatIntentEnabled, isAiCleaningEnabled } from "@/lib/settings";
import { RESOLVED_NOTE_LABEL } from "@/lib/webhook/callbacks";
import {
  AGENT_TARGET_PREFIX,
  CONFIRM_RESOLVED_PREFIX,
  RESOLVE_WITH_DRAFT_PREFIX,
} from "@/lib/telegramCallbacks";
import {
  buildMessageLink,
  extractAuthorName,
  sendTelegramMessage,
  type TelegramMessagePayload,
} from "@/lib/telegram";

// Разбор входящего сообщения агента/клиента, которое не заводит новый тикет,
// а меняет уже существующий: реплика агента в группе двигает статус
// (applyAgentIntent), присланная по просьбе бота почта цепляется к тикету
// (attachReplyToBotMessage), повторное обращение по "решённому" возвращает
// его в работу (attachFollowUpToTicket). Вынесено из webhook/route.ts —
// весь кластер зависит только от lib-функций и вызывается из POST; поведение
// не меняется.

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

export async function applyAgentIntent(
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
export async function attachReplyToBotMessage(
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
export async function findSameAuthorActiveIssue(
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
export async function attachFollowUpToTicket(
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
