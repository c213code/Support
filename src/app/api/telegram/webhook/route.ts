import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildDescription } from "@/lib/ticketDescription";
import { STATUS_META } from "@/lib/status";
import { changeIssueStatus } from "@/lib/issueStatus";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { advanceReviewSession } from "@/lib/dailyReview";
import { handleBotCommand } from "@/lib/webhook/commands";
import { ensureMiniAppMenuButton, submissionFormEnabled } from "@/lib/miniapp";
import { handleCallbackQuery } from "@/lib/webhook/callbacks";
import { createAutoIssue, sendAcknowledgement } from "@/lib/webhook/acknowledge";
import { intakeCuratorMessage } from "@/lib/submissionChat";
import { collectDirectMessage, collectForwardedMessage, isForwarded } from "@/lib/forwardDraft";
import { isAgentTelegramId } from "@/lib/agentTelegram";
import { isNoiseOnly } from "@/lib/textClean";
import {
  applyAgentIntent,
  attachReplyToBotMessage,
  findSameAuthorActiveIssue,
  attachFollowUpToTicket,
} from "@/lib/webhook/messageIntake";
import { resolveAgentTarget, type AgentTarget } from "@/lib/agentThread";
import { isSameRequestFollowUp } from "@/lib/ai";
import { sendBotReply } from "@/lib/botReply";
import { isAutoReplyEnabled, isAiCleaningEnabled } from "@/lib/settings";
import { NOTIFY_RESOLVED_PREFIX } from "@/lib/telegramCallbacks";
import {
  buildMessageLink,
  extractAuthorName,
  extractReplyContextLine,
  captionAttachmentMarker,
  extractText,
  isOwnAgentMessage,
  sendTelegramMessage,
  type TelegramUpdate,
} from "@/lib/telegram";

const MERGE_WINDOW_MS = 5 * 60 * 1000;

