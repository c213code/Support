// Команды, которым можно передать тикет из статуса "Передано" (см.
// STATUS_META.ESCALATED в lib/status.ts). Фиксированный список, а не
// свободный текст — те же 3-4 команды и так постоянно повторялись бы, а
// фиксированный список ещё и не даёт разъехаться написанию ("Бэкенд" /
// "backend" / "Backend team").
export const ESCALATION_TEAMS = ["Backend", "Frontend", "Product", "Мобайл"] as const;

export type EscalationTeam = (typeof ESCALATION_TEAMS)[number];

export function isEscalationTeam(value: unknown): value is EscalationTeam {
  return (
    typeof value === "string" &&
    (ESCALATION_TEAMS as readonly string[]).includes(value)
  );
}

// Заметка по умолчанию при передаче — она же уходит в репорт: «Передано:
// Backend (Даука)». Одна на сайт и на разбор в Telegram, чтобы в репорте
// не было двух написаний одного и того же.
export function escalationNote(team: EscalationTeam, assignee: string): string {
  return `Передано: ${team}${assignee.trim() ? ` (${assignee.trim()})` : ""}`;
}
