export const ISSUE_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "SENT",
  "RESOLVED",
] as const;

export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export function isIssueStatus(value: unknown): value is IssueStatus {
  return (
    typeof value === "string" &&
    (ISSUE_STATUSES as readonly string[]).includes(value)
  );
}

type StatusMeta = {
  label: string;
  emoji: string;
  // Как статус показывается в готовом тексте репорта. По решению "богатые
  // статусы только на сайте": решено → ✅, всё остальное → ⚠️.
  reportEmoji: "✅" | "⚠️";
  // Заметка по умолчанию, если поле пустое.
  defaultNote: string;
  // Классы Tailwind для разных мест интерфейса.
  badge: string; // маленький бейдж-пилюля
  active: string; // выбранная кнопка в переключателе
  idle: string; // невыбранная кнопка в переключателе
  bar: string; // цветная полоса слева на карточке тикета
};

export const STATUS_META: Record<IssueStatus, StatusMeta> = {
  PENDING: {
    label: "Пендинг",
    emoji: "⚠️",
    reportEmoji: "⚠️",
    defaultNote: "Пендинг",
    badge: "bg-amber-50 text-amber-700",
    active: "border-amber-500 bg-amber-50 text-amber-700 ring-1 ring-amber-200",
    idle: "border-slate-200 text-slate-500 hover:bg-slate-50",
    bar: "border-l-amber-400",
  },
  IN_PROGRESS: {
    label: "В работе",
    emoji: "🔄",
    reportEmoji: "⚠️",
    defaultNote: "Қарап жатырмыз",
    badge: "bg-sky-50 text-sky-700",
    active: "border-sky-500 bg-sky-50 text-sky-700 ring-1 ring-sky-200",
    idle: "border-slate-200 text-slate-500 hover:bg-slate-50",
    bar: "border-l-sky-400",
  },
  SENT: {
    label: "Отправлено",
    emoji: "📨",
    reportEmoji: "⚠️",
    defaultNote: "Тикет ашылды",
    badge: "bg-violet-50 text-violet-700",
    active:
      "border-violet-500 bg-violet-50 text-violet-700 ring-1 ring-violet-200",
    idle: "border-slate-200 text-slate-500 hover:bg-slate-50",
    bar: "border-l-violet-400",
  },
  RESOLVED: {
    label: "Решено",
    emoji: "✅",
    reportEmoji: "✅",
    defaultNote: "Шешілді",
    badge: "bg-emerald-50 text-emerald-700",
    active:
      "border-emerald-500 bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
    idle: "border-slate-200 text-slate-500 hover:bg-slate-50",
    bar: "border-l-emerald-400",
  },
};
