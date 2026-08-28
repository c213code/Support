import { prisma } from "@/lib/prisma";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { setMessageReaction } from "@/lib/telegram";
import {
  buildSharedStatusReplyText,
  buildStatusReplyText,
  pickLanguage,
} from "@/lib/autoReply";
import { summarizeIssueTopic } from "@/lib/ai";
import { isStatusReplyEnabled } from "@/lib/settings";
import { sendBotReply, type BotReplyKind } from "@/lib/botReply";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";

// Откуда пришла смена статуса. Различать обязательно: если статус
// изменился потому, что агент сам написал в группу ("әріптестеріме
// жібердім"), то отвечать туда же тем же самым — значит попугайничать за
// живым человеком. Правило одно: бот пишет в группу только то, чего там
// ещё не прозвучало.
export type StatusChangeSource =
  // Сайт или кнопка в разборе — в группе об этом ещё не знают, бот пишет.
  | "app"
  // Разбор собственной реплики агента в группе — там уже всё сказано,
  // бот молчит и только двигает статус.
  | "chat";

// Реакция бота на смену статуса: эмодзи на исходном сообщении (👀 взяли,
// 👍 решили) плюс, если включены автоответы, текстовый ответ реплаем.
// Общая для PATCH /api/issues/[id] (сайт) и callback-кнопок в Telegram,
// чтобы эти два места не разъезжались логикой.
export async function reactToStatusChange(
  previousStatus: IssueStatus,
  nextStatus: IssueStatus,
  telegramLink: string | null,
  source: StatusChangeSource = "app",
  issueId?: string
): Promise<void> {
  if (nextStatus === previousStatus || !telegramLink) return;

  const emoji = STATUS_META[nextStatus].reactionEmoji;
  const message = await prisma.telegramMessage.findFirst({
    where: { messageLink: telegramLink },
    select: { chatId: true, messageId: true, text: true },
  });
  if (!message) return;

  await setMessageReaction(message.chatId, message.messageId, emoji);

  // "Решено" сюда не попадает намеренно: это единственный ответ, который
  // утверждает факт, поэтому уходит только после подтверждения человеком
  // (см. ISSUE_RESOLVE_PREFIX в вебхуке), а не автоматически при смене
  // статуса.
  if (source !== "app" || !issueId || nextStatus === "RESOLVED") return;
  // Реакция-эмодзи выше остаётся всегда: она видна только на исходном
  // сообщении и никого не отвлекает. Выключается именно текст в чате.
  if (!(await isStatusReplyEnabled())) return;

  const language = pickLanguage(message.text ?? "");

  // Тикет, в который слили несколько обращений (extraLinks непустой), —
  // это одна поломка у нескольких человек. Реплаем тут отвечать нельзя:
  // цитата выделит одного, а написали все. Отвечаем одним сообщением без
  // цитаты и с названием темы — иначе "жұмысқа алдық" повиснет в чате ни
  // к чему не привязанное.
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { extraLinks: true, description: true },
  });
  const shared = (issue?.extraLinks.length ?? 0) > 0;

  if (shared) {
    const topic = await summarizeIssueTopic(issue?.description ?? "");
    const sharedText = buildSharedStatusReplyText(nextStatus, language, topic);
    if (!sharedText) return;
    await sendBotReply({
      issueId,
      chatId: message.chatId,
      kind: nextStatus as BotReplyKind,
      text: sharedText,
    });
    return;
  }

  const text = buildStatusReplyText(nextStatus, language);
  if (!text) return;

  await sendBotReply({
    issueId,
    chatId: message.chatId,
    replyToMessageId: message.messageId,
    kind: nextStatus as BotReplyKind,
    text,
  });
}

// Единственное место, где меняется статус тикета.
//
// До него смена статуса была рассыпана по восьми местам, и каждое должно
// было помнить три вещи разом: обновить сам статус, переоформить автора с
// "Бота" на живого агента и позвать reactToStatusChange с правильным
// source. Забыть любую из них ничего не ломало заметно — просто где-то не
// появлялась реакция, где-то тикет навсегда оставался за ботом, а один
// путь и вовсе был помечен в коде как "меняет статус в обход".
//
// Теперь порядок один и записан один раз. Заодно отсюда, и только отсюда,
// пишется история статусов (IssueEvent) и время последней смены
// (statusChangedAt) — иначе история была бы полна ровно настолько,
// насколько внимательны все вызывающие.
export type StatusChangeResult =
  | { ok: false; reason: "not-found" }
  | { ok: true; previous: IssueStatus; changed: boolean };

export async function changeIssueStatus(params: {
  issueId: string;
  status: IssueStatus;
  // Кто меняет: имя агента либо null, если действие не привязано к
  // человеку (например, автоматика вебхука).
  actor: string | null;
  source: StatusChangeSource;
  // Поля, которые в этих же местах меняются вместе со статусом.
  note?: string | null;
  escalatedTeam?: string | null;
  escalatedAssignee?: string | null;
}): Promise<StatusChangeResult> {
  const { issueId, status, actor, source } = params;

  const existing = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { status: true, telegramLink: true, createdBy: true },
  });
  if (!existing) return { ok: false, reason: "not-found" };

  const changed = existing.status !== status;

  await prisma.issue.update({
    where: { id: issueId },
    data: {
      status,
      ...(changed ? { statusChangedAt: new Date() } : {}),
      ...(params.note !== undefined ? { note: params.note } : {}),
      ...(params.escalatedTeam !== undefined
        ? { escalatedTeam: params.escalatedTeam }
        : {}),
      ...(params.escalatedAssignee !== undefined
        ? { escalatedAssignee: params.escalatedAssignee }
        : {}),
      // Авто-тикет числится за ботом ровно до первого действия живого
      // агента — дальше он его.
      ...(actor && existing.createdBy === AUTO_ISSUE_CREATOR
        ? { createdBy: actor }
        : {}),
    },
  });

  if (!changed) return { ok: true, previous: existing.status, changed: false };

  await prisma.issueEvent.create({
    data: {
      issueId,
      from: existing.status,
      to: status,
      actor: actor ?? AUTO_ISSUE_CREATOR,
      source,
    },
  });

  await reactToStatusChange(
    existing.status,
    status,
    existing.telegramLink,
    source,
    issueId
  );

  return { ok: true, previous: existing.status, changed: true };
}
