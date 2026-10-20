import { prisma } from "@/lib/prisma";
import {
  buildMessageLink,
  CAPTION_LIMIT,
  editMessageCaption,
  editMessageText,
  escapeHtml,
  sendStoredPhotos,
  sendTelegramMessage,
} from "@/lib/telegram";
import type { IssueStatus } from "@/lib/status";
import { STATUS_KK } from "@/lib/statusKk";
import { formatTimeAlmaty } from "@/lib/date";
import { isSubmissionToGroupEnabled } from "@/lib/settings";
import { ticketShortCode, ticketUrl } from "@/lib/miniapp";
import { suggestionBacklogTarget, SUGGESTION_SPREADSHEET_URL } from "@/lib/suggestionBacklog";
import { checkSuggestionSpreadsheet } from "@/lib/suggestionSheetCheck";
import {
  describeFields,
  displayValue,
  fieldVisible,
  type SubmissionLabel,
} from "@/lib/submissionLabels";

// Обращение из формы — в ту рабочую группу, которую куратор выбрал первым
// экраном.
//
// Зачем, если тикет и так заводится: до этого форма была тупиком для всех,
// кроме дежурного. Коллеги в группе не знали, что вопрос вообще задан, и
// спрашивали второй раз словами; у тикета не было сообщения в чате, поэтому
// ни ответить реплаем, ни сослаться на него было нельзя. Теперь обращение
// видно там же, где идёт вся остальная работа.
//
// Уходит полный текст с полями (почты, номера, ссылки) — это рабочая группа,
// где эти данные и нужны, а не репорт руководству: в репорт идёт только
// короткая суть из описания тикета.
//
// Отправка не обязана удасться: тикет уже создан, и обращение куратора
// пропасть не может. Любой отказ — строка в лог и null.
//
// Пока рубильник выключен, сообщение уходит не в рабочую группу, а в
// служебный канал (TELEGRAM_STORAGE_CHAT_ID) с пометкой «ТЕСТ» и названием
// той группы, куда оно ушло бы по-настоящему. Там сидим только мы, поэтому
// это единственное место, где можно посмотреть на живое сообщение — со
// ссылками, упоминанием и скринами — и не показать его коллегам. Без
// такой репетиции выбор был бы только «включить всем сразу» или «не
// увидеть вообще».
// Ссылки в сообщении группы — одним словом, а не полным адресом.
//
// Ссылка на урок у платформы — это сто двадцать символов с двумя uuid и
// параметрами; в чате она разворачивалась на шесть строк и отодвигала всё
// остальное за экран. Смысла в этих символах для читающего нет: нужен
// переход, а не текст адреса.
//
// Порядок важен: сначала адреса вынимаются в плейсхолдеры, и только потом
// текст режется по лимиту и экранируется. Иначе обрезка попадала бы в
// середину адреса, а экранирование превращало «&» в «&amp;» внутри самого
// href — Telegram отклонил бы такую разметку.
const URL_RE = /https?:\/\/\S+/g;
const LINK_LABEL = "🔗 сілтеме";

function extractLinks(text: string): { masked: string; urls: string[] } {
  const urls: string[] = [];
  const masked = text.replace(URL_RE, (url) => {
    urls.push(url);
    return `\u0000${urls.length - 1}\u0000`;
  });
  return { masked, urls };
}

// Плейсхолдер → ссылка (для чата) или само слово (для сохранённой копии).
// Обрезанный по лимиту «хвост» плейсхолдера убираем: висящий \u0000 в тексте
// не нужен никому.
function restoreLinks(masked: string, urls: string[], asHtml: boolean): string {
  return masked
    .replace(/\u0000(\d+)\u0000/g, (_, index) => {
      const url = urls[Number(index)];
      if (!url) return LINK_LABEL;
      return asHtml ? `<a href="${escapeHtml(url)}">${LINK_LABEL}</a>` : LINK_LABEL;
    })
    .replace(/\u0000\d*$/, "");
}

