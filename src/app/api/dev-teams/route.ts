import { NextResponse } from "next/server";
import { ESCALATION_TEAMS } from "@/lib/escalation";
import { teamMembers } from "@/lib/devTeams";
import { jiraConfigured } from "@/lib/jira";

// Кто в какой команде — для выбора исполнителя в окне «Передать». Только
// имена и отметка лида: Telegram-id сайту не нужны, они остаются на сервере
// (по ним бот отмечает разработчика в чате).
export async function GET() {
  const teams = Object.fromEntries(
    ESCALATION_TEAMS.map((team) => [
      team,
      teamMembers(team).map(({ name, lead }) => ({ name, lead })),
    ])
  );
  // jira — есть ли токен: без него кнопку «Баг в Jira» не показываем.
  return NextResponse.json({ teams, jira: jiraConfigured() });
}
