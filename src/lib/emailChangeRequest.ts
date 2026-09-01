// Распознавание «просят сменить почту ученику» в тексте обращения — чтобы на
// карточке показать кнопку «Сменить почту A → B» (сам инструмент —
// /platform/change-email). Бот только предлагает; меняет всё равно агент.
//
// Правила собраны из реальных выгрузок групп. Ключевой урок: сообщений с
// ДВУМЯ почтами много (списки учеников на приглашения/оплаты/результаты), и
// сами по себе они НЕ запрос на смену. Поэтому нужен ещё и маркер замены —
// почти всегда казахский: «ескі/жаңа почта», «қате … дұрыс», «қатесі/дұрысы»,
// «ауыстыру», плюс русские аналоги. Как побочный эффект это отсекает списки.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Намерение именно СМЕНЫ почты (не любой текст с адресами).
const INTENT_RE =
  /(ескі\s*почт|жаңа\s*почт|қате\s*кеткен|қатесі|дұрысы|ауыстыр|өзгерт|помен|замен|смен[аи]|нов\w*\s*почт|стар\w*\s*почт|измен\w*\s*почт|неправильн|правильн)/i;

// Маркеры «это старая» / «это новая» рядом с адресом.
const OLD_MARK = /(ескі|қате|қатесі|бұрын|стар|ошиб|неправильн|неверн)/i;
const NEW_MARK = /(жаңа|дұрыс|дұрысы|жаңасы|нов|правильн|верн)/i;

export type EmailChangeRequest = {
  oldEmail: string;
  newEmail: string;
};

// Возвращает пару почт (по лучшей догадке, где старая, где новая) для запроса
// смены — или null, если это не он. Направление здесь — только для подписи
// кнопки и предзаполнения; инструмент всё равно перепроверяет по платформе,
// какая почта реально текущая, так что ошибка в догадке не критична.
export function detectEmailChangeRequest(
  text: string | null | undefined
): EmailChangeRequest | null {
  if (!text || !INTENT_RE.test(text)) return null;

  const emails = [
    ...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())),
  ];
  // Ровно две почты = кандидат на «A → B». Одна — нечего менять на что; больше
  // двух — это список учеников, а не одна смена (не задача этой кнопки).
  if (emails.length !== 2) return null;

  const [first, second] = emails;
  const lower = text.toLowerCase();
  const windowAround = (email: string): string => {
    const i = lower.indexOf(email);
    if (i < 0) return "";
    return lower.slice(Math.max(0, i - 30), i + email.length + 30);
  };
  const w1 = windowAround(first);
  const w2 = windowAround(second);

  // По умолчанию первая почта — старая (частый шаблон «қате … дұрыс»).
  let oldEmail = first;
  let newEmail = second;
  const secondLooksOld = OLD_MARK.test(w2) && !NEW_MARK.test(w2);
  const firstLooksNew = NEW_MARK.test(w1) && !OLD_MARK.test(w1);
  if (secondLooksOld || firstLooksNew) {
    oldEmail = second;
    newEmail = first;
  }

  if (oldEmail === newEmail) return null;
  return { oldEmail, newEmail };
}
