import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString, formatTimeAlmaty } from "@/lib/date";
import { isNoiseOnly } from "@/lib/textClean";
import { buildDescription } from "@/lib/ticketDescription";
import { isIssueStatus, STATUS_META, type IssueStatus } from "@/lib/status";
import { ESCALATION_TEAMS, isEscalationTeam } from "@/lib/escalation";
import { reactToStatusChange } from "@/lib/issueStatus";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { SHARED_AGENT } from "@/lib/agents";
import {
  advanceReviewSession,
  startReviewSession,
  goBackReviewSession,
  buildReviewSummary,
} from "@/lib/dailyReview";
import { startDedupeReview, advanceDedupeReview } from "@/lib/dedupeReview";
import { sendReportToGroup, type SendReportResult } from "@/lib/reportSend";
import { detectAgentIntent } from "@/lib/agentIntent";
import { bestSolution } from "@/lib/solutionLibrary";
import { pickResolvedWord } from "@/lib/ai";
import {
  buildAckText,
  buildResolvedText,
  buildStatusReplyText,
  pickLanguage,
} from "@/lib/autoReply";
import {
  sendBotReply,
  hasBotReplied,
  agentAlreadyReplied,
  deleteBotReply,
  describeBotReplyFailure,
} from "@/lib/botReply";
import {
  isAutoReplyEnabled,
  setAutoReplyEnabled,
  isChatIntentEnabled,
  setChatIntentEnabled,
} from "@/lib/settings";
import {
  ISSUE_STATUS_PREFIX,
  ISSUE_ESCALATE_PREFIX,
  ISSUE_ESCALATE_TEAM_PREFIX,
  ISSUE_NOTE_PREFIX,
  ISSUE_RESOLVE_PREFIX,
  ISSUE_PENDING_PREFIX,
  SKIP_TICKET_PREFIX,
  BACK_TICKET_PREFIX,
  REPORT_SEND_PREFIX,
  START_REVIEW_PREFIX,
  START_DEDUPE_PREFIX,
  DEDUPE_MERGE_PREFIX,
  DEDUPE_SKIP_PREFIX,
  NOTIFY_RESOLVED_PREFIX,
  CONFIRM_RESOLVED_PREFIX,
  SOLVE_LIKE_PREFIX,
  BROADCAST_SEND_PREFIX,
  BROADCAST_CANCEL_PREFIX,
  BOT_REPLIES_PREFIX,
  BOT_REPLY_DELETE_PREFIX,
} from "@/lib/telegramCallbacks";
import {
  AUTO_ISSUE_CREATOR,
  answerCallbackQuery,
  buildMessageLink,
  editMessageReplyMarkup,
  editMessageText,
  extractAuthorName,
  extractReplyContextLine,
  extractText,
  isOwnAgentMessage,
  ownAgentTelegramIdList,
  sendTelegramMessage,
  type TelegramCallbackQuery,
  type TelegramMessagePayload,
  type TelegramUpdate,
} from "@/lib/telegram";

// Общий шаг для "📝 Заметка"/"✅ Решено"/"⏳ Пендинг" на карточке разбора:
// кнопкой текст не набрать, поэтому просим ответить (Reply) на отдельное
// сообщение и запоминаем связь message_id → issueId (+ опционально
// targetStatus) в PendingNotePrompt — по ней POST-хендлер вебхука узнаёт,
// что реплай от агента не обычное сообщение, а ответ на этот prompt.
async function sendNotePrompt(
  query: TelegramCallbackQuery,
  issueId: string,
  promptText: string,
  targetStatus: IssueStatus | null,
  // Предложить ли после сохранения заметки сообщить о решении в рабочий
  // чат. true — когда решение пришло из разбора (в группе ещё не знают).
  offerChatReply = false
): Promise<void> {
  const existing = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { description: true },
  });
  if (!existing) {
    await answerCallbackQuery(query.id, "Тикет не найден — возможно, уже удалён", true);
    return;
  }
  await answerCallbackQuery(query.id);
  if (!query.message) return;

  const prompt = await sendTelegramMessage(
    query.message.chat.id,
    `${promptText}\n${existing.description}`
  );
  if (!prompt) return;

  await prisma.pendingNotePrompt.upsert({
    where: {
      chatId_messageId: {
        chatId: String(query.message.chat.id),
        messageId: prompt.message_id,
      },
    },
    update: { issueId, targetStatus, offerChatReply },
    create: {
      chatId: String(query.message.chat.id),
      messageId: prompt.message_id,
      issueId,
      targetStatus,
      offerChatReply,
    },
  });
}

