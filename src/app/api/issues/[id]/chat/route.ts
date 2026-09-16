import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { loadIssueThreads, markThreadRead, sendToCurator } from "@/lib/submissionChat";

type Params = { params: Promise<{ id: string }> };

// Переписка с куратором под тикетом: дежурный пишет отсюда, куратору это
// приходит от бота в личку (см. lib/submissionChat.ts).

export async function GET(_request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const threads = await loadIssueThreads(id);
  // Открыл переписку — значит, ответы прочитаны и метка «новый ответ» на
  // карточке больше не нужна. Отдельной кнопки «прочитано» нет намеренно:
  // лишнее действие ради того, что и так очевидно из открытого окна.
  await markThreadRead(id);

  return NextResponse.json({ threads, status: await issueStatus(id) });
}

// Статус отдаётся вместе с перепиской, потому что ответ куратора его меняет
// (решённый тикет возвращается в работу). Без этого открытое окно тикета
// показывало бы прежний статус до перезахода — человек видел новый ответ и
// старый статус одновременно.
async function issueStatus(issueId: string) {
  const issue = await prisma.issue.findUnique({
    where: { id: issueId },
    select: { status: true },
  });
  return issue?.status ?? null;
}

export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  const submissionId = typeof body?.submissionId === "string" ? body.submissionId : null;
  const text = typeof body?.text === "string" ? body.text : "";
  if (!submissionId || !text.trim()) {
    return NextResponse.json({ error: "Нужны обращение и текст" }, { status: 400 });
  }

  // Автор сообщения — из сессии, как и везде: клиент имя не присылает и не
  // может подписаться чужим. Куратор его всё равно не видит (для него пишет
  // бот), оно нужно на сайте и чтобы знать, кому нести ответ.
  const result = await sendToCurator({
    submissionId,
    text,
    authorName: identity.name,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  const threads = await loadIssueThreads(id);
  return NextResponse.json({ threads, status: await issueStatus(id) });
}
