import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { cleanTicketDescription } from "@/lib/textClean";
import { rewriteTicketDescriptionWithAI } from "@/lib/gemini";
import { isAiCleaningEnabled } from "@/lib/settings";
import {
  AUTO_ISSUE_CREATOR,
  buildMessageLink,
  extractAuthorName,
  extractText,
  isOwnAgentMessage,
  type TelegramUpdate,
} from "@/lib/telegram";

// Тогл "aiCleaningEnabled" (см. lib/settings.ts, включается кнопкой в
// /inbox) решает, кто пишет описание авто-тикета: Gemini (переписывает
// сообщение, понимая контекст) или обычная regex-чистка. Если ИИ выключен,
// ключ не задан или запрос упал/подвис — тихо откатываемся на regex, чтобы
// вебхук не зависел от внешнего API.
async function cleanDescription(raw: string): Promise<string> {
  if (await isAiCleaningEnabled()) {
    const aiResult = await rewriteTicketDescriptionWithAI(raw);
    if (aiResult) return aiResult;
  }
  return cleanTicketDescription(raw);
}

// Заводит тикет "Отправлено" для уже известной группы, чтобы он сразу был
// виден на доске без ручного "Создать тикет".
async function createAutoIssue(
  groupName: string,
  groupEmoji: string | null,
  description: string,
  telegramLink: string
) {
  const reportDate = todayDateString();
  const [last, cleaned] = await Promise.all([
    prisma.issue.findFirst({
      where: { reportDate, groupName },
      orderBy: { position: "desc" },
    }),
    cleanDescription(description),
  ]);
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
  const fromId = message.from?.id != null ? BigInt(message.from.id) : null;

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
    const mergedText = [recent.text, text].filter(Boolean).join("\n");
    await prisma.telegramMessage.update({
      where: { id: recent.id },
      data: {
        text: mergedText,
        viewed: false,
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
    if (recent.usedForIssueId) {
      await prisma.issue.update({
        where: { id: recent.usedForIssueId },
        data: { description: await cleanDescription(mergedText) },
      });
    }
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
      text,
      messageLink,
    },
  });

  // Группа уже известна (чат раньше привязали вручную) — заводим тикет
  // сразу, без ручного "Создать тикет". upsert идемпотентен на повторных
  // доставках/edited_message, поэтому создаём тикет только один раз.
  if (preset && !savedMessage.usedForIssueId) {
    const issue = await createAutoIssue(
      preset.name,
      preset.emoji,
      text,
      messageLink
    );
    await prisma.telegramMessage.update({
      where: { id: savedMessage.id },
      data: { usedForIssueId: issue.id },
    });
  }

  return NextResponse.json({ ok: true });
}
