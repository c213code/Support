import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isEscalationTeam } from "@/lib/escalation";
import { jiraTeamTag, prepareBugDraft, rememberedJiraAccount } from "@/lib/jiraBug";

type Params = { params: Promise<{ id: string }> };

// Черновик бага: ИИ пишет заголовок и разделы шаблона, плюс исполнитель в
// Jira, если для выбранного разработчика его уже запомнили. Ничего не
// создаёт — создаёт POST /api/issues/[id]/jira после правки человеком.
export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!isEscalationTeam(body?.team) || !jiraTeamTag(body.team)) {
    return NextResponse.json({ error: "Для этой команды баги в Jira не заводятся" }, { status: 400 });
  }
  const assignee = typeof body?.assignee === "string" ? body.assignee : null;
  const [draft, account] = await Promise.all([
    prepareBugDraft(id, body.team),
    rememberedJiraAccount(body.team, assignee),
  ]);
  if (!draft) return NextResponse.json({ error: "Тикет не найден" }, { status: 404 });
  return NextResponse.json({ draft, account });
}