// Шлёт в рабочую группу единственный автоответ, утверждающий факт:
// "Жөңделді"/"Өзгертілді". Слово выбирает ИИ по сути тикета, язык — по
// исходному сообщению. Вызывается только по явному нажатию человека.
async function notifyResolvedInChat(issueId: string): Promise<boolean> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { description: true, note: true, telegramLink: true },
  });
  if (!issue?.telegramLink) return false;

  const source = await prisma.telegramMessage.findFirst({
    where: { messageLink: issue.telegramLink },
    select: { chatId: true, messageId: true, text: true },
  });
  if (!source) return false;

  const kind = await pickResolvedWord(issue.description, issue.note);
  return sendBotReply({
    issueId,
    chatId: source.chatId,
    replyToMessageId: source.messageId,
    kind: "RESOLVED",
    text: buildResolvedText(kind, pickLanguage(source.text ?? "")),
  });
}

// Нажатия на инлайн-кнопки под вечерней сводкой (см.
// /api/cron/evening-report) и под карточками отдельных тикетов — дают
// агенту менять статус тикета или разослать готовый репорт в рабочую
// группу прямо из Telegram, без захода на сайт.
async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data ?? "";

  if (data.startsWith(ISSUE_STATUS_PREFIX)) {
    const [issueId, status] = data.slice(ISSUE_STATUS_PREFIX.length).split(":");
    if (!issueId || !isIssueStatus(status)) {
      await answerCallbackQuery(query.id, "Неизвестное действие");
      return;
    }

    const existing = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { status: true, telegramLink: true, createdBy: true },
    });
    if (!existing) {
      await answerCallbackQuery(query.id, "Тикет не найден — возможно, уже удалён", true);
      return;
    }

    // Тот же принцип, что у PATCH /api/issues/[id]: если тикет ещё
    // числится за ботом, первое же действие живого агента (тут — клик по
    // кнопке) переоформляет автора на него. Кто именно нажал, узнаём по
    // Telegram id из callback_query, а не из тела запроса.
    const actorName = telegramIdToAgent(query.from.id);
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        status,
        ...(actorName && existing.createdBy === AUTO_ISSUE_CREATOR
          ? { createdBy: actorName }
          : {}),
      },
    });
    // "app": кнопку нажали в разборе, в рабочем чате об этом ещё не
    // знают — значит бот там отвечает (если автоответы включены).
    await reactToStatusChange(existing.status, status, existing.telegramLink, "app", issueId);
    await answerCallbackQuery(
      query.id,
      `Статус: ${STATUS_META[status].emoji} ${STATUS_META[status].label}`
    );
    // Тикеты дня разбираются по одному (см. dailyReview.ts) — после
    // действия карточка сама переходит к следующему нерешённому.
    if (query.message) {
      await advanceReviewSession(String(query.message.chat.id));
    }
    return;
  }

  // Первый шаг передачи команде — статус ESCALATED без выбранной команды
  // не имеет смысла (см. escalatedTeam на Issue), поэтому кнопка не меняет
  // статус сама, а спрашивает команду отдельным сообщением с кнопками.
  if (data.startsWith(ISSUE_ESCALATE_PREFIX)) {
    const issueId = data.slice(ISSUE_ESCALATE_PREFIX.length);
    const existing = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true },
    });
    if (!existing) {
      await answerCallbackQuery(query.id, "Тикет не найден — возможно, уже удалён", true);
      return;
    }
    await answerCallbackQuery(query.id);
    if (query.message) {
      const teamKeyboard = [
        ESCALATION_TEAMS.slice(0, 2),
        ESCALATION_TEAMS.slice(2, 4),
      ].map((row) =>
        row.map((team) => ({
          text: team,
          callback_data: `${ISSUE_ESCALATE_TEAM_PREFIX}${issueId}:${team}`,
        }))
      );
      await sendTelegramMessage(query.message.chat.id, "Кому передать?", teamKeyboard);
    }
    return;
  }

  if (data.startsWith(ISSUE_ESCALATE_TEAM_PREFIX)) {
    const [issueId, team] = data.slice(ISSUE_ESCALATE_TEAM_PREFIX.length).split(":");
    if (!issueId || !isEscalationTeam(team)) {
      await answerCallbackQuery(query.id, "Неизвестная команда");
      return;
    }

    const existing = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { status: true, telegramLink: true, createdBy: true },
    });
    if (!existing) {
      await answerCallbackQuery(query.id, "Тикет не найден — возможно, уже удалён", true);
      return;
    }

    const actorName = telegramIdToAgent(query.from.id);
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        status: "ESCALATED",
        escalatedTeam: team,
        ...(actorName && existing.createdBy === AUTO_ISSUE_CREATOR
          ? { createdBy: actorName }
          : {}),
      },
    });
    await reactToStatusChange(
      existing.status,
      "ESCALATED",
      existing.telegramLink,
      "app",
      issueId
    );
    await answerCallbackQuery(query.id, `Передано: ${team} ⚠️`);
    if (query.message) {
      // Это сообщение — только клавиатура выбора команды, использована,
      // больше не нужна. Карточка разбора (dailyReview.ts) — отдельное
      // сообщение в том же чате, её и двигаем к следующему тикету.
      await editMessageReplyMarkup(query.message.chat.id, query.message.message_id, null);
      await advanceReviewSession(String(query.message.chat.id));
    }
    return;
  }

  // Заметку через кнопку не набрать — просим ответить (Reply) текстом на
  // отдельное сообщение и запоминаем связь message_id → issueId
  // (PendingNotePrompt), чтобы в основном обработчике POST отличить такой
  // ответ от обычного сообщения агента. targetStatus — если задан, статус
  // применяется вместе с заметкой по приходу ответа (см. "✅ Решено" /
  // "⏳ Пендинг" ниже); null — старое поведение "просто заметка".
  if (data.startsWith(ISSUE_NOTE_PREFIX)) {
    await sendNotePrompt(
      query,
      data.slice(ISSUE_NOTE_PREFIX.length),
      "✍️ Ответь на ЭТО сообщение текстом — он станет заметкой для тикета:",
      null
    );
    return;
  }

  // "✅ Решено"/"⏳ Пендинг" не меняют статус сразу — сначала спрашивают
  // "как решили"/"что сейчас" тем же реплай-механизмом, что и заметка: без
  // текста статус применять нет смысла — именно эта заметка попадёт в
  // репорт, который уйдёт боссам (см. ResolveDialog на сайте — там та же
  // логика).
  if (data.startsWith(ISSUE_RESOLVE_PREFIX)) {
    await sendNotePrompt(
      query,
      data.slice(ISSUE_RESOLVE_PREFIX.length),
      "✅ Как решили? Ответь на ЭТО сообщение текстом — тикет:",
      "RESOLVED",
      // Решение пришло из разбора — в рабочем чате об этом ещё не знают,
      // поэтому после заметки предложим туда написать.
      true
    );
    return;
  }

  // Тот же запрос заметки, но по догадке бота: агент написал в группе
  // "жөңделді", бот уточняет в личке. Сообщать в чат не предлагаем — там
  // уже всё сказано живым человеком.
  if (data.startsWith(CONFIRM_RESOLVED_PREFIX)) {
    await sendNotePrompt(
      query,
      data.slice(CONFIRM_RESOLVED_PREFIX.length),
      "✅ Что именно сделали? Ответь на ЭТО сообщение — заметка уйдёт в репорт. Тикет:",
      "RESOLVED",
      false
    );
    return;
  }

  // "Решить так же" — применяет заметку похожего уже закрытого тикета.
  // Подсказка пересчитывается здесь, а не берётся из callback_data: два
  // cuid'а туда не влезли бы (лимит 64 байта), а заодно так исключено,
  // что применится устаревший вариант.
  if (data.startsWith(SOLVE_LIKE_PREFIX)) {
    const issueId = data.slice(SOLVE_LIKE_PREFIX.length);
    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true, description: true, status: true, telegramLink: true, createdBy: true },
    });
    if (!issue) {
      await answerCallbackQuery(query.id, "Тикет не найден — возможно, уже удалён", true);
      return;
    }

    const suggestion = await bestSolution(issue);
    if (!suggestion) {
      await answerCallbackQuery(query.id, "Похожего решения больше не нашлось", true);
      return;
    }

    const actorName = telegramIdToAgent(query.from.id);
    await prisma.issue.update({
      where: { id: issueId },
      data: {
        status: "RESOLVED",
        note: suggestion.note,
        ...(actorName && issue.createdBy === AUTO_ISSUE_CREATOR
          ? { createdBy: actorName }
          : {}),
      },
    });
    await reactToStatusChange(issue.status, "RESOLVED", issue.telegramLink, "app", issueId);
    await answerCallbackQuery(query.id, `✅ Решено: ${suggestion.note}`);

    // Как и у обычного "Решено": в рабочем чате об этом ещё не знают,
    // поэтому предлагаем сообщить туда одной кнопкой.
    if (query.message && issue.telegramLink && (await isAutoReplyEnabled())) {
      await sendTelegramMessage(
        query.message.chat.id,
        `✅ Решено: ${suggestion.note}`,
        [
          [
            {
              text: "💬 Сообщить в чат, что решено",
              callback_data: `${NOTIFY_RESOLVED_PREFIX}${issueId}`,
            },
          ],
        ]
      );
    }
    if (query.message) {
      await advanceReviewSession(String(query.message.chat.id));
    }
    return;
  }

  // Рассылка объявления по всем привязанным группам. Уходит только после
  // подтверждения: это сообщение видят сразу все рабочие чаты, и отменить
  // его потом можно лишь удаляя по одному.
  if (data.startsWith(BROADCAST_SEND_PREFIX)) {
    const draftId = data.slice(BROADCAST_SEND_PREFIX.length);
    const draft = await prisma.broadcastDraft.findUnique({ where: { id: draftId } });
    if (!draft) {
      await answerCallbackQuery(query.id, "Черновик не найден", true);
      return;
    }

    const presets = await prisma.groupPreset.findMany({
      where: { chatId: { not: null } },
      orderBy: { order: "asc" },
    });
    let sent = 0;
    for (const preset of presets) {
      if (!preset.chatId) continue;
      if (await sendTelegramMessage(preset.chatId, draft.text)) sent++;
    }

    await prisma.broadcastDraft.delete({ where: { id: draftId } }).catch(() => {});
    await answerCallbackQuery(query.id, `Отправлено в ${sent} групп ✅`);
    if (query.message) {
      await editMessageText(
        query.message.chat.id,
        query.message.message_id,
        `📢 Разослано в ${sent} групп:\n\n${draft.text}`,
        null
      );
    }
    return;
  }

  if (data.startsWith(BROADCAST_CANCEL_PREFIX)) {
    const draftId = data.slice(BROADCAST_CANCEL_PREFIX.length);
    await prisma.broadcastDraft.delete({ where: { id: draftId } }).catch(() => {});
    await answerCallbackQuery(query.id, "Отменено");
    if (query.message) {
      await editMessageText(
        query.message.chat.id,
        query.message.message_id,
        "Рассылка отменена.",
        null
      );
    }
    return;
  }

  // Список того, что бот сказал в группе по этому тикету, с кнопкой
  // удаления у каждого сообщения. На сайте это же есть на карточке, но
  // дежурный сидит в телефоне — значит и убрать неудачный ответ надо уметь
  // отсюда.
  if (data.startsWith(BOT_REPLIES_PREFIX)) {
    const issueId = data.slice(BOT_REPLIES_PREFIX.length);
    const replies = await prisma.botReply.findMany({
      where: { issueId, deleted: false },
      orderBy: { sentAt: "asc" },
    });
    await answerCallbackQuery(query.id);
    if (!query.message) return;

    if (replies.length === 0) {
      await sendTelegramMessage(query.message.chat.id, "По этому тикету бот ничего не писал.");
      return;
    }

    await sendTelegramMessage(
      query.message.chat.id,
      `🤖 Бот написал в группу:\n\n${replies.map((r, i) => `${i + 1}. ${r.text}`).join("\n\n")}`,
      replies.map((r, i) => [
        {
          text: `🗑 Удалить ${i + 1}`,
          callback_data: `${BOT_REPLY_DELETE_PREFIX}${r.id}`,
        },
      ])
    );
    return;
  }

  if (data.startsWith(BOT_REPLY_DELETE_PREFIX)) {
    const result = await deleteBotReply(data.slice(BOT_REPLY_DELETE_PREFIX.length));
    await answerCallbackQuery(
      query.id,
      result.ok ? "Удалено из группы ✅" : describeBotReplyFailure(result.reason),
      !result.ok
    );
    if (result.ok && query.message) {
      // Клавиатуру снимаем целиком: остальные кнопки в этом сообщении
      // ссылаются на номера из уже устаревшего списка, и жать их вслепую
      // опаснее, чем открыть список заново.
      await editMessageReplyMarkup(query.message.chat.id, query.message.message_id, null);
    }
    return;
  }

  if (data.startsWith(NOTIFY_RESOLVED_PREFIX)) {
    const issueId = data.slice(NOTIFY_RESOLVED_PREFIX.length);
    const sent = await notifyResolvedInChat(issueId);
    await answerCallbackQuery(
      query.id,
      sent
        ? "Отправлено в чат ✅"
        : "Не получилось — проверь, включены ли автоответы",
      !sent
    );
    if (sent && query.message) {
      await editMessageReplyMarkup(query.message.chat.id, query.message.message_id, null);
    }
    return;
  }

  if (data.startsWith(ISSUE_PENDING_PREFIX)) {
    await sendNotePrompt(
      query,
      data.slice(ISSUE_PENDING_PREFIX.length),
      "⏳ Что сейчас с этим тикетом? Ответь на ЭТО сообщение текстом — тикет:",
      "PENDING"
    );
    return;
  }

  // Пропустить текущий тикет разбора без изменения статуса — просто
  // переходим к следующему.
  if (data.startsWith(SKIP_TICKET_PREFIX)) {
    await answerCallbackQuery(query.id);
    if (query.message) {
      await advanceReviewSession(String(query.message.chat.id));
    }
    return;
  }

  // Вернуться к предыдущему тикету очереди — промахнулись мимо кнопки или
  // пропустили не тот. Статус текущего тикета не трогаем.
  if (data.startsWith(BACK_TICKET_PREFIX)) {
    await answerCallbackQuery(query.id);
    if (query.message) {
      await goBackReviewSession(String(query.message.chat.id));
    }
    return;
  }

  // Запуск разбора тикетов по одному — отдельная кнопка под сводкой, не
  // автоматика: сначала виден весь репорт, разбор начинается явно.
  if (data.startsWith(START_REVIEW_PREFIX)) {
    const reportDate = data.slice(START_REVIEW_PREFIX.length);
    await answerCallbackQuery(query.id);
    if (query.message) {
      await startReviewSession(query.message.chat.id, reportDate);
      // Снимаем только эту кнопку — "Отправить в группу" в том же
      // сообщении должна остаться рабочей.
      const remainingRows = (
        query.message.reply_markup?.inline_keyboard ?? []
      ).filter(
        (row) => !row.some((btn) => btn.callback_data.startsWith(START_REVIEW_PREFIX))
      );
      await editMessageReplyMarkup(
        query.message.chat.id,
        query.message.message_id,
        remainingRows.length > 0 ? remainingRows : null
      );
    }
    return;
  }

  // Запуск разбора похожих (дублей) тикетов — тот же принцип, что и
  // START_REVIEW_PREFIX: отдельная явная кнопка под сводкой.
  if (data.startsWith(START_DEDUPE_PREFIX)) {
    const reportDate = data.slice(START_DEDUPE_PREFIX.length);
    await answerCallbackQuery(query.id);
    if (query.message) {
      await startDedupeReview(query.message.chat.id, reportDate);
      // Снимаем только эту кнопку — остальные (Отправить/Начать разбор) в
      // том же сообщении должны остаться рабочими.
      const remainingRows = (
        query.message.reply_markup?.inline_keyboard ?? []
      ).filter(
        (row) => !row.some((btn) => btn.callback_data.startsWith(START_DEDUPE_PREFIX))
      );
      await editMessageReplyMarkup(
        query.message.chat.id,
        query.message.message_id,
        remainingRows.length > 0 ? remainingRows : null
      );
    }
    return;
  }

  if (data === DEDUPE_MERGE_PREFIX || data === DEDUPE_SKIP_PREFIX) {
    await answerCallbackQuery(query.id);
    if (query.message) {
      const actorName = telegramIdToAgent(query.from.id) ?? SHARED_AGENT;
      await advanceDedupeReview(
        String(query.message.chat.id),
        data === DEDUPE_MERGE_PREFIX,
        actorName
      );
    }
    return;
  }

  if (data.startsWith(REPORT_SEND_PREFIX)) {
    const reportDate = data.slice(REPORT_SEND_PREFIX.length);
    const result = await sendReportToGroup(reportDate);
    if (!result.ok) {
      await answerCallbackQuery(query.id, describeSendFailure(result), true);
      return;
    }
    await answerCallbackQuery(query.id, "Отправлено в группу ✅");
    if (query.message) {
      await editMessageReplyMarkup(query.message.chat.id, query.message.message_id, null);
    }
    return;
  }

  await answerCallbackQuery(query.id);
}

