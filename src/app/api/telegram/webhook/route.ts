import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { cleanTicketDescription, isNoiseOnly } from "@/lib/textClean";
import { isAiSkip, rewriteTicketDescriptionWithAI } from "@/lib/ai";
import { isAiCleaningEnabled } from "@/lib/settings";
import {
  AUTO_ISSUE_CREATOR,
  buildMessageLink,
  extractAuthorName,
  extractReplyContextLine,
  extractText,
  isOwnAgentMessage,
  type TelegramMessagePayload,
  type TelegramUpdate,
} from "@/lib/telegram";

// Готовит описание для авто-тикета — или null, если по этому сообщению
// тикет заводить не нужно (голое приветствие, одна ссылка, "рахмет"):
// такие карточки только забивают беклог, а само сообщение всё равно
// остаётся видно во "Входящих" и его можно завести руками.
//
// Два текста намеренно разные: `own` — то, что человек буквально напечатал
// (без цитаты), решает, мусор это или нет ("ок" в ответ на чей-то вопрос —
// всё ещё не тикет, независимо от вопроса). `contextual` — то же самое, но
// с приклеенной цитатой (см. extractReplyContextLine) — идёт в regex/ИИ,
// когда мусором не оказалось: реплика вроде "Әдістеме бөлінді... дейді"
// без вопроса, на который отвечали, превращается в нечитаемый обрывок.
//
// Тогл "aiCleaningEnabled" (см. lib/settings.ts, включается кнопкой в
// /inbox) решает, кто пишет описание: ИИ (Groq, переписывает сообщение,
// понимая контекст) или обычная regex-чистка. Если ИИ выключен, ключ не
// задан или запрос упал/подвис — тихо откатываемся на regex, чтобы вебхук
// не зависел от внешнего API.
async function buildDescription(
  own: string,
  contextual: string
): Promise<string | null> {
  // Дешёвая проверка идёт первой: очевидный мусор отсеиваем регулярками,
  // не тратя на него запрос к ИИ.
  if (isNoiseOnly(own)) return null;

  if (await isAiCleaningEnabled()) {
    const aiResult = await rewriteTicketDescriptionWithAI(contextual);
    if (aiResult) return isAiSkip(aiResult) ? null : aiResult;
  }
  return cleanTicketDescription(contextual);
}

// Заводит тикет "Отправлено" для уже известной группы, чтобы он сразу был
// виден на доске без ручного "Создать тикет". Возвращает null, если по
// сообщению заводить нечего (см. buildDescription).
async function createAutoIssue(
  groupName: string,
  groupEmoji: string | null,
  own: string,
  contextual: string,
  telegramLink: string
) {
  const reportDate = todayDateString();
  const [last, cleaned] = await Promise.all([
    prisma.issue.findFirst({
      where: { reportDate, groupName },
      orderBy: { position: "desc" },
    }),
    buildDescription(own, contextual),
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
  const alreadyLinked =
    messageLink === issue.telegramLink || issue.extraLinks.includes(messageLink);
  const fromId = message.from?.id != null ? BigInt(message.from.id) : null;
  const authorName = extractAuthorName(message.from);
  const wasResolved = issue.status === "RESOLVED";

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
        messageLink,
        usedForIssueId: issue.id,
        archived: true,
        viewed: true,
      },
    }),
    prisma.issue.update({
      where: { id: issue.id },
      data: {
        extraLinks: alreadyLinked ? undefined : { push: messageLink },
        ...(wasResolved
          ? {
              status: "SENT" as const,
              // Не затираем прежнюю заметку (там могло быть, что именно
              // делали) — дописываем поверх, чтобы было видно обе части
              // истории.
              note: issue.note
                ? `${issue.note} → жауап берілмеді, қайта хабарласты`
                : "Жауап берілмеді, қайта хабарласты",
            }
          : {}),
      },
    }),
  ]);

  return true;
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

  // Если это ответ на чужое сообщение — приклеиваем цитату сверху. Хранится
  // уже вместе с цитатой (в TelegramMessage.text), чтобы её было видно и в
  // ленте "Входящих", и в исходнике для кнопки "ИИ написал не то?" — не
  // только на момент построения описания.
  const replyContext = extractReplyContextLine(message);
  const contextualText = replyContext ? `${replyContext}\n${text}` : text;

  const authorName = extractAuthorName(message.from);
  const fromId = message.from?.id != null ? BigInt(message.from.id) : null;

  const chatId = String(message.chat.id);
  const preset = await prisma.groupPreset.findUnique({ where: { chatId } });

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
      const merged = await buildDescription(mergedOwn, mergedContextual);
      // null тут означает "склеенный текст выглядит мусором" — описание не
      // трогаем, тикет уже заведён и затирать его нечем.
      if (merged !== null) {
        await prisma.issue.update({
          where: { id: recent.usedForIssueId },
          data: { description: merged },
        });
      }
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
        recent.messageLink
      );
      if (issue) {
        await prisma.telegramMessage.update({
          where: { id: recent.id },
          data: { usedForIssueId: issue.id },
        });
      }
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
      text: contextualText,
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
      contextualText,
      messageLink
    );
    // issue === null — в сообщении не было запроса; оставляем его во
    // "Входящих" без тикета (см. buildDescription).
    if (issue) {
      await prisma.telegramMessage.update({
        where: { id: savedMessage.id },
        data: { usedForIssueId: issue.id },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
