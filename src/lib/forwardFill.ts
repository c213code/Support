import { extractTicketHints } from "@/lib/ticketHints";
import { isBareCredentialLine } from "@/lib/textClean";
import { formatKzPhone } from "@/lib/phone";
import type { LabelField, SubmissionLabel } from "@/lib/submissionLabels";

// Пересланная переписка → по полям выбранного ярлыка.
//
// Куратор пересылает боту то, что ему прислали: отдельной строкой номер,
// отдельной пароль, потом «кіріп көрші», потом ссылка и скрин. Весь этот
// текст падал в «Мәселенің сипаттамасы» одним куском, а поля рядом
// оставались пустыми — то есть ярлык, ради которого всё и затевалось, не
// собирал ничего. Здесь текст разбирается: почта, номер и ссылка встают в
// свои поля, остальное остаётся описанием.
//
// Разбор намеренно консервативный: берём только то, что опознаётся
// однозначно (адрес, десятизначный номер, http-ссылка). Угадывать, какой из
// двух номеров «старый», а какой «новый», мы не беремся — куратор поправит
// на экране, а вот молча переставить местами номера в заявке на смену
// номера было бы хуже, чем не заполнить вовсе.

const URL_RE = /https?:\/\/\S+/g;

// Поля, которые принимают любой контакт — и почту, и номер (у «Басқа
// мәселе» он один такой). Тип у них text: в поле для почты номер вписать
// нельзя, а куратор шлёт то одно, то другое.
const CONTACT_FIELD_IDS = ["studentContact", "oldContact", "contact"];

// Поле под голый пароль («talgataibynjuz40password2010» отдельной строкой).
const PASSWORD_FIELD_IDS = ["studentPassword", "password"];

// Строка, в которой кроме самого контакта ничего нет, — из описания уходит:
// значение уже стоит в своём поле, и второй раз читать его незачем. Строку
// с текстом вокруг контакта оставляем как есть: там контекст.
function isBareValue(line: string, values: string[]): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return values.some((value) => trimmed === value.trim());
}

function pickContactKind(field: LabelField): boolean {
  const options = field.options?.map((o) => o.value) ?? [];
  return options.length === 2 && options.includes("phone") && options.includes("email");
}

export function fillFromForward(
  label: SubmissionLabel,
  text: string
): Record<string, string | string[]> {
  const { emails, phones } = extractTicketHints([text]);
  const urls = Array.from(new Set(text.match(URL_RE) ?? []));
  // Пароль присылают отдельной строкой следом за номером — тем же
  // признаком, которым чистка описания выкидывает его из репорта.
  const passwords = text.split("\n").map((l) => l.trim()).filter(isBareCredentialLine);

  // Каждое значение уходит в одно поле: у ярлыка смены почты два поля типа
  // email, и обе почты из переписки должны встать по разным, а не по одному.
  const freeEmails = [...emails];
  const freePhones = [...phones];
  const freeUrls = [...urls];
  const freePasswords = [...passwords];
  const used: string[] = [];

  const values: Record<string, string | string[]> = {};
  for (const field of label.fields) {
    if (field.type === "select" && pickContactKind(field)) {
      // Выбор «номер или почта» ставим по тому, что нашлось: иначе поле
      // останется на умолчании, а заполненное значение под ним — скрытым.
      if (freePhones.length > 0) values[field.id] = "phone";
      else if (freeEmails.length > 0) values[field.id] = "email";
      continue;
    }
    // Повторяемое поле (у «Сұрақ немесе жауапты өзгерту» ссылок бывает
    // несколько) хранит массив: кладём то, что нашли, одной строкой списка,
    // остальные куратор добавит кнопкой.
    const put = (value: string) => {
      values[field.id] = field.repeatable ? [value] : value;
      used.push(value);
    };

    if (field.type === "text" && PASSWORD_FIELD_IDS.includes(field.id)) {
      if (freePasswords.length > 0) put(freePasswords.shift()!);
      continue;
    }
    if (field.type === "text" && CONTACT_FIELD_IDS.includes(field.id)) {
      // Почта понятнее номера (по ней дежурный ищет ученика), поэтому она
      // первая; номер — если почты в переписке не было.
      if (freeEmails.length > 0) {
        put(freeEmails.shift()!);
        continue;
      }
      if (freePhones.length > 0) {
        const phone = freePhones.shift()!;
        values[field.id] = formatKzPhone(phone, "");
        used.push(phone);
        continue;
      }
      continue;
    }
    if (field.type === "email" && freeEmails.length > 0) {
      put(freeEmails.shift()!);
      continue;
    }
    if (field.type === "phone" && freePhones.length > 0) {
      // Тот же вид, что при ручном наборе, — дежурный сверяет их глазами.
      const phone = freePhones.shift()!;
      values[field.id] = field.repeatable
        ? [formatKzPhone(phone, "")]
        : formatKzPhone(phone, "");
      used.push(phone);
      continue;
    }
    if (field.type === "link" && freeUrls.length > 0) {
      put(freeUrls.shift()!);
      continue;
    }
  }

  const description = text
    .split("\n")
    .filter((line) => !isBareValue(line, used))
    .join("\n")
    .trim();

  const descriptionField = label.fields.find(
    (f) => f.id === "description" || f.type === "textarea"
  );
  // Описание — всегда: даже если от текста ничего не осталось, пустое поле
  // честнее подставленного куска, который уже разложен по полям.
  if (descriptionField) values[descriptionField.id] = description;

  return values;
}
