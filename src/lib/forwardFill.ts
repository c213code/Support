import { extractTicketHints } from "@/lib/ticketHints";
import { stripCredentials } from "@/lib/textClean";
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
// однозначно (адрес, десятизначный номер, http-ссылка). Значения одного типа
// раскладываются по полям в том порядке, в каком стоят в переписке: у смены
// номера первый номер встаёт в «ескі», второй — в «жаңа». Так их обычно и
// пишут («+7 747… осы нөмірді ауыстыру керек +998…»), а оба поля куратор
// видит перед отправкой и поменяет местами, если в переписке было наоборот.
//
// Чью почту мы видим, разбор не знает, поэтому поля, где ответ зависит от
// «чья», он не трогает вовсе (NEVER_AUTOFILL): в пересланной жалобе почта —
// почти всегда ученика, и отдать её в «Кураторлардың поштасы» значило бы
// ошибиться молча.

const URL_RE = /https?:\/\/\S+/g;

// Поля, которые принимают любой контакт — и почту, и номер (у «Басқа
// мәселе» он один такой). Тип у них text: в поле для почты номер вписать
// нельзя, а куратор шлёт то одно, то другое.
const CONTACT_FIELD_IDS = ["studentContact", "oldContact", "contact"];

// Поля, которые разбор не заполняет никогда: кто владелец значения, из
// переписки не понять.
const NEVER_AUTOFILL = ["curatorEmail"];

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


  // Каждое значение уходит в одно поле: у ярлыка смены почты два поля типа
  // email, и обе почты из переписки должны встать по разным, а не по одному.
  const freeEmails = [...emails];
  const freePhones = [...phones];
  const freeUrls = [...urls];
  const used: string[] = [];

  const values: Record<string, string | string[]> = {};
  for (const field of label.fields) {
    if (NEVER_AUTOFILL.includes(field.id)) continue;
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

  // Пароли не храним нигде: ни в описании, ни в полях. Дежурный заходит в
  // аккаунт не по ним, а в репорт боссам они не должны попадать и подавно —
  // поэтому вырезаем той же функцией, что и чистка описания.
  const description = stripCredentials(
    text
      .split("\n")
      .filter((line) => !isBareValue(line, used))
      .join("\n")
  ).trim();

  // Сначала именно «описание», и только если его у ярлыка нет — первое
  // многострочное поле. Одним find() с «или» это было неверно: у ЖЖ раньше
  // описания стоит «Кімді кіммен жұптау керек?», и вся переписка уезжала
  // туда — в поле, которое ещё и скрыто, пока не выбрано перепаривание.
  const descriptionField =
    label.fields.find((f) => f.id === "description") ??
    label.fields.find((f) => f.type === "textarea");
  // Описание — всегда: даже если от текста ничего не осталось, пустое поле
  // честнее подставленного куска, который уже разложен по полям.
  if (descriptionField) values[descriptionField.id] = description;

  return values;
}
