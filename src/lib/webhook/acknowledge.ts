import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { buildDescription } from "@/lib/ticketDescription";
import { classifyAckAsk, classifySituation } from "@/lib/ai";
import { missingSlotsFor } from "@/lib/situations";
import { hasIdentifier, type AckAskKind } from "@/lib/autoReply";
import {
  buildReplyVariants,
  requestAutoReplyApproval,
} from "@/lib/autoReplyApproval";
import { findRelatedRecentIssue } from "@/lib/relatedIssue";
import { sendBotReply, hasBotReplied, agentAlreadyReplied } from "@/lib/botReply";
import {
  isAutoReplyEnabled,
  isAutoReplyConfirmEnabled,
  isAiAskEnabled,
} from "@/lib/settings";
import { AUTO_ISSUE_CREATOR, ownAgentTelegramIdList } from "@/lib/telegram";

// Приём входящего сообщения из рабочей группы: завести по нему тикет и,
// если автоответы включены, подтвердить приём в чат. Вынесено из
// webhook/route.ts единым блоком — весь кластер зависит только от lib-
// функций и вызывается лишь из POST-обработчика; поведение не меняется.

// Заводит тикет "Отправлено" для уже известной группы, чтобы он сразу был
// виден на доске без ручного "Создать тикет". Возвращает null, если по
// сообщению заводить нечего (см. buildDescription).
export async function createAutoIssue(
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

// Подтверждение приёма: бот отвечает реплаем сразу, как завёлся тикет —
// "жақсы, қарап береміз", и если в обращении не было ни почты, ни ссылки,
// ни номера, тут же просит их прислать (60% обращений приходят без них, и
// первый ответ агента уходит именно на это).
//
// Два предохранителя от дубля: один ACK на тикет (сообщения одного автора
// склеиваются, а вебхук может доставиться повторно) и молчание, если по
// этому обращению уже успел ответить живой человек.
export async function sendAcknowledgement(
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
