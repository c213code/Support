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
