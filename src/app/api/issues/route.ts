import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { isIssueStatus } from "@/lib/status";
import { isEscalationTeam } from "@/lib/escalation";
import { cleanTicketDescription } from "@/lib/textClean";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate: date },
    orderBy: [{ position: "asc" }],
  });

  // Что бот успел написать в рабочие группы по этим тикетам — приезжает
  // вместе со списком, одним запросом на всю доску: иначе карточкам
  // пришлось бы ходить за этим по одной, а их за активный день несколько
  // десятков.
  const botReplies = await prisma.botReply.findMany({
    where: { issueId: { in: issues.map((i) => i.id) }, deleted: false },
    orderBy: { sentAt: "asc" },
  });
  const byIssue = new Map<string, typeof botReplies>();
  for (const reply of botReplies) {
    const list = byIssue.get(reply.issueId) ?? [];
    list.push(reply);
    byIssue.set(reply.issueId, list);
  }

  return NextResponse.json({
    issues: issues.map((issue) => ({
      ...issue,
      botReplies: byIssue.get(issue.id) ?? [],
    })),
  });
}

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  if (!body?.reportDate || !body?.groupName || !body?.description) {
    return NextResponse.json(
      { error: "reportDate, groupName and description are required" },
      { status: 400 }
    );
  }

  const last = await prisma.issue.findFirst({
    where: { reportDate: body.reportDate, groupName: body.groupName },
    orderBy: { position: "desc" },
  });

  const issue = await prisma.issue.create({
    data: {
      reportDate: body.reportDate,
      groupName: body.groupName,
      groupEmoji: body.groupEmoji ?? null,
      position: (last?.position ?? 0) + 1,
      description: cleanTicketDescription(body.description),
      telegramLink: body.telegramLink || null,
      status: isIssueStatus(body.status) ? body.status : "SENT",
      note: body.note || null,
      ticketLink: body.ticketLink || null,
      escalatedTeam: isEscalationTeam(body.escalatedTeam)
        ? body.escalatedTeam
        : null,
      escalatedAssignee: body.escalatedAssignee || null,
      createdBy: identity.name,
    },
  });

  return NextResponse.json({ issue }, { status: 201 });
}