// Поле «что случилось»: если оно есть и отвечено, заголовок берётся из него —
// «[ЖЖ] Жұпты ауыстыру керек» говорит больше, чем «ЖЖ бойынша мәселе».
const KIND_FIELD_IDS = ["issueKind", "action"];

// Строка статуса внизу поста живая: бот переписывает её при каждой смене
// статуса (refreshSubmissionStatus), чтобы в группе было видно, что с
// обращением, без новых сообщений и без «ну что там?». Правка сообщения
// уведомлений не шлёт — правило «пишем только то, чего не прозвучало» не
// нарушается.
//
// Пост хранится шаблоном с этим местом под строку (BotReply.layout).
const STATUS_SLOT = "\u0001STATUS\u0001";
// Сколько места держим под строку статуса: у подписи к фото всего 1024
// символа, и тело режется с запасом под самую длинную строку — иначе
// правка упёрлась бы в лимит и Telegram отклонил бы её.
const STATUS_ROOM = 140;

// Слова — те же, что куратор видит в мини-аппе и в уведомлении в личку
// (STATUS_KK): одно состояние не должно называться по-разному.
export function submissionStatusLine(opts: {
  status: IssueStatus;
  note: string | null;
  escalatedTeam: string | null;
  actor: string | null;
  at: Date | null;
}): string {
  const kk = STATUS_KK[opts.status];
  const time = opts.at ? ` · ${formatTimeAlmaty(opts.at)}` : "";
  const who = opts.actor ? ` · ${opts.actor}` : "";
  let line: string;
  switch (opts.status) {
    case "SENT":
      line = `${kk.emoji} Өтініш тіркелді — кезекші қарайды`;
      break;
    case "ESCALATED":
      line = `${kk.emoji} ${kk.label}${opts.escalatedTeam ? `: ${opts.escalatedTeam}` : ""}${time}`;
      break;
    case "RESOLVED":
      // Заметка решения («Ерош шешті, Пошта ауыстырылды») говорит больше,
      // чем голое «Шешілді», — коллегам видно, чем кончилось.
      line = `${kk.emoji} ${opts.note?.trim() || `${kk.label}${who}`}${time}`;
      break;
    default:
      line = `${kk.emoji} ${kk.label}${who}${time}`;
  }
  return line.length > STATUS_ROOM ? `${line.slice(0, STATUS_ROOM - 1)}…` : line;
}

const INITIAL_STATUS = submissionStatusLine({
  status: "SENT",
  note: null,
  escalatedTeam: null,
  actor: null,
  at: null,
});

// Шаблон поста в BotReply.layout.
type PostLayout = { html: string; plain: string; caption: boolean };

