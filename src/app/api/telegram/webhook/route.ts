import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  buildMessageLink,
  extractAuthorName,
  extractText,
  isOwnAgentMessage,
  type TelegramUpdate,
} from "@/lib/telegram";

const MERGE_WINDOW_MS = 5 * 60 * 1000;

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json().catch(() => null);
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

  if (isOwnAgentMessage(message.from?.id)) {
    return NextResponse.json({ ok: true });
  }

  const authorName = extractAuthorName(message.from);
  const fromId = message.from?.id ?? null;

  const chatId = String(message.chat.id);
  const preset = await prisma.groupPreset.findUnique({ where: { chatId } });

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
    await prisma.telegramMessage.update({
      where: { id: recent.id },
      data: {
        text: [recent.text, text].filter(Boolean).join("\n"),
        viewed: false,
      },
    });
    return NextResponse.json({ ok: true });
  }

  await prisma.telegramMessage.upsert({
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
      text,
      messageLink: buildMessageLink(message.chat.id, message.message_id),
    },
  });

  return NextResponse.json({ ok: true });
}
