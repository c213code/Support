import { prisma } from "@/lib/prisma";
import {
  sendTelegramMessage,
  editMessageText,
  deleteTelegramMessage,
} from "@/lib/telegram";
import { isAutoReplyEnabled } from "@/lib/settings";

// Telegram позволяет боту править и удалять свои сообщения только в
// течение 48 часов. Считаем сами, чтобы сказать человеку понятную причину
// вместо голого отказа от API.
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;

export type BotReplyKind =
  | "ACK"
  | "FOLLOW_UP"
  | "IN_PROGRESS"
  | "PENDING"
  | "ESCALATED"
  | "RESOLVED";

// Отправляет ответ бота в рабочую группу и запоминает его. Запоминаем не
// ради истории, а чтобы потом было что править и удалять: без message_id
// неудачный автоответ уже не достать (см. editBotReply/deleteBotReply).
//
// Тихо ничего не делает, если автоответы выключены рубильником — проверка
// здесь, в одной точке, а не в каждом месте вызова, чтобы её нельзя было
// забыть.
export async function sendBotReply(opts: {
  issueId: string;
  chatId: string;
  replyToMessageId: number;
  kind: BotReplyKind;
  text: string;
}): Promise<boolean> {
  if (!(await isAutoReplyEnabled())) return false;

  const sent = await sendTelegramMessage(
    opts.chatId,
    opts.text,
    undefined,
    undefined,
    undefined,
    opts.replyToMessageId
  );
  if (!sent) return false;

  await prisma.botReply.create({
    data: {
      issueId: opts.issueId,
      chatId: opts.chatId,
      messageId: sent.message_id,
      kind: opts.kind,
      text: opts.text,
    },
  });
  return true;
}

// Уже отвечали ли по этому тикету таким поводом. Защита от дубля: одно
// обращение — одно подтверждение, даже если сообщения склеились или
// вебхук по какой-то причине пришёл дважды.
export async function hasBotReplied(
  issueId: string,
  kind: BotReplyKind
): Promise<boolean> {
  const existing = await prisma.botReply.findFirst({
    where: { issueId, kind, deleted: false },
    select: { id: true },
  });
  return existing !== null;
}

// Живой человек уже ответил в этот чат после обращения — значит боту
// говорить нечего. Собственные сообщения агентов сохраняются в
// TelegramMessage (archived), по ним и проверяем.
export async function agentAlreadyReplied(
  chatId: string,
  afterMessageId: number,
  agentIds: bigint[]
): Promise<boolean> {
  if (agentIds.length === 0) return false;
  const reply = await prisma.telegramMessage.findFirst({
    where: {
      chatId,
      messageId: { gt: afterMessageId },
      fromId: { in: agentIds },
    },
    select: { id: true },
  });
  return reply !== null;
}

export type BotReplyActionResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "too-old" | "telegram-refused" };

export async function editBotReply(
  id: string,
  text: string
): Promise<BotReplyActionResult> {
  const reply = await prisma.botReply.findUnique({ where: { id } });
  if (!reply || reply.deleted) return { ok: false, reason: "not-found" };
  if (Date.now() - reply.sentAt.getTime() > EDIT_WINDOW_MS) {
    return { ok: false, reason: "too-old" };
  }

  const edited = await editMessageText(reply.chatId, reply.messageId, text);
  if (!edited) return { ok: false, reason: "telegram-refused" };

  await prisma.botReply.update({ where: { id }, data: { text } });
  return { ok: true };
}

export async function deleteBotReply(id: string): Promise<BotReplyActionResult> {
  const reply = await prisma.botReply.findUnique({ where: { id } });
  if (!reply || reply.deleted) return { ok: false, reason: "not-found" };
  if (Date.now() - reply.sentAt.getTime() > EDIT_WINDOW_MS) {
    return { ok: false, reason: "too-old" };
  }

  const removed = await deleteTelegramMessage(reply.chatId, reply.messageId);
  if (!removed) return { ok: false, reason: "telegram-refused" };

  // Строку не удаляем, а помечаем: так видно, что бот тут говорил и что
  // сказанное отозвали — иначе на карточке тикета просто пусто, и понять,
  // было ли что-то отправлено, уже нельзя.
  await prisma.botReply.update({ where: { id }, data: { deleted: true } });
  return { ok: true };
}

export function describeBotReplyFailure(
  reason: Exclude<BotReplyActionResult, { ok: true }>["reason"]
): string {
  switch (reason) {
    case "not-found":
      return "Ответ не найден — возможно, его уже удалили";
    case "too-old":
      return "Прошло больше 48 часов — Telegram не даёт править и удалять, убери вручную";
    case "telegram-refused":
      return "Telegram отклонил запрос, попробуй ещё раз";
  }
}