// Текст отказа для кнопки "Отправить в группу" и команды /send — общий,
// чтобы формулировка не разъезжалась между двумя местами вызова
// sendReportToGroup.
function describeSendFailure(
  result: Extract<SendReportResult, { ok: false }>
): string {
  switch (result.reason) {
    case "no-target":
      return "Группа для отправки ещё не настроена (REPORT_TARGET_CHAT_ID)";
    case "empty":
      return "За этот день нечего отправлять";
    case "already-sent":
      return `Уже отправлено сегодня в ${formatTimeAlmaty(result.sentAt)}`;
  }
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

// Подтверждение приёма: бот отвечает реплаем сразу, как завёлся тикет —
// "жақсы, қарап береміз", и если в обращении не было ни почты, ни ссылки,
// ни номера, тут же просит их прислать (60% обращений приходят без них, и
// первый ответ агента уходит именно на это).
//
// Два предохранителя от дубля: один ACK на тикет (сообщения одного автора
// склеиваются, а вебхук может доставиться повторно) и молчание, если по
// этому обращению уже успел ответить живой человек.
async function sendAcknowledgement(
  issueId: string,
  chatId: string,
  messageId: number,
  incomingText: string
): Promise<void> {
  if (await hasBotReplied(issueId, "ACK")) return;
  if (await agentAlreadyReplied(chatId, messageId, ownAgentTelegramIdList())) return;

  await sendBotReply({
    issueId,
    chatId,
    replyToMessageId: messageId,
    kind: "ACK",
    text: buildAckText(incomingText),
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
async function applyAgentIntent(
  message: TelegramMessagePayload,
  chatId: string,
  ownText: string
): Promise<void> {
  if (!(await isChatIntentEnabled())) return;

  const intent = detectAgentIntent(ownText);
  if (!intent) return;

  let issueId: string | null = null;
  const repliedId = message.reply_to_message?.message_id;
  if (repliedId != null) {
    const replied = await prisma.telegramMessage.findUnique({
      where: { chatId_messageId: { chatId, messageId: repliedId } },
      select: { usedForIssueId: true },
    });
    issueId = replied?.usedForIssueId ?? null;
  }

  if (!issueId) {
    // Тикеты этого чата ищем через сообщения, которые их породили —
    // связь чат→тикет живёт именно там (у самого Issue есть только ссылка
    // строкой, по ней фильтровать пришлось бы префиксом).
    const linked = await prisma.telegramMessage.findMany({
      where: { chatId, usedForIssueId: { not: null } },
      select: { usedForIssueId: true },
      orderBy: { receivedAt: "desc" },
      take: 30,
    });
    const ids = Array.from(
      new Set(linked.map((m) => m.usedForIssueId).filter((id): id is string => id !== null))
    );
    if (ids.length === 0) return;

    const open = await prisma.issue.findMany({
      where: {
        id: { in: ids },
        reportDate: todayDateString(),
        status: { in: ["SENT", "IN_PROGRESS", "PENDING"] },
      },
      select: { id: true },
      take: 2,
    });
    if (open.length !== 1) return;
    issueId = open[0].id;
  }

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
    await sendTelegramMessage(
      message.from.id,
      `Похоже, этот тикет решён — отметить?\n\n${issue.telegramLink ?? ""}`.trim(),
      [
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

  await prisma.issue.update({
    where: { id: issueId },
    data: {
      status: intent.status,
      ...(actorName && issue.createdBy === AUTO_ISSUE_CREATOR
        ? { createdBy: actorName }
        : {}),
    },
  });
  // source: "chat" — в группе агент уже всё сказал сам, повторять за ним
  // не нужно; ставим только реакцию на исходном сообщении.
  await reactToStatusChange(
    issue.status,
    intent.status,
    issue.telegramLink,
    "chat",
    issueId
  );
}

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
    select: { id: true, groupName: true, groupEmoji: true, telegramLink: true, extraLinks: true },
  });
  if (!issue) return false;

  const messageLink = buildMessageLink(message.chat.id, message.message_id);
  const alreadyLinked =
    messageLink === issue.telegramLink || issue.extraLinks.includes(messageLink);

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
        fromId: message.from?.id != null ? BigInt(message.from.id) : null,
        authorName: extractAuthorName(message.from),
        text: contextualText,
        messageLink,
        usedForIssueId: issue.id,
        archived: true,
        viewed: true,
      },
    }),
    prisma.issue.update({
      where: { id: issue.id },
      data: { extraLinks: alreadyLinked ? undefined : { push: messageLink } },
    }),
  ]);

  return true;
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

  // Написали повторно по тому, что считалось решённым, — человек пишет
  // второй раз именно потому, что ему не ответили, и молчание здесь и есть
  // сама проблема. Этот путь меняет статус в обход reactToStatusChange,
  // поэтому ответ отправляем явно, иначе самый ценный случай остался бы
  // единственным без ответа.
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

