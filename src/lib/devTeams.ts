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
// Чат разработчиков — форум с топиком на команду. Тоже env: для живых тестов
// его подменяют на свою тестовую группу, чтобы не писать в настоящую.
//   DEV_CHAT_ID="-1001759146038"
//   DEV_TEAM_TOPICS="Backend:19671,Frontend:19672,Product:19673,Мобайл:30569"
const DEV_CHAT_ID_ENV = "DEV_CHAT_ID";
const DEV_TEAM_TOPICS_ENV = "DEV_TEAM_TOPICS";

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

function readEnv(name: string): string {
  return (process.env[name] ?? "")
    .trim()
    .replace(new RegExp(`^${name}\\s*=\\s*`), "")
    .replace(/^["']|["']$/g, "");
}

function readEnvList(name: string): string[] {
  return readEnv(name)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function warnOnce(name: string, entry: string, expected: string): void {
  const key = `${name}|${entry}`;
  if (warnedEntries.has(key)) return;
  warnedEntries.add(key);
  console.warn(`[devTeams] ${name}: не разобрана запись «${entry}» — нужно «${expected}», команда из ESCALATION_TEAMS`);
}

export function devTeamMembers(): DevMember[] {
  return readEnvList(DEV_TEAM_MEMBERS_ENV).flatMap((entry) => {
    const [team, name, idStr, flag] = entry.split(":").map((part) => part.trim());
    const telegramId = Number(idStr);
    if (!isEscalationTeam(team) || !name || !Number.isFinite(telegramId) || telegramId === 0) {
      warnOnce(DEV_TEAM_MEMBERS_ENV, entry, "Команда:Имя:telegramId[:lead]");
      return [];
    }
    return [{ team, name, telegramId, lead: flag?.toLowerCase() === "lead" }];
  });
}

export function devChatId(): string | null {
  return readEnv(DEV_CHAT_ID_ENV) || null;
}

function devTeamTopics(): Array<{ team: EscalationTeam; topicId: number }> {
  return readEnvList(DEV_TEAM_TOPICS_ENV).flatMap((entry) => {
    const [team, idStr] = entry.split(":").map((part) => part.trim());
    const topicId = Number(idStr);
    if (!isEscalationTeam(team) || !Number.isInteger(topicId) || topicId <= 0) {
      warnOnce(DEV_TEAM_TOPICS_ENV, entry, "Команда:idТопика");
      return [];
    }
    return [{ team, topicId }];
  });
}

export function teamForTopic(topicId: number | null | undefined): EscalationTeam | null {
  if (!topicId) return null;
  return devTeamTopics().find((t) => t.topicId === topicId)?.team ?? null;
}

// Человек по Telegram-id в любой команде — для отметки в чате разработчиков,
// где команду ещё надо узнать.
export function devMemberAnywhere(telegramId: number): DevMember | null {
  return devTeamMembers().find((m) => m.telegramId === telegramId) ?? null;
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
