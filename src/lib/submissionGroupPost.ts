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
  if (!(await isSubmissionToGroupEnabled())) return null;

  const preset = await prisma.groupPreset.findUnique({
    where: { name: opts.groupName },
    select: { chatId: true },
  });
  if (!preset?.chatId) {
    // Группу к чату ещё не привязали — отправлять некуда. Не ошибка: так
    // выглядит новая группа до первой настройки.
    console.warn(`[submission] «${opts.groupName}» не привязана к чату — обращение в группу не ушло`);
    return null;
  }

  // Подпись к фото у Telegram — 1024 символа, у сообщения — 4096. Режем
  // сами поля ДО сборки html: обрезать готовую разметку нельзя, оборванный
  // тег Telegram не примет вовсе.
  const withPhotos = opts.photoFileIds.length > 0;
  const room = (withPhotos ? CAPTION_LIMIT : 4096) - opts.authorName.length - 40;
  const details = opts.details.slice(0, room);
  const mention = `<a href="tg://user?id=${opts.telegramUserId}">${escapeHtml(opts.authorName)}</a>`;
  const html = `📨 Жаңа өтініш · ${mention}\n${escapeHtml(details)}`;
  // То же самое без разметки — для записи о сообщении бота и для списка
  // «удалить ответ», где разметка только мешает читать.
  const plain = `📨 Жаңа өтініш · ${opts.authorName}\n${details}`;

  // С фото текст уходит подписью к альбому: отдельным сообщением он
  // оторвался бы от скриншотов, а в группе между ними успевает влезть
  // чужая реплика.
  const sent = withPhotos
    ? await sendStoredPhotos(preset.chatId, opts.photoFileIds, html, "HTML")
    : await sendTelegramMessage(preset.chatId, html, undefined, undefined, "HTML");
  if (!sent) {
    console.warn(`[submission] не отправилось в «${opts.groupName}» (чат ${preset.chatId})`);
    return null;
  }

  // Запоминаем как сообщение бота по этому тикету: по нему работает
  // «Удалить ответ» на сайте, и — главное — ответ коллеги реплаем на него
  // приклеится к тому же тикету (attachReplyToBotMessage), а не заведёт
  // второй.
  await prisma.botReply.create({
    data: {
      issueId: opts.issueId,
      chatId: preset.chatId,
      messageId: sent.message_id,
      kind: "SUBMISSION",
      text: plain.slice(0, CAPTION_LIMIT),
    },
  });

  return buildMessageLink(Number(preset.chatId), sent.message_id);
}