const HELP_TEXT = [
  "Команды доступны только в личке с ботом:",
  "",
  "/report [дата] — актуальный репорт (то же, что вечерняя сводка), можно в любое время дня",
  "/send [дата] — отправить репорт в рабочую группу (если уже отправляли за эту дату — просто скажет, когда)",
  "/dedupe [дата] — найти и разобрать похожие тикеты (ИИ-подсказка, объединение по одному)",
  "/review [дата] — начать разбор тикетов по одному",
  "/autoreply [on|off] — автоответы бота в рабочих группах; без аргумента покажет состояние",
  "/readchat [on|off] — бот читает твои реплики в группе и сам ставит статусы",
  "/broadcast <текст> — разослать объявление во все рабочие группы (спросит подтверждение)",
  "",
  "Без даты — за сегодня. Дата — в формате YYYY-MM-DD.",
].join("\n");

const AUTOREPLY_HELP = [
  "Когда включено, бот сам отвечает в рабочих группах:",
  "• на новое обращение — «жақсы, қарап береміз», и просит почту/ссылку, если их не прислали;",
  "• при смене статуса на сайте или в разборе — «жұмысқа алдық» / «әріптестеріме жібердім»;",
  "• если написали повторно по решённому — извиняется за задержку.",
  "",
  "Бот молчит там, где ты уже ответил сам, — и наоборот, твоя реплика в группе сама двигает статус.",
  "«Решено» в чат уходит только по твоей кнопке.",
  "",
  "Включить: /autoreply on · Выключить: /autoreply off",
].join("\n");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Слэш-команды в личке с ботом ("посмотреть репорт, не заходя на сайт" — в
// любой момент дня, а не только когда придёт вечерняя сводка). Работают
// только для известных агентов (AGENT_TELEGRAM_IDS) и только в приватном
// чате — не в группах поддержки, куда пишут клиенты: там ответ бота на
// команду был бы виден им, а данные внутренние.
async function handleBotCommand(chatId: number, fromId: number, text: string): Promise<void> {
  const actorName = telegramIdToAgent(fromId);
  if (!actorName) {
    await sendTelegramMessage(
      chatId,
      "Не узнал тебя — попроси добавить твой Telegram id в AGENT_TELEGRAM_IDS."
    );
    return;
  }

  const [rawCommand, dateArg] = text.trim().split(/\s+/);
  // "@BotName" в конце команды — Telegram сам дописывает его в группах,
  // где бот один из нескольких; в личке не встречается, но парсим на
  // всякий случай тем же кодом.
  const command = rawCommand.split("@")[0].toLowerCase();
  const reportDate = dateArg && DATE_RE.test(dateArg) ? dateArg : todayDateString();

  switch (command) {
    case "/start":
    case "/help": {
      await sendTelegramMessage(chatId, HELP_TEXT);
      return;
    }

    case "/report": {
      const summary = await buildReviewSummary(reportDate);
      if (!summary) {
        await sendTelegramMessage(chatId, `За ${reportDate} тикетов нет.`);
        return;
      }
      await sendTelegramMessage(chatId, summary.text, summary.keyboard);
      return;
    }

    case "/send": {
      const result = await sendReportToGroup(reportDate);
      if (!result.ok) {
        await sendTelegramMessage(chatId, describeSendFailure(result));
        return;
      }
      await sendTelegramMessage(chatId, "Отправлено в группу ✅");
      return;
    }

    case "/dedupe": {
      await startDedupeReview(chatId, reportDate);
      return;
    }

    case "/review": {
      await startReviewSession(chatId, reportDate);
      return;
    }

    case "/broadcast": {
      // Текст берём из исходного сообщения целиком, а не из разобранных
      // аргументов: объявление обычно многострочное, и склеивать его
      // обратно из токенов бессмысленно.
      const announcement = text.slice(rawCommand.length).trim();
      if (!announcement) {
        await sendTelegramMessage(
          chatId,
          "Напиши текст объявления после команды:\n/broadcast Қайырлы күн, ПФ да жөңдеу жұмыстары жүріп жатыр"
        );
        return;
      }

      const presets = await prisma.groupPreset.findMany({
        where: { chatId: { not: null } },
        orderBy: { order: "asc" },
      });
      if (presets.length === 0) {
        await sendTelegramMessage(chatId, "Нет ни одной группы с привязанным чатом.");
        return;
      }

      const draft = await prisma.broadcastDraft.create({ data: { text: announcement } });
      await sendTelegramMessage(
        chatId,
        `📢 Разослать в ${presets.length} групп?\n${presets.map((p) => `• ${p.name}`).join("\n")}\n\n${announcement}`,
        [
          [
            {
              text: `📤 Отправить в ${presets.length} групп`,
              callback_data: `${BROADCAST_SEND_PREFIX}${draft.id}`,
            },
          ],
          [
            {
              text: "Отмена",
              callback_data: `${BROADCAST_CANCEL_PREFIX}${draft.id}`,
            },
          ],
        ]
      );
      return;
    }

    case "/autoreply": {
      const arg = (dateArg ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        const [reply, intent] = await Promise.all([
          isAutoReplyEnabled(),
          isChatIntentEnabled(),
        ]);
        await sendTelegramMessage(
          chatId,
          [
            reply ? "🟢 Автоответы включены" : "⚪️ Автоответы выключены",
            intent ? "🟢 Чтение реплик включено" : "⚪️ Чтение реплик выключено",
            "",
            AUTOREPLY_HELP,
          ].join("\n")
        );
        return;
      }
      await setAutoReplyEnabled(arg === "on");
      await sendTelegramMessage(
        chatId,
        arg === "on"
          ? "🟢 Автоответы включены — бот начнёт отвечать в рабочих группах."
          : "⚪️ Автоответы выключены — бот больше ничего не пишет в группы."
      );
      return;
    }

    // Отдельно от /autoreply намеренно: там бот пишет коллегам, тут молча
    // меняет статусы, которые уйдут в репорт боссам. Риски разные, и
    // выключать одно, не трогая другое, надо уметь.
    case "/readchat": {
      const arg = (dateArg ?? "").toLowerCase();
      if (arg !== "on" && arg !== "off") {
        const enabled = await isChatIntentEnabled();
        await sendTelegramMessage(
          chatId,
          [
            enabled ? "🟢 Чтение реплик включено" : "⚪️ Чтение реплик выключено",
            "",
            "Когда включено, бот читает твои ответы в рабочих группах и сам ставит статусы:",
            "• «жақсы, тексеріп береміз» → В работе",
            "• «әріптестеріме жібердім» → Передано",
            "• «жөңделді» → спросит в личке и попросит заметку для репорта",
            "",
            "В группу при этом ничего не пишет — ты там уже всё сказал.",
            "",
            "Включить: /readchat on · Выключить: /readchat off",
          ].join("\n")
        );
        return;
      }
      await setChatIntentEnabled(arg === "on");
      await sendTelegramMessage(
        chatId,
        arg === "on"
          ? "🟢 Чтение реплик включено — статусы будут проставляться по твоим ответам в группах."
          : "⚪️ Чтение реплик выключено — статусы меняются только вручную."
      );
      return;
    }

    default:
      // Не наша команда (или просто сообщение начинается с "/" случайно) —
      // молча игнорируем, не шумим в личку в ответ на каждую опечатку.
      return;
  }
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
        await prisma.issue.update({
          where: { id: pending.issueId },
          data: {
            note: text.trim(),
            ...(pending.targetStatus ? { status: pending.targetStatus } : {}),
            ...(actorName && issue.createdBy === AUTO_ISSUE_CREATOR
              ? { createdBy: actorName }
              : {}),
          },
        });
        if (pending.targetStatus) {
          await reactToStatusChange(
            issue.status,
            pending.targetStatus,
            issue.telegramLink,
            "app",
            pending.issueId
          );
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
        messageLink,
        archived: true,
        viewed: true,
      },
    });
    // Реплика агента в группе — это и есть сигнал "взял в работу /
    // передал / сделал". Двигаем статус по ней, чтобы вечером не
    // проставлять заново то, что уже сделано днём.
    await applyAgentIntent(message, chatId, text);
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
        // Отвечаем на последнее сообщение серии, а не на первое: именно
        // в нём чаще всего и оказывается сама проблема (первое сплошь и
        // рядом — просто "Қайырлы күн").
        await sendAcknowledgement(issue.id, chatId, message.message_id, mergedOwn);
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
      await sendAcknowledgement(issue.id, chatId, message.message_id, text);
    }
  }

  return NextResponse.json({ ok: true });
}
