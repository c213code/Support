const TIMEZONE = "Asia/Almaty";
// Алматы — фиксированный UTC+5, без перехода на летнее время.
const TIMEZONE_OFFSET_HOURS = 5;

// A new request received at 21:00 or later belongs to tomorrow's board.
// An explicitly selected historical/future date remains a manual override.
export function issueIntakeTiming(submittedAt: Date, requestedDate?: string) {
  const local = new Date(submittedAt.getTime() + TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
  const day = local.toISOString().slice(0, 10);
  const afterHours = local.getUTCHours() >= 21;
  const nextDay = shiftDateString(day, 1);
  const reportDate = requestedDate && requestedDate !== day
    ? requestedDate
    : afterHours ? nextDay : day;
  return {
    reportDate,
    afterHoursSubmittedAt: afterHours && reportDate === nextDay ? submittedAt : null,
  };
}

// Границы календарного дня (00:00–24:00 по Алматы) в UTC — для фильтрации
// timestamp-полей вроде TelegramMessage.receivedAt по дате.
export function dayRangeUtc(date: string): { start: Date; end: Date } {
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d, -TIMEZONE_OFFSET_HOURS));
  const end = new Date(Date.UTC(y, m - 1, d + 1, -TIMEZONE_OFFSET_HOURS));
  return { start, end };
}

export function todayDateString(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

export function shiftDateString(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Суббота или воскресенье — по самой дате (YYYY-MM-DD), без часового пояса:
// дата уже календарная, по Алматы.
export function isWeekendDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

const WEEKDAYS_RU = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

export function formatDateHuman(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAYS_RU[dt.getUTCDay()];
  return `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.${y} (${weekday})`;
}

// Время отправки репорта в группу (см. ReportSendLog) для сообщений
// "уже отправлено в HH:MM" — по Алматы, а не по UTC сервера.
export function formatTimeAlmaty(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

// Дата+время с секундами — для строк лога, где важно различить события в
// пределах одной минуты и понять, сегодняшний это день или нет. Источник —
// внешний сервис логов (Elasticsearch), формат timestamp не гарантирован —
// невалидную дату не парсим молча в NaN, а показываем прочерк, а не роняем
// Intl.DateTimeFormat.format() (RangeError на Invalid Date) на всю таблицу.
export function formatDateTimeAlmaty(date: Date): string {
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}
