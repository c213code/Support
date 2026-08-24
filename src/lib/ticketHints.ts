// То, что чистка описания намеренно выкидывает, но агенту нужно, чтобы
// вообще начать работать: почта/телефон ученика и факт вложения.
//
// Причина конфликта: описание тикета пишется для репорта боссам, и почта с
// паролем там не нужны (см. textClean.ts). Но для того, кто эту задачу
// решает, почта — единственный способ найти ученика в админке, а строка
// "Мәселе суретте тұр" вообще бессмысленна без самой картинки. В итоге на
// карточке оставалось "Логин пароль жұмыс істемейді" и ни одной зацепки.
//
// Поэтому подсказки считаются отдельно от описания и показываются только на
// карточке — в текст репорта они не попадают никогда (generateReportText
// берёт исключительно description).

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Разделители без \s (только пробел и таб) — как и в textClean.ts: с \s
// регулярка перескакивала через перенос строки и склеивала два соседних
// значения в один "номер" ("87471292654\n096969mm" → "87471292654 096969").
const PHONE = /\+?\d[\d\-\t ()]{7,}\d/g;
const ATTACHMENT = /\[(Фото|Видео|Голосовое сообщение|Стикер[^\]]*|Файл:[^\]]*)\]/gi;

export type TicketHints = {
  emails: string[];
  phones: string[];
  // Во вложении может быть вся суть обращения ("мәселе суретте тұр"), и
  // тогда текст тикета сам по себе ничего не объясняет — на карточке нужен
  // явный знак, что смотреть надо в Telegram.
  hasAttachment: boolean;
};

export function extractTicketHints(texts: Array<string | null>): TicketHints {
  const joined = texts.filter(Boolean).join("\n");
  if (!joined) return { emails: [], phones: [], hasAttachment: false };

  const emails = Array.from(new Set(joined.match(EMAIL) ?? []));
  const phones = Array.from(
    new Set(
      (joined.match(PHONE) ?? []).filter(
        // Тот же порог, что в textClean: 10+ цифр — это номер, а не код
        // ошибки и не "3 попытки".
        (candidate) => (candidate.match(/\d/g) ?? []).length >= 10
      )
    )
  ).map((p) => p.trim());

  return {
    emails,
    phones,
    hasAttachment: ATTACHMENT.test(joined),
  };
}
