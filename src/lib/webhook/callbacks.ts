import { prisma } from "@/lib/prisma";
import { isIssueStatus, STATUS_META, type IssueStatus } from "@/lib/status";
import { ESCALATION_TEAMS, isEscalationTeam } from "@/lib/escalation";
import { changeIssueStatus } from "@/lib/issueStatus";
import { telegramIdToAgent } from "@/lib/agentTelegram";
import { SHARED_AGENT } from "@/lib/agents";
import {
  advanceReviewSession,
  startReviewSession,
  goBackReviewSession,
} from "@/lib/dailyReview";
import { startDedupeReview, advanceDedupeReview } from "@/lib/dedupeReview";
import { sendReportToGroup, describeSendFailure } from "@/lib/reportSend";
import { mergeIssueInto } from "@/lib/mergeIssue";
import { bestSolution } from "@/lib/solutionLibrary";
import { pickResolvedWord } from "@/lib/ai";
import { buildSharedAckText, buildResolvedText, pickLanguage } from "@/lib/autoReply";
import {
  sendBotReply,
  agentAlreadyReplied,
  deleteBotReply,
  describeBotReplyFailure,
} from "@/lib/botReply";
import { isAutoReplyEnabled } from "@/lib/settings";
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
  AGENT_TARGET_PREFIX,
  AUTO_REPLY_MERGE_PREFIX,
  AUTO_REPLY_PICK_PREFIX,
  CONFIRM_RESOLVED_PREFIX,
  RESOLVE_WITH_DRAFT_PREFIX,
  SOLVE_LIKE_PREFIX,
  BROADCAST_SEND_PREFIX,
  BROADCAST_CANCEL_PREFIX,
  BOT_REPLIES_PREFIX,
  BOT_REPLY_DELETE_PREFIX,
} from "@/lib/telegramCallbacks";
import {
  AUTO_ISSUE_CREATOR,
  answerCallbackQuery,
  editMessageReplyMarkup,
  editMessageText,
  ownAgentTelegramIdList,
  sendTelegramMessage,
  type TelegramCallbackQuery,
} from "@/lib/telegram";

