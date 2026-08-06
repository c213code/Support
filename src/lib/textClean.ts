// Убирает то, что агенты и так всегда вычищают руками перед тем, как
// вписать текст в описание тикета: приветствия на казахском/русском,
// голые ссылки (и слово "ссылка"), почту, номера телефона, логин/пароль и
// плейсхолдеры вложений ([Фото], [Видео] и т.п.). Работает по регуляркам —
// без внешних API, бесплатно и мгновенно. Если после чистки ничего не
// осталось (например, всё сообщение и было одним приветствием) —
// возвращаем исходный текст, чтобы тикет не остался без описания.
const GREETING_PATTERNS: RegExp[] = [
  /қайырлы\s+таң/gi,
  /қайырлы\s+күн/gi,
  /қайырлы\s+кеш/gi,
  /сәлеметсіз\s*бе/gi,
  /сәлем(етсіз)?/gi,
  /ассалаумағалейкум/gi,
  /здравствуйте/gi,
  /добрый\s+день/gi,
  /добрый\s+вечер/gi,
  /доброе\s+утро/gi,
  /привет(ствую)?/gi,
];

const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;

// Номер телефона не привязан к одному формату (+7/8, пробелы, дефисы,
// скобки) — считаем совпадением любую цепочку цифр с разделителями, где
// цифр в сумме 10 и больше. Это отсекает короткие числа вроде кодов ошибок
// или "3 попытки", но ловит реальные номера в любом написании.
const PHONE_CANDIDATE_PATTERN = /\+?\d[\d\-\s()]{7,}\d/g;

// То, что Telegram-сообщение без текста превращается в такой плейсхолдер
// (см. extractText в lib/telegram.ts) — в описании тикета он не нужен.
const ATTACHMENT_PLACEHOLDER_PATTERN =
  /\[(Фото|Видео|Голосовое сообщение|Стикер[^\]]*|Файл:[^\]]*)\]/gi;

const CONTACT_LABEL_WORDS =
  "почта|email|e-mail|номер|тел(?:ефон)?|phone|ссылка|линк|url";

// Строка-подпись вида "Почта:" / "Ссылка" без значения — остаётся пустой
// после вырезания email/телефона/ссылки выше, убираем её тоже, а не просто
// ярлык.
const CONTACT_LABEL_LINE = new RegExp(
  `^(?:${CONTACT_LABEL_WORDS})\\s*[:\\-]?\\s*$`,
  "i"
);

// То же самое, но когда ярлык идёт не отдельной строкой, а прямо в
// предложении ("...проблема с логином, email ivan@mail.com") — после
// вырезания адреса ярлык остаётся висеть между запятой/началом строки и
// концом строки/следующей запятой, тоже убираем.
const CONTACT_LABEL_TOKEN = new RegExp(
  `(^|\\n|,)\\s*(?:${CONTACT_LABEL_WORDS})\\s*[:\\-]?\\s*(?=,|\\n|$)`,
  "gi"
);

// Логин/пароль — в отличие от почты/телефона/ссылки, у значения нет
// узнаваемого формата (это может быть любая строка вроде "Balausa10"), так
// что вырезать можно только по соседству со словом-меткой. Раз значение
// нельзя надёжно отделить от остального текста — безопаснее выпиливать
// строку целиком, чем случайно оставить логин/пароль в тикете.
const CREDENTIAL_LABEL_WORDS = "логин|login|пароль|password";
// Строка — это ровно слово-метка (типичный формат "логин" / "пароль" на
// отдельной строке, а значение — на следующей).
const CREDENTIAL_LABEL_LINE = new RegExp(
  `^(?:${CREDENTIAL_LABEL_WORDS})\\s*[:\\-]?\\s*$`,
  "i"
);
// Метка + один соседний токен-значение на той же строке, в любом порядке
// ("Balausa10 пароль" или "логин test123"). \b тут не подходит — он
// завязан на \w, а \w по умолчанию не считает кириллицу "буквой", так что
// граница перед "логин"/"пароль" просто не находится. Вместо этого — явная
// проверка через \p{L}/\p{N} (Unicode-буква/цифра) по обе стороны.
const CREDENTIAL_PAIR = new RegExp(
  `[^\\s,]+\\s+(?:${CREDENTIAL_LABEL_WORDS})(?![\\p{L}\\p{N}])` +
    `|(?<![\\p{L}\\p{N}])(?:${CREDENTIAL_LABEL_WORDS})\\s*[:\\-]?\\s*[^\\s,]+`,
  "iu"
);

export function cleanTicketDescription(raw: string): string {
  let text = raw;
  for (const pattern of GREETING_PATTERNS) {
    text = text.replace(pattern, "");
  }
  text = text.replace(URL_PATTERN, "");
  text = text.replace(EMAIL_PATTERN, "");
  text = text.replace(PHONE_CANDIDATE_PATTERN, (match) => {
    const digitCount = (match.match(/\d/g) ?? []).length;
    return digitCount >= 10 ? "" : match;
  });
  text = text.replace(ATTACHMENT_PLACEHOLDER_PATTERN, "");
  text = text.replace(CONTACT_LABEL_TOKEN, "$1");
  // Вырезание ярлыков в середине строки могло оставить "код,, помогите" —
  // схлопываем соседние разделители в один.
  text = text.replace(/[ \t]*,(?:[ \t]*,)+/g, ",");

  const lines = text.split("\n");
  const keep = new Array<boolean>(lines.length).fill(true);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (CREDENTIAL_LABEL_LINE.test(trimmed)) {
      // "логин" одним словом на своей строке — значение почти всегда на
      // следующей строке ("логин\nBalausa10").
      keep[i] = false;
      if (i + 1 < lines.length) keep[i + 1] = false;
      continue;
    }
    const withoutPair = trimmed
      .replace(CREDENTIAL_PAIR, "")
      .replace(/^[\s,.:!–-]+|[\s,.:!–-]+$/g, "")
      .trim();
    // Убираем строку целиком только если метка+значение и были всей
    // строкой ("Balausa10 пароль") — если после вырезания пары остаётся
    // ещё текст, значит метка встретилась внутри обычного предложения
    // ("пароль не подходит") и трогать её рискованно.
    if (withoutPair !== trimmed && withoutPair.length === 0) {
      keep[i] = false;
    }
  }

  const cleaned = lines
    .filter((_, i) => keep[i])
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[\s,.:!–-]+|[\s,.:!–-]+$/g, "")
        .trim()
    )
    .filter((line) => line.length > 0 && !CONTACT_LABEL_LINE.test(line))
    .join("\n")
    .trim();

  return cleaned || raw.trim();
}
