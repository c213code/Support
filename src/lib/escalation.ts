// Команды, которым можно передать тикет из статуса "Передано" (см.
// STATUS_META.ESCALATED в lib/status.ts). Фиксированный список, а не
// свободный текст — те же 3-4 команды и так постоянно повторялись бы, а
// фиксированный список ещё и не даёт разъехаться написанию ("Бэкенд" /
// "backend" / "Backend team").
export const ESCALATION_TEAMS = ["Backend", "Frontend", "Product"] as const;

export type EscalationTeam = (typeof ESCALATION_TEAMS)[number];

export function isEscalationTeam(value: unknown): value is EscalationTeam {
  return (
    typeof value === "string" &&
    (ESCALATION_TEAMS as readonly string[]).includes(value)
  );
}