// Метка, по которой заметка вытаскивается обратно из текста сообщения при
// нажатии кнопки. Держать её здесь, а не собирать строку дважды: разъедутся
// — и тикет закроется не тем текстом, который человек видел. Живёт в этом
// модуле рядом с парсером (RESOLVE_WITH_DRAFT_PREFIX ниже); черновик,
// который её вставляет (buildResolvedNoteDraft в webhook/route), импортирует
// её отсюда — так у метки один источник.
export const RESOLVED_NOTE_LABEL = "Заметка для репорта:";

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
// "Жөнделді"/"Өзгертілді". Слово выбирает ИИ по сути тикета, язык — по
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
export async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
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
    // "app": кнопку нажали в разборе, в рабочем чате об этом ещё не
    // знают — значит бот там отвечает (если автоответы включены).
    await changeIssueStatus({
      issueId,
      status,
      actor: telegramIdToAgent(query.from.id),
      source: "app",
    });
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

    await changeIssueStatus({
      issueId,
      status: "ESCALATED",
      escalatedTeam: team,
      actor: telegramIdToAgent(query.from.id),
      source: "app",
    });
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

  // "Это то же самое" — склеиваем черновик с уже открытым тикетом и
  // отвечаем всем одним сообщением вместо трёх одинаковых.
  if (data.startsWith(AUTO_REPLY_MERGE_PREFIX)) {
    if (!query.message) return;
    const targetIssueId = data.slice(AUTO_REPLY_MERGE_PREFIX.length);
    const draft = await prisma.pendingAutoReply.findUnique({
      where: {
        chatId_messageId: {
          chatId: String(query.message.chat.id),
          messageId: query.message.message_id,
        },
      },
    });
    if (!draft) {
      await answerCallbackQuery(query.id, "Черновик уже не актуален", true);
      return;
    }

    const actorName = telegramIdToAgent(query.from.id);
    // Ссылки съезжаются в один тикет, сообщения перецепляются туда же,
    // лишний тикет исчезает — та же операция, что "объединить" на сайте.
    const merged = await mergeIssueInto(
      draft.issueId,
      targetIssueId,
      actorName ?? AUTO_ISSUE_CREATOR
    );
    // Черновик удаляем после склейки: он ссылается на исчезнувший тикет
    // (каскадом он бы удалился и сам, но полагаться на это здесь незачем).
    await prisma.pendingAutoReply
      .delete({ where: { id: draft.id } })
      .catch(() => {});
    if (!merged) {
      await answerCallbackQuery(query.id, "Не нашёл тикет для объединения", true);
      return;
    }

    const text = buildSharedAckText(draft.variants[0] ?? "");
    await sendBotReply({
      issueId: merged.id,
      chatId: draft.targetChatId,
      // Отвечаем на последнее сообщение: его писали последним, и ответ
      // увидят все, кто присоединился к жалобе.
      replyToMessageId: draft.targetMessageId,
      kind: "ACK",
      text,
    });
    await answerCallbackQuery(query.id, "🔗 Объединено, ответил разом");
    await editMessageText(
      query.message.chat.id,
      query.message.message_id,
      `${query.message.text ?? ""}\n\n🔗 Объединено с прошлым обращением. Отправлено: ${text}`
    );
    return;
  }

  // Выбор варианта автоответа (или отказ отвечать). Какой это черновик —
  // определяет само сообщение с кнопками, поэтому в callback_data лежит
  // только выбор.
  if (data.startsWith(AUTO_REPLY_PICK_PREFIX)) {
    if (!query.message) return;
    const choice = data.slice(AUTO_REPLY_PICK_PREFIX.length);
    const draft = await prisma.pendingAutoReply.findUnique({
      where: {
        chatId_messageId: {
          chatId: String(query.message.chat.id),
          messageId: query.message.message_id,
        },
      },
    });
    if (!draft) {
      await answerCallbackQuery(query.id, "Черновик уже не актуален", true);
      return;
    }
    await prisma.pendingAutoReply.delete({ where: { id: draft.id } });

    const shown = query.message.text ?? "";
    if (choice === "x") {
      await answerCallbackQuery(query.id, "Не отвечаем");
      await editMessageText(
        query.message.chat.id,
        query.message.message_id,
        `${shown}\n\n🚫 Не отправлено`
      );
      return;
    }

    const text = draft.variants[Number(choice)];
    if (!text) {
      await answerCallbackQuery(query.id, "Такого варианта нет", true);
      return;
    }

    // Пока черновик ждал ответа, агент мог ответить в группе сам — тогда
    // отправлять уже нечего: правило "бот пишет только то, чего там ещё не
    // прозвучало" действует и здесь.
    if (
      await agentAlreadyReplied(
        draft.targetChatId,
        draft.targetMessageId,
        ownAgentTelegramIdList()
      )
    ) {
      await answerCallbackQuery(query.id, "В группе уже ответили — не отправляю", true);
      await editMessageText(
        query.message.chat.id,
        query.message.message_id,
        `${shown}\n\n🤐 Не отправлено: в группе уже ответил живой человек`
      );
      return;
    }

    await sendBotReply({
      issueId: draft.issueId,
      chatId: draft.targetChatId,
      replyToMessageId: draft.targetMessageId,
      kind: "ACK",
      text,
    });
    await answerCallbackQuery(query.id, "📨 Отправлено");
    await editMessageText(
      query.message.chat.id,
      query.message.message_id,
      `${shown}\n\n📨 Отправлено: ${text}`
    );
    return;
  }

  // "Решено, с этой заметкой" — закрытие в одно нажатие. Текст берём из
  // самого сообщения, а не пересчитываем моделью заново: человек нажимает
  // кнопку, глядя на конкретную формулировку, и закрыть тикет чем-то
  // другим — значит подменить то, с чем он согласился (а на повторный
  // вызов Groq может ещё и ответить иначе или упереться в квоту).
  if (data.startsWith(RESOLVE_WITH_DRAFT_PREFIX)) {
    const issueId = data.slice(RESOLVE_WITH_DRAFT_PREFIX.length);
    const shown = query.message?.text ?? "";
    const note = shown.split(RESOLVED_NOTE_LABEL)[1]?.trim().replace(/^«|»$/g, "");
    if (!note) {
      await answerCallbackQuery(query.id, "Не нашёл заметку — напиши свою", true);
      return;
    }

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { status: true },
    });
    if (!issue) {
      await answerCallbackQuery(query.id, "Тикет не найден", true);
      return;
    }

    await changeIssueStatus({
      issueId,
      status: "RESOLVED",
      note,
      actor: query.from?.id != null ? telegramIdToAgent(query.from.id) : null,
      // "chat": слово о готовности агент уже сказал в группе сам, бот там
      // повторять не должен — это и есть догадка, из которой выросло всё
      // это подтверждение.
      source: "chat",
    });
    await answerCallbackQuery(query.id, "✅ Решено");
    // Кнопки убираем: тикет закрыт, второе нажатие уже ничего не значит.
    if (query.message) {
      await editMessageText(
        query.message.chat.id,
        query.message.message_id,
        `${shown}\n\n✅ Отмечено решённым`
      );
    }
    return;
  }

  // Агент выбрал, к какому тикету относилась его реплика в группе (бот не
  // смог понять сам — см. resolveAgentTarget). Дальше всё как обычно:
  // "решено" идёт через запрос заметки, остальные статусы ставятся сразу.
  if (data.startsWith(AGENT_TARGET_PREFIX)) {
    const rest = data.slice(AGENT_TARGET_PREFIX.length);
    const separator = rest.indexOf(":");
    const status = rest.slice(0, separator);
    const issueId = rest.slice(separator + 1);
    if (!isIssueStatus(status)) {
      await answerCallbackQuery(query.id, "Не понял статус", true);
      return;
    }

    // Чиним нить разговора: реплика, из-за которой был задан вопрос,
    // осталась без тикета, и следующая ("өшірілді" после "Окей, қазір")
    // снова оказалась бы ни к чему не привязана.
    if (query.from?.id != null) {
      const recent = await prisma.telegramMessage.findFirst({
        where: {
          fromId: BigInt(query.from.id),
          agentIssueId: null,
          receivedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
        select: { id: true },
        orderBy: { receivedAt: "desc" },
      });
      if (recent) {
        await prisma.telegramMessage.update({
          where: { id: recent.id },
          data: { agentIssueId: issueId },
        });
      }
    }

    if (status === "RESOLVED") {
      await sendNotePrompt(
        query,
        issueId,
        "✅ Что именно сделали? Ответь на ЭТО сообщение — заметка уйдёт в репорт. Тикет:",
        "RESOLVED",
        false
      );
      return;
    }

    await changeIssueStatus({
      issueId,
      status,
      actor: query.from?.id != null ? telegramIdToAgent(query.from.id) : null,
      // Статус двигает реплика, уже прозвучавшая в группе.
      source: "chat",
    });
    await answerCallbackQuery(
      query.id,
      `${STATUS_META[status].emoji} ${STATUS_META[status].label}`
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
    await changeIssueStatus({
      issueId,
      status: "RESOLVED",
      note: suggestion.note,
      actor: actorName,
      source: "app",
    });
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
