// Кто в какой команде разработки — чтобы «Передать» спрашивало не только
// команду, но и человека в ней (EscalateDialog на сайте, «Кому в Backend?»
// в разборе в Telegram).
//
// Список держим в переменной окружения, а не в коде: репозиторий публичный,
// а это Telegram-id живых людей (тот же подход, что у AGENT_TELEGRAM_IDS).
//
// Формат: "Команда:Имя:telegramId[:lead]" через запятую, команда — одно из
// ESCALATION_TEAMS:
//   DEV_TEAM_MEMBERS="Backend:Даука:7666698363:lead,Backend:Ораз:7701178805,Мобайл:Алдияр:395480351:lead"
import { isEscalationTeam, type EscalationTeam } from "@/lib/escalation";

const DEV_TEAM_MEMBERS_ENV = "DEV_TEAM_MEMBERS";

export type DevMember = {
  team: EscalationTeam;
  name: string;
  telegramId: number;
  lead: boolean;
};

// Запись, которую не смогли разобрать, раньше пропадала молча — 05.10 так
// из окна «Передать» пропал Еркебулан, первый в списке. Если вставить в
// значение на Vercel строку целиком («DEV_TEAM_MEMBERS=Product:…») или с
// кавычками, первая запись читается с чужой командой и отбрасывается. Такой
// префикс и кавычки срезаем, а остальное непонятное пишем в лог — по одному
// разу на запись, а не на каждый запрос.
const warnedEntries = new Set<string>();

export function devTeamMembers(): DevMember[] {
  const raw = (process.env[DEV_TEAM_MEMBERS_ENV] ?? "")
    .trim()
    .replace(new RegExp(`^${DEV_TEAM_MEMBERS_ENV}\\s*=\\s*`), "")
    .replace(/^["']|["']$/g, "");
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [team, name, idStr, flag] = entry.split(":").map((part) => part.trim());
      const telegramId = Number(idStr);
      if (!isEscalationTeam(team) || !name || !Number.isFinite(telegramId) || telegramId === 0) {
        if (!warnedEntries.has(entry)) {
          warnedEntries.add(entry);
          console.warn(
            `[devTeams] ${DEV_TEAM_MEMBERS_ENV}: не разобрана запись «${entry}» — нужно «Команда:Имя:telegramId[:lead]», команда из ESCALATION_TEAMS`
          );
        }
        return [];
      }
      return [{ team, name, telegramId, lead: flag?.toLowerCase() === "lead" }];
    });
}

// Лид первым: ему чаще всего и передают, когда не знают, кто именно.
// Остальные — в порядке переменной.
export function teamMembers(team: EscalationTeam): DevMember[] {
  const members = devTeamMembers().filter((m) => m.team === team);
  return [...members.filter((m) => m.lead), ...members.filter((m) => !m.lead)];
}

export function devMemberByTelegramId(
  team: EscalationTeam,
  telegramId: number
): DevMember | null {
  return teamMembers(team).find((m) => m.telegramId === telegramId) ?? null;
}
