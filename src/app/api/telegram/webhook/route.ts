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

  const chatId = String(message.chat.id);
  const preset = await prisma.groupPreset.findUnique({ where: { chatId } });

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
      authorName,
      text,
      messageLink: buildMessageLink(message.chat.id, message.message_id),
    },
  });

  return NextResponse.json({ ok: true });
}
