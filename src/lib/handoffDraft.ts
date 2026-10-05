import { prisma } from "@/lib/prisma";
import { isHandoffEnabled } from "@/lib/settings";
import { devChatId, teamMembers, topicForTeam } from "@/lib/devTeams";
import { isEscalationTeam } from "@/lib/escalation";
import { writeHandoffBrief } from "@/lib/ai";
import { maskSensitiveForAi } from "@/lib/textClean";
import { extractTicketHints } from "@/lib/ticketHints";
import { pickRecipient } from "@/lib/dailyReview";
import { todayDateString } from "@/lib/date";
import { parseMessageLink } from "@/lib/botMessageDelete";
import {
  answerCallbackQuery,
  buildMessageLink,
  editMessageText,
  escapeHtml,
  sendTelegramMessage,
  type InlineKeyboard,
  type TelegramCallbackQuery,
} from "@/lib/telegram";
import { HANDOFF_PREFIX } from "@/lib/telegramCallbacks";
import { extractSupportLinks, isStatusDigest, resolveSupportLink } from "@/lib/devHandoff";

// Передача разработчикам, когда агент сам не написал в их чате.
//
// Агент нажал «Передать → Backend → Даука» (сайт или разбор в Telegram), а в
// чате разработчиков по этому тикету тишина — бот готовит сообщение так, как
// его пишут руками: отметка человека, ссылка на сообщение куратора, пара
// предложений от ИИ. Черновик уходит агенту в личку; в топик команды — только
// после «Отправить». Как и с автоответами, худшее, что может случиться при
// включённом рубильнике, — неотправленный черновик.
//
// Агент передал сам (lib/devHandoff.ts нашёл его сообщение) — черновик
// снимается, бот не повторяет то, что уже прозвучало.

// Сколько ссылок предлагать на выбор: сообщение со скриншотом, первое
// сообщение, пост формы. Больше — уже не выбор, а список.
const MAX_LINK_OPTIONS = 3;
// Соседи по серии сообщений куратора, ещё не привязанные к тикету (скрин
// пришёл раньше, чем тикет завёлся) — в пределах стольких минут и стольких
// сообщений чата от сообщений самого тикета. Оба ограничения нужны: за
// 10 минут тот же куратор мог написать и о другой проблеме.
const SERIES_WINDOW_MS = 10 * 60 * 1000;
const SERIES_SPAN = 15;
// Сколько текста куратора отдаём модели: суть всегда в начале, а лимит Groq
// по токенам в минуту общий на все функции.
const CURATOR_TEXT_LIMIT = 1500;

export type HandoffStart =
  | "disabled"
  | "not-escalated"
  | "no-topic"
  | "already"
  | "no-recipient"
  | "failed"
  | "sent";

type Draft = {
  team: string;
  assigneeName: string | null;
  body: string;
  link: string | null;
  linkOptions: string[];
  ticketLink: string | null;
};

// Передачу в чате разработчиков, сохранённую до того, как бот начал
// распознавать её на лету (или пропущенную по гонке), — ищем по тексту.
async function findManualHandoff(issueId: string, since: Date): Promise<string | null> {
  const devChat = devChatId();
  if (!devChat) return null;
  const rows = await prisma.telegramMessage.findMany({
    where: { chatId: devChat, receivedAt: { gte: since }, text: { contains: "t.me/c/" } },
    orderBy: { receivedAt: "asc" },
    select: { text: true, messageLink: true, messageId: true, threadId: true },
  });
  for (const row of rows) {
    const text = row.text ?? "";
    const links = extractSupportLinks(text);
    if (links.length === 0 || isStatusDigest(text, links)) continue;
    for (const link of links) {
      if ((await resolveSupportLink(link)) === issueId) {
        return row.threadId
          ? row.messageLink.replace(/\/(\d+)$/, `/${row.threadId}/$1`)
          : row.messageLink;
      }
    }
  }
  return null;
}

