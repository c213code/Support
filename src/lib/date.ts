const TIMEZONE = "Asia/Almaty";
// Алматы — фиксированный UTC+5, без перехода на летнее время.
const TIMEZONE_OFFSET_HOURS = 5;

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
