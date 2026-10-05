import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { isEscalationTeam } from "@/lib/escalation";
import { createJiraBug, jiraConfigured, JiraError } from "@/lib/jira";
import type { JiraPriority } from "@/lib/ai";
import { bugPhotoFileIds, jiraTeamTag, rememberJiraAccount, taggedSummary } from "@/lib/jiraBug";

type Params = { params: Promise<{ id: string }> };

const isPriority = (v: unknown): v is JiraPriority =>
  v === "low" || v === "medium" || v === "high" || v === "critical";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// Создаёт баг в Jira по черновику, который человек посмотрел и поправил, и
// ставит ссылку на него в тикет (ticketLink) — дальше она уходит и в
// сообщение разработчику, и в репорт.
export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!jiraConfigured()) {
    return NextResponse.json({ error: "Jira не настроена: нет JIRA_EMAIL / JIRA_API_TOKEN" }, { status: 400 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!isEscalationTeam(body?.team) || !jiraTeamTag(body.team)) {
    return NextResponse.json({ error: "Для этой команды баги в Jira не заводятся" }, { status: 400 });
  }
  const summary = str(body.summary, 250);
  const problem = str(body.problem, 5000);
  if (!summary || !problem) {
    return NextResponse.json({ error: "Нужны заголовок и описание проблемы" }, { status: 400 });
  }

  const issue = await prisma.issue.findUnique({ where: { id }, select: { ticketLink: true } });
  if (!issue) return NextResponse.json({ error: "Тикет не найден" }, { status: 404 });
  // Второй баг на тот же тикет — почти всегда двойное нажатие.
  if (issue.ticketLink) {
    return NextResponse.json({ error: `У тикета уже есть задача в Jira: ${issue.ticketLink}` }, { status: 409 });
  }

  const accountId = str(body.accountId, 128) || null;
  const displayName = str(body.displayName, 128);
  try {
    const created = await createJiraBug({
      fields: {
        summary: taggedSummary(body.team, summary),
        component: str(body.component, 300),
        problem,
        // Шаги приходят построчно из одного поля; «1.», «2)» в начале строки
        // убираем — нумерует сам список в Jira.
        steps: str(body.steps, 3000)
          .split("\n")
          .map((line) => line.replace(/^\s*\d+[.)]\s*/, "").trim())
          .filter(Boolean)
          .slice(0, 15),
        actual: str(body.actual, 3000),
        expected: str(body.expected, 3000),
        priority: isPriority(body.priority) ? body.priority : "medium",
        telegramLink: str(body.telegramLink, 300) || null,
      },
      assigneeAccountId: accountId,
      photoFileIds: await bugPhotoFileIds(id),
    });
    await prisma.issue.update({ where: { id }, data: { ticketLink: created.url } });
    if (accountId && displayName) {
      await rememberJiraAccount(body.team, str(body.assignee, 100) || null, { accountId, displayName });
    }
    return NextResponse.json({ created });
  } catch (err) {
    const message = err instanceof JiraError ? err.message : "Не получилось создать баг";
    console.warn(`[jira] баг по тикету ${id} не создан: ${message.slice(0, 300)}`);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
