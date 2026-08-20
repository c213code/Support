import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { isIssueStatus } from "@/lib/status";
import { isEscalationTeam } from "@/lib/escalation";
import { cleanTicketDescription } from "@/lib/textClean";
import { extractTicketHints } from "@/lib/ticketHints";

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

  // Почта/телефон ученика и факт вложения — то, что чистка описания
  // намеренно выкидывает (в репорт боссам это не нужно), но без чего
  // агенту не за что зацепиться, чтобы начать работу. Тянем сырые тексты
  // всех привязанных к тикету сообщений одним запросом.
  //
  // Ищем по usedForIssueId, а не по списку ссылок: уточнения (присланная
  // почта, дописанные подробности) привязываются к тикету, но ссылку на
  // карточку намеренно не добавляют — она там значит "ещё одно отдельное
  // обращение по той же проблеме" (см. ATTACH_LINK_POLICY в вебхуке). По
  // ссылкам такие сообщения не нашлись бы, и присланная почта пропала бы с
  // карточки. telegramLink добавлен к запросу отдельно: у тикета, заведённого
  // руками по вставленной ссылке, привязанного сообщения может не быть.
  const issueIds = issues.map((i) => i.id);
  const allLinks = issues.flatMap((i) => [i.telegramLink, ...i.extraLinks]).filter(
    (l): l is string => l != null
  );
  const sources = await prisma.telegramMessage.findMany({
    where: {
      OR: [
        { usedForIssueId: { in: issueIds } },
        ...(allLinks.length ? [{ messageLink: { in: allLinks } }] : []),
      ],
    },
    select: { messageLink: true, text: true, usedForIssueId: true },
  });

  const textByLink = new Map(sources.map((s) => [s.messageLink, s.text]));
  const textsByIssue = new Map<string, Array<string | null>>();
  for (const source of sources) {
    if (!source.usedForIssueId) continue;
    const list = textsByIssue.get(source.usedForIssueId) ?? [];
    list.push(source.text);
    textsByIssue.set(source.usedForIssueId, list);
  }

  return NextResponse.json({
    issues: issues.map((issue) => ({
      ...issue,
      botReplies: byIssue.get(issue.id) ?? [],
      // Одно и то же сообщение может попасть в оба списка (привязано и
      // указано ссылкой) — extractTicketHints складывает почты/телефоны в
      // Set, поэтому дубликаты безвредны.
      hints: extractTicketHints([
        ...(textsByIssue.get(issue.id) ?? []),
        ...[issue.telegramLink, ...issue.extraLinks].map((l) =>
          l ? (textByLink.get(l) ?? null) : null
        ),
      ]),
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
