// Единственные 4 официальные support-группы в Telegram. Привязка чата к
// группе (GroupPreset.chatId) должна идти строго через них — личные чаты
// ("Жеке чат: Имя") заводятся отдельно, вручную, при создании тикета.
export const OFFICIAL_GROUPS = [
  { name: "Әдістеме & IT", emoji: "🎲", order: 1 },
  { name: "Сату - Платформа", emoji: "💵", order: 2 },
  { name: "IT & Product", emoji: "📚", order: 3 },
  { name: "IT + Сервис", emoji: "📥", order: 4 },
] as const;

export type OfficialGroupName = (typeof OFFICIAL_GROUPS)[number]["name"];

export const OFFICIAL_GROUP_NAMES: readonly string[] = OFFICIAL_GROUPS.map(
  (g) => g.name
);

export function isOfficialGroupName(name: string): name is OfficialGroupName {
  return OFFICIAL_GROUP_NAMES.includes(name);
}

// Цветовой акцент на группу — чтобы репорт/дашборд не был монохромным, и
// глазами было легко отличить "Сату" от "IT + Сервис" ещё до чтения текста.
// Оставляем в стороне emerald/amber — они заняты под статусы (решено/пендинг).
const GROUP_COLORS: Record<
  string,
  { bg: string; text: string; border: string }
> = {
  "Әдістеме & IT": {
    bg: "bg-violet-50",
    text: "text-violet-700",
    border: "border-violet-300",
  },
  "Сату - Платформа": {
    bg: "bg-teal-50",
    text: "text-teal-700",
    border: "border-teal-300",
  },
  "IT & Product": {
    bg: "bg-sky-50",
    text: "text-sky-700",
    border: "border-sky-300",
  },
  "IT + Сервис": {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-300",
  },
};

const FALLBACK_GROUP_COLOR = {
  bg: "bg-slate-100",
  text: "text-slate-600",
  border: "border-slate-300",
};

export function groupColor(name: string) {
  return GROUP_COLORS[name] ?? FALLBACK_GROUP_COLOR;
}
