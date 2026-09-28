// Телефон приводится к «+7 (777) 777 77 77» прямо при наборе: куратор пишет
// номера то через 8, то без скобок, то с дефисами, и дежурный потом сверяет
// их с платформой глазами. Маска убирает этот разнобой в источнике.
//
// previous нужен из-за особенности любых масок: если стереть разделитель
// (скобку или пробел), цифры не изменятся и форматирование вернёт символ на
// место — backspace будет «застревать». Поэтому при удалении, не тронувшем
// цифры, снимаем последнюю цифру.
export function formatKzPhone(input: string, previous: string): string {
  const raw = input.trim();
  let digits = raw.replace(/\D/g, "");
  if (input.length < previous.length && digits === previous.replace(/\D/g, "")) {
    digits = digits.slice(0, -1);
  }
  if (!digits) return "";

  // Ведущая семёрка — это код страны только когда номер начали с «+» или
  // набрали все 11 цифр. Иначе она часть кода оператора: 707, 747, 777 — и
  // «7071234567» без этой оговорки превращалось в «+7 (071) 234 56 7».
  const hasCountryCode = raw.startsWith("+") || digits.length >= 11;
  let rest = digits;
  if (hasCountryCode) {
    if (rest[0] === "8") rest = `7${rest.slice(1)}`;
    if (rest[0] === "7") rest = rest.slice(1);
  } else if (rest[0] === "8") {
    rest = rest.slice(1);
  }
  rest = rest.slice(0, 10);
  let out = "+7";
  if (rest.length > 0) out += ` (${rest.slice(0, 3)}`;
  if (rest.length >= 3) out += ")";
  if (rest.length > 3) out += ` ${rest.slice(3, 6)}`;
  if (rest.length > 6) out += ` ${rest.slice(6, 8)}`;
  if (rest.length > 8) out += ` ${rest.slice(8, 10)}`;
  return out;
}

// Номер в том виде, в каком его хранит платформа JUZ40: "+7XXXXXXXXXX" — для
// поиска и смены номера ученику (/platform/change-email). Дежурный вставляет
// номер как прислали — «+7 (775) 666 55 33», «87756665533», «7756665533».
// Поиск платформы находит «+7…», «7…» и номер без семёрки, но не «8…».
//
// Только строка из цифр и разделителей: почта или имя с цифрами — не номер.
export function normalizeKzPhone(input: string): string | null {
  const trimmed = input.trim();
  if (!/^[\d\s()+-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10 && digits.startsWith("7")) return `+7${digits}`;
  if (digits.length === 11 && (digits.startsWith("7") || digits.startsWith("8"))) {
    return `+7${digits.slice(1)}`;
  }
  return null;
}