type SeriesRow = {
  chatId: string;
  messageId: number;
  fromId: bigint | null;
  receivedAt: Date;
  hasMedia: boolean;
  messageLink: string;
  text: string | null;
};

// Сообщения куратора по тикету: привязанные и их непривязанные соседи того
// же автора. Типичная серия — «Сәлеметсіз бе» → скриншот с сутью и почтой
// ученика → «тапсырмалар ашылмайды». Тикет заводится по первому, а суть,
// скрин и почта часто лежат в непривязанных: пришли раньше, чем тикет
// завёлся. Без них разработчику уходило бы одно приветствие.
async function seriesRows(issueId: string): Promise<SeriesRow[]> {
  const select = {
    chatId: true,
    messageId: true,
    fromId: true,
    receivedAt: true,
    hasMedia: true,
    messageLink: true,
    text: true,
  } as const;
  const linked = await prisma.telegramMessage.findMany({
    where: { usedForIssueId: issueId },
    orderBy: { messageId: "asc" },
    select,
  });
  const rows = new Map(linked.map((r) => [`${r.chatId}:${r.messageId}`, r]));
  for (const r of linked) {
    if (!r.fromId) continue;
    const near = await prisma.telegramMessage.findMany({
      where: {
        chatId: r.chatId,
        fromId: r.fromId,
        usedForIssueId: null,
        messageId: { gte: r.messageId - SERIES_SPAN, lte: r.messageId + SERIES_SPAN },
        receivedAt: {
          gte: new Date(r.receivedAt.getTime() - SERIES_WINDOW_MS),
          lte: new Date(r.receivedAt.getTime() + SERIES_WINDOW_MS),
        },
      },
      select,
    });
    for (const n of near) rows.set(`${n.chatId}:${n.messageId}`, n);
  }
  return [...rows.values()].sort((a, b) => a.messageId - b.messageId);
}

// Какие ссылки предложить разработчику — по порядку полезности.
function linkOptionsFor(
  issue: { id: string; telegramLink: string | null },
  series: SeriesRow[],
  postLink: string | null
): string[] {
  const media = series.filter((s) => s.hasMedia).map((s) => s.messageLink);
  const all = [...media, issue.telegramLink, series[0]?.messageLink, postLink].filter(
    (l): l is string => Boolean(l)
  );
  return Array.from(new Set(all)).slice(0, MAX_LINK_OPTIONS);
}

async function submissionPostLink(issueId: string): Promise<string | null> {
  const post = await prisma.botReply.findFirst({
    where: { issueId, deleted: false, kind: "SUBMISSION" },
    orderBy: { sentAt: "asc" },
    select: { chatId: true, messageId: true },
  });
  return post ? buildMessageLink(Number(post.chatId), post.messageId) : null;
}

// Подпись варианта ссылки — чтобы выбирать, не открывая каждую.
async function linkLabels(options: string[]): Promise<string[]> {
  return Promise.all(
    options.map(async (link) => {
      const target = parseMessageLink(link);
      if (!target) return "своя ссылка";
      const [row, post] = await Promise.all([
        prisma.telegramMessage.findUnique({
          where: { chatId_messageId: target },
          select: { hasMedia: true },
        }),
        prisma.botReply.findFirst({
          where: { chatId: target.chatId, messageId: target.messageId, kind: "SUBMISSION" },
          select: { id: true },
        }),
      ]);
      if (post) return "пост формы";
      if (row?.hasMedia) return "со скриншотом";
      if (row) return "сообщение куратора";
      return "своя ссылка";
    })
  );
}

// То, что уйдёт в топик. HTML — ради отметки по Telegram-id: так человек
// получает уведомление, даже если у него нет @username.
export function handoffPostHtml(draft: Draft, assigneeTgId: number | null): string {
  const mention =
    draft.assigneeName && assigneeTgId
      ? `<a href="tg://user?id=${assigneeTgId}">${escapeHtml(draft.assigneeName)}</a> `
      : "";
  const lines = [`${mention}${draft.link ? escapeHtml(draft.link) : ""}`.trim(), "", escapeHtml(draft.body)];
  if (draft.ticketLink) lines.push(`Jira: ${escapeHtml(draft.ticketLink)}`);
  return lines.join("\n").trim();
}