// Сообщение об обращении — в том виде, в каком его удобно читать дежурному.
//
// Раньше это была стена «подпись: значение» строкой на поле, и суть (слова
// куратора) терялась среди служебных ответов. Теперь по образцу тикет-ботов:
//
//   Өтініш #4JQ9PW: [ЖЖ] Жұпты ауыстыру / алып тастау керек   ← ссылка на тикет
//
//   Курстан шыққан, бірақ жжға бөлініп кетіп тұр               ← слова куратора
//
//   Сабаққа сілтеме немесе ай-апта: 3-ай 2-апта                ← остальное коротко
//   Оқушының аты немесе поштасы: meirzhanulbosyn@gmail.com
//
//   Кураторы: Ерғанат Жұмақанов · 📨 Өтініш тіркелді — кезекші қарайды
//                                   ↑ строка статуса, меняется вместе со статусом
//
// «Өтініш #…» ведёт на сам тикет на сайте, а короткий номер ищется на доске.
// Чистая функция — проверяется без Telegram.
export function buildSubmissionPost(opts: {
  issueId: string;
  groupName: string;
  authorName: string;
  telegramUserId: bigint;
  label: SubmissionLabel;
  values: Record<string, string | string[]>;
  live: boolean;
  sourceMessageUrl?: string | null;
  // Only a confirmed matching spreadsheet row may supply this link.
  spreadsheetEntry?: { url: string };
  // Сколько видимых символов Telegram примет: 1024 у подписи к фото, 4096
  // у сообщения.
  limit: number;
}): { html: string; plain: string; layout: { html: string; plain: string } } {
  const { label, values } = opts;
  const suggestion = label.id === "suggestion";

  const kindField = label.fields.find(
    (f) => KIND_FIELD_IDS.includes(f.id) && fieldVisible(f, values)
  );
  const kindValue = kindField ? values[kindField.id] : undefined;
  // «Басқа» в заголовке ничего не говорит — тогда остаётся название ярлыка.
  const specific =
    kindField && typeof kindValue === "string" && kindValue && kindValue !== "other"
      ? displayValue(kindField, kindValue)
      : null;
  const title = specific ?? label.title;
  const tag = specific ? (label.tag ?? label.title) : null;

  const code = `${suggestion ? "💡 Ұсыныс" : "Өтініш"} #${ticketShortCode(opts.issueId)}`;
  const url = ticketUrl(opts.issueId);
  const testLine = opts.live ? null : `🧪 ТЕСТ · ${opts.groupName}`;

  const headPlain = suggestion ? code : `${code}: ${tag ? `[${tag}] ` : ""}${title}`;
  const headHtml =
    `${url ? `<a href="${escapeHtml(url)}">${code}</a>` : code}: ` +
    `${tag ? `[${escapeHtml(tag)}] ` : ""}<b>${escapeHtml(title)}</b>`;
  const suggestionHeadHtml = url ? `<a href="${escapeHtml(url)}">${code}</a>` : `<b>${code}</b>`;

  const footPlain = `Кураторы: ${opts.authorName} · ${STATUS_SLOT}`;
  const mention = `<a href="tg://user?id=${opts.telegramUserId}">${escapeHtml(opts.authorName)}</a>`;
  const footHtml = `<i>Кураторы: ${mention} · ${STATUS_SLOT}</i>`;

  // Тело: слова куратора абзацем, под ними остальные ответы. Служебные поля
  // (выбор «номер или почта») и уже вынесенные в заголовок — не повторяем.
  const description = typeof values.description === "string" ? values.description.trim() : "";
  const rest = describeFields(label, values)
    .filter((f) => !f.service && f.id !== "description" && f.id !== kindField?.id)
    .map((f) => `${f.label}: ${f.value}`);
  const body = [description, rest.join("\n")].filter(Boolean).join("\n\n");
  const sourcePlain = suggestion && opts.sourceMessageUrl ? `Хабарлама: ${opts.sourceMessageUrl}` : null;
  const sourceHtml = suggestion && opts.sourceMessageUrl
    ? `Хабарлама: <a href="${escapeHtml(opts.sourceMessageUrl)}">ашу</a>` : null;
  const sheetUrl = opts.spreadsheetEntry?.url ?? SUGGESTION_SPREADSHEET_URL;
  const sheetText = opts.spreadsheetEntry ? "📊 Кестеде бар" : "📊 Ұсыныстар кестесі";
  const sheetPlain = suggestion ? `${sheetText}: ${sheetUrl}` : null;
  const sheetHtml = suggestion ? `${sheetText}: <a href="${escapeHtml(sheetUrl)}">ашу</a>` : null;

  // Режем только тело и только до разметки (см. extractLinks). Слово-ссылка
  // длиннее своего плейсхолдера, поэтому видимую длину проверяем уже после
  // подстановки и при перелёте подрезаем ещё.
  const frame =
    [testLine, headPlain, sourcePlain, footPlain, sheetPlain].filter(Boolean).join("\n\n").length -
    STATUS_SLOT.length +
    STATUS_ROOM +
    8;
  const { masked, urls } = extractLinks(body);
  let room = Math.max(0, opts.limit - frame);
  let cut = masked.slice(0, room);
  while (room > 0 && restoreLinks(cut, urls, false).length > opts.limit - frame) {
    room -= restoreLinks(cut, urls, false).length - (opts.limit - frame);
    cut = masked.slice(0, Math.max(0, room));
  }

  const bodyPlain = restoreLinks(cut, urls, false).trim();
  const bodyHtml = restoreLinks(escapeHtml(cut), urls, true).trim();

  const htmlLayout = [testLine && escapeHtml(testLine), suggestion ? suggestionHeadHtml : headHtml, sourceHtml, bodyHtml, footHtml, sheetHtml]
    .filter(Boolean)
    .join("\n\n");
  const plainLayout = [testLine, headPlain, sourcePlain, bodyPlain, footPlain, sheetPlain].filter(Boolean).join("\n\n");
  return {
    html: htmlLayout.replace(STATUS_SLOT, escapeHtml(INITIAL_STATUS)),
    plain: plainLayout.replace(STATUS_SLOT, INITIAL_STATUS),
    layout: { html: htmlLayout, plain: plainLayout },
  };
}

