import { prisma } from "@/lib/prisma";
import type { EscalationTeam } from "@/lib/escalation";
import { teamMembers } from "@/lib/devTeams";
import { writeJiraBug, type JiraPriority } from "@/lib/ai";
import { curatorTextFor, linkOptionsFor, seriesRows, submissionPostLink } from "@/lib/handoffDraft";
import type { JiraUser } from "@/lib/jira";

// Сборка бага для Jira из тикета: черновик от ИИ, скриншоты, исполнитель.
// Сам вызов Jira — lib/jira.ts.

// Тег команды в заголовке, как в заведённых руками («[BUG][MOBILE] …»). У
// продукта багов не бывает — для него кнопки нет.
const TEAM_TAG: Partial<Record<EscalationTeam, string>> = {
  Backend: "BACK",
  Frontend: "FRONT",
  Мобайл: "MOBILE",
};

// Сколько скриншотов прикладывать: больше — уже не иллюстрация, а архив.
const MAX_PHOTOS = 5;

export function jiraTeamTag(team: EscalationTeam): string | null {
  return TEAM_TAG[team] ?? null;
}

export function taggedSummary(team: EscalationTeam, summary: string): string {
  const tag = jiraTeamTag(team);
  const plain = summary.replace(/^(\s*\[[^\]]+\])+\s*/, "").trim();
  return tag ? `[BUG][${tag}] ${plain}` : plain;
}

// Скриншоты по тикету: из серии сообщений куратора и из формы мини-аппа.
export async function bugPhotoFileIds(issueId: string): Promise<string[]> {
  const [series, submissions] = await Promise.all([
    seriesRows(issueId),
    prisma.issueSubmission.findMany({
      where: { issueId },
      orderBy: { createdAt: "asc" },
      select: { photoFileId: true, photoFileIds: true },
    }),
  ]);
  const fromForm = submissions.flatMap((s) => (s.photoFileIds.length > 0 ? s.photoFileIds : [s.photoFileId]));
  const fromChat = series.map((r) => r.photoFileId).filter((id): id is string => Boolean(id));
  return Array.from(new Set([...fromForm, ...fromChat].filter(Boolean))).slice(0, MAX_PHOTOS);
}

export type BugDraft = {
  summary: string;
  component: string;
  problem: string;
  // Шаги — построчно: так их удобно править в одном поле.
  steps: string;
  actual: string;
  expected: string;
  priority: JiraPriority;
  priorityReason: string;
  telegramLink: string | null;
  photoCount: number;
  aiFailed: boolean;
};

export async function prepareBugDraft(issueId: string, team: EscalationTeam): Promise<BugDraft | null> {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { id: true, description: true, telegramLink: true },
  });
  if (!issue) return null;
  const [series, submission, postLink, photos] = await Promise.all([
    seriesRows(issue.id),
    prisma.issueSubmission.findFirst({
      where: { issueId: issue.id },
      orderBy: { createdAt: "asc" },
      select: { rawText: true, studentContact: true },
    }),
    submissionPostLink(issue.id),
    bugPhotoFileIds(issue.id),
  ]);
  const ai = await writeJiraBug({
    description: issue.description,
    curatorText: curatorTextFor(series, submission),
    team,
  });
  return {
    summary: taggedSummary(team, ai?.summary ?? issue.description),
    component: ai?.component ?? "",
    problem: ai?.problem ?? issue.description,
    steps: (ai?.steps ?? []).join("\n"),
    actual: ai?.actual ?? "",
    expected: ai?.expected ?? "",
    priority: ai?.priority ?? "medium",
    priorityReason: ai?.priorityReason ?? "",
    // Та же ссылка, что первой предлагается разработчику: сообщение со
    // скриншотом, если оно есть.
    telegramLink: linkOptionsFor(issue, series, postLink)[0] ?? null,
    photoCount: photos.length,
    aiFailed: ai === null,
  };
}

// Разработчик из DEV_TEAM_MEMBERS по имени, которое выбрали при передаче.
function devByName(team: EscalationTeam, name: string | null) {
  if (!name) return null;
  return teamMembers(team).find((m) => m.name === name.trim()) ?? null;
}

export async function rememberedJiraAccount(team: EscalationTeam, assigneeName: string | null): Promise<JiraUser | null> {
  const dev = devByName(team, assigneeName);
  if (!dev) return null;
  const row = await prisma.devJiraAccount.findUnique({ where: { telegramId: BigInt(dev.telegramId) } });
  return row ? { accountId: row.accountId, displayName: row.displayName } : null;
}

// Агент выбрал исполнителя бага для «нашего» разработчика — запоминаем,
// чтобы в следующий раз подставить самим.
export async function rememberJiraAccount(team: EscalationTeam, assigneeName: string | null, user: JiraUser): Promise<void> {
  const dev = devByName(team, assigneeName);
  if (!dev) return;
  await prisma.devJiraAccount.upsert({
    where: { telegramId: BigInt(dev.telegramId) },
    update: { accountId: user.accountId, displayName: user.displayName },
    create: { telegramId: BigInt(dev.telegramId), accountId: user.accountId, displayName: user.displayName },
  });
}
