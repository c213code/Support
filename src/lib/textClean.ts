// Убирает то, что агенты и так всегда вычищают руками перед тем, как
// вписать текст в описание тикета: приветствия на казахском/русском и
// голые ссылки. Работает по регуляркам — без внешних API, бесплатно и
// мгновенно. Если после чистки ничего не осталось (например, всё
// сообщение и было одним приветствием) — возвращаем исходный текст, чтобы
// тикет не остался без описания.
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

export function cleanTicketDescription(raw: string): string {
  let text = raw;
  for (const pattern of GREETING_PATTERNS) {
    text = text.replace(pattern, "");
  }
  text = text.replace(URL_PATTERN, "");

  const cleaned = text
    .split("\n")
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, " ")
        .replace(/^[\s,.:!–-]+|[\s,.:!–-]+$/g, "")
        .trim()
    )
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();

  return cleaned || raw.trim();
}