type SubmissionPostInput = {
  issueId: string;
  groupName: string;
  authorName: string;
  telegramUserId: bigint;
  label: SubmissionLabel;
  values: Record<string, string | string[]>;
  photoFileIds: string[];
};

export async function postSubmissionToGroup(opts: SubmissionPostInput): Promise<string | null> {
  const backlog = suggestionBacklogTarget(opts.label.id);
  const live = backlog !== null || await isSubmissionToGroupEnabled();
  const preset = await prisma.groupPreset.findUnique({
    where: { name: opts.groupName }, select: { chatId: true },
  });
  if (live && !preset?.chatId) {
    console.warn(`[submission] «${opts.groupName}» не привязана к чату — обращение в группу не ушло`);
    return null;
  }
  const chatId = live ? preset!.chatId! : process.env.TELEGRAM_STORAGE_CHAT_ID?.trim();
  if (!chatId) return null;
  const sourceLink = await publishSubmission(opts, { chatId, live, kind: live ? "SUBMISSION" : "SUBMISSION_TEST" });
  if (backlog && sourceLink) {
    const sheetCheck = await checkSuggestionSpreadsheet({
      issueId: opts.issueId,
      description: typeof opts.values.description === "string" ? opts.values.description : "",
      sourceMessageUrl: sourceLink,
    });
    // Preserve the original support link even if the backlog copy fails.
    try {
      await publishSubmission(opts, {
        ...backlog, live: true, kind: "SUBMISSION_BACKLOG", sourceMessageUrl: sourceLink,
        spreadsheetEntry: sheetCheck.status === "found" ? { url: sheetCheck.url } : undefined,
      });
    } catch (error) {
      console.warn(`[submission] копия предложения не ушла в бэклог: ${error instanceof Error ? error.name : "ошибка"}`);
    }
    if (sheetCheck.status === "not-found") {
      await remindSuggestionAuthor(opts, chatId, sourceLink).catch((error) => {
        console.warn(`[submission] напоминание о таблице не отправилось: ${error instanceof Error ? error.name : "ошибка"}`);
      });
    } else if (sheetCheck.status === "unavailable" || sheetCheck.status === "uncertain") {
      console.warn(`[submission] проверка таблицы: ${sheetCheck.status}; напоминание не отправлено`);
    }
  }
  return sourceLink;
}

async function publishSubmission(opts: SubmissionPostInput, target: {
  chatId: string;
  threadId?: number;
  live: boolean;
  kind: "SUBMISSION" | "SUBMISSION_TEST" | "SUBMISSION_BACKLOG";
  sourceMessageUrl?: string;
  spreadsheetEntry?: { url: string };
}): Promise<string | null> {
  const { chatId, live, kind } = target;
  const existing = await prisma.botReply.findFirst({
    where: {
      issueId: opts.issueId, chatId, deleted: false,
      // The initial version stored direct-to-backlog posts as SUBMISSION.
      kind: kind === "SUBMISSION_BACKLOG" ? { in: ["SUBMISSION_BACKLOG", "SUBMISSION"] } : kind,
    },
    select: { messageId: true },
  });
  if (existing) return live ? buildMessageLink(Number(chatId), existing.messageId) : null;
  const withPhotos = opts.photoFileIds.length > 0;
  const { html, plain, layout } = buildSubmissionPost({
    ...opts, live, sourceMessageUrl: target.sourceMessageUrl, spreadsheetEntry: target.spreadsheetEntry,
    limit: withPhotos ? CAPTION_LIMIT : 4096,
  });
  const sent = withPhotos
    ? await sendStoredPhotos(chatId, opts.photoFileIds, html, "HTML", target.threadId)
    : await sendTelegramMessage(chatId, html, undefined, target.threadId, "HTML");
  if (!sent) {
    console.warn(`[submission] не отправилось: ${kind} (чат ${chatId})`);
    return null;
  }
  await prisma.botReply.create({
    data: {
      issueId: opts.issueId, chatId, messageId: sent.message_id, kind,
      text: plain.slice(0, CAPTION_LIMIT),
      layout: JSON.stringify({ ...layout, caption: withPhotos } satisfies PostLayout),
    },
  });
  return live ? buildMessageLink(Number(chatId), sent.message_id) : null;
}