function handoffPostPlain(draft: Draft): string {
  const head = [draft.assigneeName, draft.link].filter(Boolean).join(" ");
  const lines = [head, "", draft.body];
  if (draft.ticketLink) lines.push(`Jira: ${draft.ticketLink}`);
  return lines.join("\n").trim();
}

async function previewText(draft: Draft): Promise<string> {
  const who = draft.assigneeName ? ` → ${draft.assigneeName}` : "";
  const labels = await linkLabels(draft.linkOptions);
  const options = draft.linkOptions
    .map((l, i) => `${i + 1}) ${labels[i]}${l === draft.link ? " ✓" : ""}`)
    .join("   ");
  return [
    `🛠 Передать в чат разработчиков: ${draft.team}${who}?`,
    "",
    handoffPostPlain(draft),
    "",
    options ? `Ссылка: ${options}` : "Ссылки на сообщение куратора нет.",
    "Поправить текст — ответь реплаем; другую ссылку — пришли её реплаем.",
  ].join("\n");
}

function previewKeyboard(draft: Draft): InlineKeyboard {
  const linkButtons = draft.linkOptions.map((l, i) => ({
    text: `${l === draft.link ? "✓ " : ""}🔗 ${i + 1}`,
    callback_data: `${HANDOFF_PREFIX}l${i}`,
  }));
  return [
    [{ text: "✅ Отправить", callback_data: `${HANDOFF_PREFIX}s` }],
    ...(linkButtons.length > 1 ? [linkButtons] : []),
    [{ text: "🚫 Не отправлять", callback_data: `${HANDOFF_PREFIX}x` }],
  ];
}

type Submission = { rawText: string; studentContact: string } | null;

// Текст куратора для модели: серия сообщений и заявка из формы, без почт и
// телефонов (модель внешняя).
function curatorTextFor(series: SeriesRow[], submission: Submission): string {
  const texts = [submission?.rawText, ...series.map((m) => m.text)].filter(
    (t): t is string => Boolean(t)
  );
  return maskSensitiveForAi(texts.join("\n")).slice(0, CURATOR_TEXT_LIMIT);
}

// Почта и телефон ученика — разработчику по ним искать, модели их не даём,
// поэтому дописываем сами после текста ИИ.
function contactLines(series: SeriesRow[], submission: Submission): string[] {
  const hints = extractTicketHints([
    ...series.map((m) => m.text),
    submission?.rawText ?? null,
    submission?.studentContact ?? null,
  ]);
  return [...hints.emails, ...hints.phones];
}

