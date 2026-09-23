import { prisma } from "@/lib/prisma";
import {
  buildMessageLink,
  CAPTION_LIMIT,
  escapeHtml,
  sendStoredPhotos,
  sendTelegramMessage,
} from "@/lib/telegram";
import { isSubmissionToGroupEnabled } from "@/lib/settings";
import { ticketShortCode, ticketUrl } from "@/lib/miniapp";
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
const STATUS_LINE = "Өтініш тіркелді — кезекші қарайды";

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
//   Кураторы: Ерғанат Жұмақанов · Өтініш тіркелді — кезекші қарайды
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
  // Сколько видимых символов Telegram примет: 1024 у подписи к фото, 4096
  // у сообщения.
  limit: number;
}): { html: string; plain: string } {
  const { label, values } = opts;

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

  const code = `Өтініш #${ticketShortCode(opts.issueId)}`;
  const url = ticketUrl(opts.issueId);
  const testLine = opts.live ? null : `🧪 ТЕСТ · ${opts.groupName}`;

  const headPlain = `${code}: ${tag ? `[${tag}] ` : ""}${title}`;
  const headHtml =
    `${url ? `<a href="${escapeHtml(url)}">${code}</a>` : code}: ` +
    `${tag ? `[${escapeHtml(tag)}] ` : ""}<b>${escapeHtml(title)}</b>`;

  const footPlain = `Кураторы: ${opts.authorName} · ${STATUS_LINE}`;
  const mention = `<a href="tg://user?id=${opts.telegramUserId}">${escapeHtml(opts.authorName)}</a>`;
  const footHtml = `<i>Кураторы: ${mention} · ${STATUS_LINE}</i>`;

  // Тело: слова куратора абзацем, под ними остальные ответы. Служебные поля
  // (выбор «номер или почта») и уже вынесенные в заголовок — не повторяем.
  const description = typeof values.description === "string" ? values.description.trim() : "";
  const rest = describeFields(label, values)
    .filter((f) => !f.service && f.id !== "description" && f.id !== kindField?.id)
    .map((f) => `${f.label}: ${f.value}`);
  const body = [description, rest.join("\n")].filter(Boolean).join("\n\n");

  // Режем только тело и только до разметки (см. extractLinks). Слово-ссылка
  // длиннее своего плейсхолдера, поэтому видимую длину проверяем уже после
  // подстановки и при перелёте подрезаем ещё.
  const frame = [testLine, headPlain, footPlain].filter(Boolean).join("\n\n").length + 8;
  const { masked, urls } = extractLinks(body);
  let room = Math.max(0, opts.limit - frame);
  let cut = masked.slice(0, room);
  while (room > 0 && restoreLinks(cut, urls, false).length > opts.limit - frame) {
    room -= restoreLinks(cut, urls, false).length - (opts.limit - frame);
    cut = masked.slice(0, Math.max(0, room));
  }

  const bodyPlain = restoreLinks(cut, urls, false).trim();
  const bodyHtml = restoreLinks(escapeHtml(cut), urls, true).trim();

  const html = [testLine && escapeHtml(testLine), headHtml, bodyHtml, footHtml]
    .filter(Boolean)
    .join("\n\n");
  const plain = [testLine, headPlain, bodyPlain, footPlain].filter(Boolean).join("\n\n");
  return { html, plain };
}

export async function postSubmissionToGroup(opts: {
  issueId: string;
  groupName: string;
  authorName: string;
  // Telegram-id автора: по нему имя в шапке становится упоминанием, и
  // куратор получает уведомление, что его заявку видно в группе. Через
  // tg://user, а не @username — юзернейма у половины кураторов нет.
  telegramUserId: bigint;
  label: SubmissionLabel;
  values: Record<string, string | string[]>;
  photoFileIds: string[];
}): Promise<string | null> {
  const live = await isSubmissionToGroupEnabled();

  const preset = await prisma.groupPreset.findUnique({
    where: { name: opts.groupName },
    select: { chatId: true },
  });
  if (live && !preset?.chatId) {
    // Группу к чату ещё не привязали — отправлять некуда. Не ошибка: так
    // выглядит новая группа до первой настройки.
    console.warn(`[submission] «${opts.groupName}» не привязана к чату — обращение в группу не ушло`);
    return null;
  }

  // Выключено — репетиция в служебный канал. Нет и его — значит форма и так
  // не работает (без него не грузятся фото), молчим.
  const storageChatId = process.env.TELEGRAM_STORAGE_CHAT_ID?.trim();
  const chatId = live ? preset!.chatId! : storageChatId;
  if (!chatId) return null;

  const withPhotos = opts.photoFileIds.length > 0;
  const { html, plain } = buildSubmissionPost({
    issueId: opts.issueId,
    groupName: opts.groupName,
    authorName: opts.authorName,
    telegramUserId: opts.telegramUserId,
    label: opts.label,
    values: opts.values,
    live,
    limit: withPhotos ? CAPTION_LIMIT : 4096,
  });

  // С фото текст уходит подписью к альбому: отдельным сообщением он
  // оторвался бы от скриншотов, а в группе между ними успевает влезть
  // чужая реплика.
  const sent = withPhotos
    ? await sendStoredPhotos(chatId, opts.photoFileIds, html, "HTML")
    : await sendTelegramMessage(chatId, html, undefined, undefined, "HTML");
  if (!sent) {
    console.warn(
      `[submission] не отправилось ${live ? `в «${opts.groupName}»` : "в тест-канал"} (чат ${chatId})`
    );
    return null;
  }

  // Запоминаем как сообщение бота по этому тикету: по нему работает
  // «Удалить ответ» на сайте, и — главное — ответ коллеги реплаем на него
  // приклеится к тому же тикету (attachReplyToBotMessage), а не заведёт
  // второй.
  await prisma.botReply.create({
    data: {
      issueId: opts.issueId,
      chatId,
      messageId: sent.message_id,
      // Разные виды: тестовое сообщение на карточке подписано по-другому,
      // и удалять его после репетиции — обычное дело, а не правка ответа
      // коллегам.
      kind: live ? "SUBMISSION" : "SUBMISSION_TEST",
      text: plain.slice(0, CAPTION_LIMIT),
    },
  });

  // Ссылку отдаём только на настоящую публикацию: её пишут в telegramLink
  // тикета, а ссылки тикета печатаются в репорт руководству
  // (generateReportText → issueLinks). Ссылка на ТЕСТ-сообщение в закрытом
  // служебном канале там была бы битой для всех, кроме нас. Тестовое
  // сообщение с карточки и так достижимо — через запись BotReply.
  return live ? buildMessageLink(Number(chatId), sent.message_id) : null;
}