export function buildSuggestionSheetReminder(authorName: string, telegramUserId: bigint): string {
  return `<a href="tg://user?id=${telegramUserId}">${escapeHtml(authorName)}</a>, ұсынысыңызды <a href="${escapeHtml(SUGGESTION_SPREADSHEET_URL)}">осы кестеге</a> енгізіп қойыңызшы 🙏`;
}

async function remindSuggestionAuthor(opts: SubmissionPostInput, chatId: string, sourceLink: string): Promise<void> {
  const kind = "SUGGESTION_TABLE_REMINDER";
  const existing = await prisma.botReply.findFirst({
    where: { issueId: opts.issueId, kind, deleted: false }, select: { id: true },
  });
  if (existing) return;
  const sourceMessageId = Number(sourceLink.match(/\/(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0) return;
  const text = buildSuggestionSheetReminder(opts.authorName, opts.telegramUserId);
  const sent = await sendTelegramMessage(chatId, text, undefined, undefined, "HTML", sourceMessageId, false);
  if (sent) await prisma.botReply.create({
    data: { issueId: opts.issueId, chatId, messageId: sent.message_id, kind, text },
  });
}

// Переписать строку статуса в посте обращения — зовётся из changeIssueStatus
// после каждой смены статуса. Ничего не должно ломать: пост могли удалить,
// Telegram мог отказать — строка в лог, статус тикета уже сохранён.
export async function refreshSubmissionStatus(
  issueId: string,
  actor: string | null
): Promise<void> {
  const posts = await prisma.botReply.findMany({
    where: {
      issueId,
      deleted: false,
      layout: { not: null },
      kind: { in: ["SUBMISSION", "SUBMISSION_TEST", "SUBMISSION_BACKLOG"] },
    },
    select: { id: true, chatId: true, messageId: true, text: true, layout: true },
  });
  if (posts.length === 0) return;

  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { status: true, note: true, escalatedTeam: true, statusChangedAt: true },
  });
  if (!issue) return;
  const line = submissionStatusLine({
    status: issue.status,
    note: issue.note,
    escalatedTeam: issue.escalatedTeam,
    actor,
    at: issue.statusChangedAt,
  });

  for (const post of posts) {
    let layout: PostLayout;
    try {
      layout = JSON.parse(post.layout!) as PostLayout;
    } catch {
      continue;
    }
    const plain = layout.plain.replace(STATUS_SLOT, line).slice(0, CAPTION_LIMIT);
    // Та же строка — править нечего (Telegram ответил бы «message is not
    // modified»).
    if (plain === post.text) continue;
    const html = layout.html.replace(STATUS_SLOT, escapeHtml(line));
    const edited = layout.caption
      ? await editMessageCaption(post.chatId, post.messageId, html, "HTML")
      : await editMessageText(post.chatId, post.messageId, html, null, "HTML");
    if (!edited) {
      console.warn(`[submission] строку статуса в посте ${post.chatId}/${post.messageId} обновить не вышло`);
      continue;
    }
    // text держим в синхроне с тем, что в чате: по нему срезается цитата
    // поста из ответов коллег (resolutionNote) и он показан на карточке.
    await prisma.botReply.update({ where: { id: post.id }, data: { text: plain } });
  }
}