export async function startHandoff(
  issueId: string,
  recipientChatId: number | null
): Promise<HandoffStart> {
  if (!(await isHandoffEnabled())) return "disabled";
  const devChat = devChatId();
  if (!devChat) return "disabled";

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      id: true,
      status: true,
      escalatedTeam: true,
      escalatedAssignee: true,
      handoffLink: true,
      description: true,
      telegramLink: true,
      ticketLink: true,
      createdAt: true,
    },
  });
  if (!issue || issue.status !== "ESCALATED" || !isEscalationTeam(issue.escalatedTeam)) {
    return "not-escalated";
  }
  if (issue.handoffLink) return "already";
  const manual = await findManualHandoff(issue.id, issue.createdAt);
  if (manual) {
    await prisma.issue.update({
      where: { id: issue.id },
      data: { handoffLink: manual, handoffAt: new Date() },
    });
    return "already";
  }
  if (!topicForTeam(issue.escalatedTeam)) return "no-topic";

  const recipient = recipientChatId ?? (await pickRecipient(todayDateString()));
  if (recipient == null) return "no-recipient";

  const assignee = issue.escalatedAssignee
    ? teamMembers(issue.escalatedTeam).find((m) => m.name === issue.escalatedAssignee) ?? null
    : null;
  const [series, submission, postLink] = await Promise.all([
    seriesRows(issue.id),
    prisma.issueSubmission.findFirst({
      where: { issueId: issue.id },
      orderBy: { createdAt: "asc" },
      select: { rawText: true, studentContact: true },
    }),
    submissionPostLink(issue.id),
  ]);
  const linkOptions = linkOptionsFor(issue, series, postLink);
  const brief =
    (await writeHandoffBrief({
      description: issue.description,
      curatorText: curatorTextFor(series, submission),
      team: issue.escalatedTeam,
    })) ?? issue.description;
  const contacts = contactLines(series, submission);
  const draft: Draft = {
    team: issue.escalatedTeam,
    assigneeName: assignee?.name ?? issue.escalatedAssignee ?? null,
    body: [brief, ...contacts].join("\n"),
    link: linkOptions[0] ?? null,
    linkOptions,
    ticketLink: issue.ticketLink,
  };

  // Прежний черновик по этому тикету (передали заново — другому человеку)
  // больше не актуален: убираем его кнопки, чтобы не отправить старое.
  const previous = await prisma.pendingHandoff.findUnique({ where: { issueId: issue.id } });
  if (previous) {
    await prisma.pendingHandoff.delete({ where: { id: previous.id } });
    await editMessageText(previous.chatId, previous.messageId, "↪️ Черновик заменён новым — ниже.", null);
  }

  const sent = await sendTelegramMessage(
    recipient,
    await previewText(draft),
    previewKeyboard(draft)
  );
  if (!sent) return "failed";

  await prisma.pendingHandoff.create({
    data: {
      chatId: String(recipient),
      messageId: sent.message_id,
      issueId: issue.id,
      team: draft.team,
      assigneeName: draft.assigneeName,
      assigneeTgId: assignee ? BigInt(assignee.telegramId) : null,
      body: draft.body,
      link: draft.link,
      linkOptions: draft.linkOptions,
    },
  });
  return "sent";
}

type PendingRow = NonNullable<Awaited<ReturnType<typeof prisma.pendingHandoff.findUnique>>>;

async function draftFromRow(row: PendingRow): Promise<Draft> {
  const issue = await prisma.issue.findUnique({
    where: { id: row.issueId },
    select: { ticketLink: true },
  });
  return {
    team: row.team,
    assigneeName: row.assigneeName,
    body: row.body,
    link: row.link,
    linkOptions: row.linkOptions,
    ticketLink: issue?.ticketLink ?? null,
  };
}

async function refreshPreview(row: PendingRow): Promise<void> {
  const draft = await draftFromRow(row);
  await editMessageText(
    row.chatId,
    row.messageId,
    await previewText(draft),
    previewKeyboard(draft)
  );
}

function devPostLink(chatId: string, topicId: number, messageId: number): string {
  return buildMessageLink(Number(chatId), messageId).replace(/\/(\d+)$/, `/${topicId}/$1`);
}

