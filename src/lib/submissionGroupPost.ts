import { prisma } from "@/lib/prisma";
import {
  buildMessageLink,
  CAPTION_LIMIT,
  escapeHtml,
  sendStoredPhotos,
  sendTelegramMessage,
} from "@/lib/telegram";
import { isSubmissionToGroupEnabled } from "@/lib/settings";

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

export async function postSubmissionToGroup(opts: {
  issueId: string;
  groupName: string;
  authorName: string;
  // Telegram-id автора: по нему имя в шапке становится упоминанием, и
  // куратор получает уведомление, что его заявку видно в группе. Через
  // tg://user, а не @username — юзернейма у половины кураторов нет.
  telegramUserId: bigint;
  details: string;
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

  // Подпись к фото у Telegram — 1024 символа, у сообщения — 4096. Режем
  // сами поля ДО сборки html: обрезать готовую разметку нельзя, оборванный
  // тег Telegram не примет вовсе.
  const withPhotos = opts.photoFileIds.length > 0;
  const room = (withPhotos ? CAPTION_LIMIT : 4096) - opts.authorName.length - 40;
  const { masked, urls } = extractLinks(opts.details);
  const details = masked.slice(0, room);
  const mention = `<a href="tg://user?id=${opts.telegramUserId}">${escapeHtml(opts.authorName)}</a>`;
  // В тесте сразу видно, куда бы это ушло по-настоящему: без названия
  // группы репетиция бессмысленна, проверяют как раз адресата.
  const head = live
    ? "📨 Жаңа өтініш"
    : `🧪 ТЕСТ · ${escapeHtml(opts.groupName)} · Жаңа өтініш`;
  const html = `${head} · ${mention}\n${restoreLinks(escapeHtml(details), urls, true)}`;
  // То же самое без разметки — для записи о сообщении бота и для списка
  // «удалить ответ», где разметка только мешает читать. Адрес и там не
  // нужен: в списке важно узнать своё сообщение, а не прочитать ссылку.
  const plainHead = live ? "📨 Жаңа өтініш" : `🧪 ТЕСТ · ${opts.groupName} · Жаңа өтініш`;
  const plain = `${plainHead} · ${opts.authorName}\n${restoreLinks(details, urls, false)}`;

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

  return buildMessageLink(Number(chatId), sent.message_id);
}