export async function POST(request: NextRequest) {
  // Секрет обязателен. Раньше сравнивались просто два значения, и при пустой
  // переменной окружения запрос с пустым заголовком проходил как «совпало» —
  // то есть забытая настройка открывала вебхук наружу.
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!expected || secret !== expected) {
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
  // Для решения «тикет или нет» — с пометкой вложения: подпись к скриншоту
  // без него выглядит вопросом (см. captionAttachmentMarker). В базу и во
  // «Входящие» по-прежнему ложится сам текст.
  const attachment = captionAttachmentMarker(message);
  const textForTicket = attachment ? `${attachment}\n${contextualText}` : contextualText;

  const authorName = extractAuthorName(message.from);
  const fromId = message.from?.id != null ? BigInt(message.from.id) : null;

  const chatId = String(message.chat.id);

  // Кнопка меню с формой обращения должна стоять всегда, а не только сразу
  // после /start: Telegram подменяет её меню команд, и вернуть её потом
  // некому. Переставляем на каждое сообщение в личке — дешевле, чем
  // объяснять кураторам, куда делась кнопка.
  if (message.chat.type === "private") {
    await ensureMiniAppMenuButton(message.chat.id);
  }

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

  // Личка с куратором, подавшим обращение формой: его сообщение — это ответ
  // дежурному, а не новый запрос во "Входящие" (см. lib/submissionChat.ts).
  //
  // Стоит до ветки "это сообщение нашего агента" по той же причине, что и
  // проверки pendingAutoReply/pendingNotePrompt выше: агент бывает и автором
  // заявки (свой же курс, проверка фичи), и тогда его ответ реплаем на вопрос
  // бота уходил в разбор реплик агента, а в переписке не появлялся вовсе.
  // Ответ стрелкой на конкретное сообщение бота однозначен, кем бы он ни был
  // отправлен; остальные пути для агентов внутри намеренно выключены, чтобы
  // не перехватывать его переписку с ботом по другим сценариям.
  if (
    message.chat.type === "private" &&
    (await intakeCuratorMessage(message, chatId, text))
  ) {
    return NextResponse.json({ ok: true });
  }

  // Переписка, пересланная боту в личку, — это заготовка обращения, а не
  // сообщение во «Входящие»: кураторы пересылают готовую цепочку из своего
  // чата вместо того, чтобы набирать запрос заново. Собираем её в черновик
  // и даём кнопку «Өтініш жасау» (см. lib/forwardDraft.ts).
  // Только при включённой форме: без неё собирать черновик некуда
  // (collectForwardedMessage молча выходит без адреса мини-аппа), и
  // пересланное пропадало бы бесследно — ни черновика, ни «Входящих».
  if (
    message.chat.type === "private" &&
    isForwarded(message) &&
    fromId !== null &&
    submissionFormEnabled()
  ) {
    await collectForwardedMessage(message, fromId);
    return NextResponse.json({ ok: true });
  }

  // Куратор написал боту сам. Сюда доходит, только если это не ответ в
  // переписке по заявке и у него нет заявок, о которых спросить «про какую
  // это» (всё это забрал intakeCuratorMessage выше). Раньше такое тихо
  // ложилось во «Входящие» без группы — теперь копится черновиком, а бот
  // просит отправить формой (lib/forwardDraft.ts).
  //
  // Агенты сюда не попадают — у них в личке своя работа с ботом. Короткое
  // «рахмет» / «ок» без фото тоже нет: чаще всего это ответ на уведомление о
  // статусе, а не новый запрос, и черновик с кнопкой на него — шум.
  if (
    message.chat.type === "private" &&
    fromId !== null &&
    submissionFormEnabled() &&
    !isOwnAgentMessage(message.from?.id) &&
    !isAgentTelegramId(fromId) &&
    (Boolean(message.photo) || !isNoiseOnly(text))
  ) {
    await collectDirectMessage(message, fromId);
    return NextResponse.json({ ok: true });
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
    //
    // Время — отправки (message.date), а не получения: правку Telegram шлёт
    // тем же сообщением, и "полчаса до реплики" надо отсчитывать от того,
    // когда её написали, а не когда исправили.
    // Правка своей реплики: к какому тикету она, решили при отправке — со
    // стрелкой и тем окном переписки, что было тогда. Заново по правке
    // гадать нельзя: окно с тех пор сдвинулось, и исправленная опечатка
    // могла уехать в соседний тикет и сменить статус там.
    const earlier = update?.edited_message
      ? await prisma.telegramMessage.findUnique({
          where: { chatId_messageId: { chatId, messageId: message.message_id } },
          select: { agentIssueId: true, replyToMessageId: true },
        })
      : null;
    const target: AgentTarget = earlier?.agentIssueId
      ? { kind: "found", issueId: earlier.agentIssueId, reason: "reply" }
      : await resolveAgentTarget({
          chatId,
          messageId: message.message_id,
          replyToMessageId: message.reply_to_message?.message_id ?? earlier?.replyToMessageId ?? null,
          agentTelegramId: fromId,
          sentAt: new Date(message.date * 1000),
        });
    const targetIssueId = target.kind === "found" ? target.issueId : null;
    await prisma.telegramMessage.upsert({
      where: { chatId_messageId: { chatId, messageId: message.message_id } },
      // Правка (edited_message) обновляет текст: итог часто дописывают именно
      // правкой ("+7…\nпароль" → "…номермен кіреді екен"), и без этого
      // подсказка "Как решили?" видела первую версию. Привязку к тикету
      // правка не стирает: если заново определить не вышло, остаётся прежняя.
      update: {
        text: contextualText,
        ...(targetIssueId ? { agentIssueId: targetIssueId } : {}),
      },
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
        [recent.text, textForTicket].filter(Boolean).join("\n"),
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
      // отдельное обращение (см. ATTACH_LINK_POLICY в lib/webhook/messageIntake).
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
      textForTicket,
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