export async function handleHandoffCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith(HANDOFF_PREFIX) || !query.message) return false;
  const action = data.slice(HANDOFF_PREFIX.length);
  const where = {
    chatId_messageId: { chatId: String(query.message.chat.id), messageId: query.message.message_id },
  };
  const row = await prisma.pendingHandoff.findUnique({ where });
  if (!row) {
    await answerCallbackQuery(query.id, "Черновик уже не актуален", true);
    return true;
  }

  if (action.startsWith("l")) {
    const link = row.linkOptions[Number(action.slice(1))];
    if (!link) {
      await answerCallbackQuery(query.id, "Нет такой ссылки");
      return true;
    }
    const updated = await prisma.pendingHandoff.update({ where: { id: row.id }, data: { link } });
    await answerCallbackQuery(query.id, "Ссылка выбрана");
    await refreshPreview(updated);
    return true;
  }

  // Дальше черновик используется один раз: удаляем сразу — второе нажатие
  // (двойной тап, медленный интернет) найдёт пустоту, а не отправит дважды.
  await prisma.pendingHandoff.delete({ where: { id: row.id } });
  const draft = await draftFromRow(row);
  const shown = handoffPostPlain(draft);

  if (action === "x") {
    await answerCallbackQuery(query.id, "Не отправляем");
    await editMessageText(row.chatId, row.messageId, `${shown}\n\n🚫 Не отправлено`, null);
    return true;
  }
  if (action !== "s") {
    await answerCallbackQuery(query.id, "Неизвестное действие");
    return true;
  }

  const issue = await prisma.issue.findUnique({
    where: { id: row.issueId },
    select: { handoffLink: true, createdAt: true, escalatedTeam: true },
  });
  if (!issue) {
    await answerCallbackQuery(query.id, "Тикет удалён", true);
    return true;
  }
  // Пока черновик ждал, агент мог передать сам — тогда молчим.
  const manual = issue.handoffLink ?? (await findManualHandoff(row.issueId, issue.createdAt));
  if (manual) {
    await answerCallbackQuery(query.id, "Уже передано");
    await editMessageText(row.chatId, row.messageId, `${shown}\n\n✅ Уже передано вручную: ${manual}`, null);
    return true;
  }

  const devChat = devChatId();
  const topic = isEscalationTeam(row.team) ? topicForTeam(row.team) : null;
  if (!devChat || !topic) {
    await answerCallbackQuery(query.id, "Не настроен чат или топик команды", true);
    return true;
  }
  const html = handoffPostHtml(draft, row.assigneeTgId != null ? Number(row.assigneeTgId) : null);
  const posted = await sendTelegramMessage(devChat, html, undefined, topic, "HTML");
  if (!posted) {
    // Не ушло — возвращаем черновик, чтобы можно было нажать ещё раз.
    await prisma.pendingHandoff.create({
      data: {
        chatId: row.chatId,
        messageId: row.messageId,
        issueId: row.issueId,
        team: row.team,
        assigneeName: row.assigneeName,
        assigneeTgId: row.assigneeTgId,
        body: row.body,
        link: row.link,
        linkOptions: row.linkOptions,
      },
    });
    await answerCallbackQuery(query.id, "Telegram не принял сообщение — попробуй ещё раз", true);
    return true;
  }

  const postLink = devPostLink(devChat, topic, posted.message_id);
  await prisma.botReply.create({
    data: {
      issueId: row.issueId,
      chatId: devChat,
      messageId: posted.message_id,
      kind: "HANDOFF",
      text: shown,
    },
  });
  await prisma.issue.update({
    where: { id: row.issueId },
    data: { handoffLink: postLink, handoffAt: new Date() },
  });
  await answerCallbackQuery(query.id, "Отправлено");
  await editMessageText(row.chatId, row.messageId, `${shown}\n\n📨 Отправлено: ${postLink}`, null);
  return true;
}

// Реплай на черновик в личке: ссылка — заменить ссылку, текст — заменить
// текст. true — это был ответ на черновик, дальше сообщение не разбираем.
export async function applyHandoffReply(
  chatId: string,
  repliedToId: number,
  text: string
): Promise<boolean> {
  const row = await prisma.pendingHandoff.findUnique({
    where: { chatId_messageId: { chatId, messageId: repliedToId } },
  });
  if (!row) return false;
  const own = text.trim();
  if (!own) return true;
  const asLink = parseMessageLink(own) ? own.replace(/[?#].*$/, "").replace(/\/+$/, "") : null;
  const updated = await prisma.pendingHandoff.update({
    where: { id: row.id },
    data: asLink
      ? {
          link: asLink,
          linkOptions: row.linkOptions.includes(asLink) ? row.linkOptions : [...row.linkOptions, asLink],
        }
      : { body: own },
  });
  await refreshPreview(updated);
  return true;
}
