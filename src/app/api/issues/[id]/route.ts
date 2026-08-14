import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { isIssueStatus, type IssueStatus } from "@/lib/status";
import { isEscalationTeam } from "@/lib/escalation";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";
import { reactToStatusChange } from "@/lib/issueStatus";
import { cleanTicketDescription } from "@/lib/textClean";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  // Ручное редактирование описания тоже должно проходить через автоочистку —
  // иначе приветствия/логины/ссылки, которые не убрали при авто-создании
  // тикета (например, он завёлся до фичи), так и остаются висеть навсегда,
  // потому что PATCH — единственное место, где агент вообще трогает текст
  // уже существующего тикета.
  if (typeof body.description === "string")
    data.description = cleanTicketDescription(body.description);
  if (typeof body.telegramLink === "string" || body.telegramLink === null)
    data.telegramLink = body.telegramLink || null;
  if (isIssueStatus(body.status)) data.status = body.status;
  if (typeof body.note === "string" || body.note === null)
    data.note = body.note || null;
  if (typeof body.ticketLink === "string" || body.ticketLink === null)
    data.ticketLink = body.ticketLink || null;
  if (typeof body.position === "number") data.position = body.position;
  if (typeof body.groupName === "string") data.groupName = body.groupName;
  if (typeof body.groupEmoji === "string" || body.groupEmoji === null)
    data.groupEmoji = body.groupEmoji || null;
  if (isEscalationTeam(body.escalatedTeam) || body.escalatedTeam === null)
    data.escalatedTeam = body.escalatedTeam || null;
  if (
    typeof body.escalatedAssignee === "string" ||
    body.escalatedAssignee === null
  )
    data.escalatedAssignee = body.escalatedAssignee || null;

  const existing = await prisma.issue.findUnique({
    where: { id },
    select: { createdBy: true, status: true, telegramLink: true },
  });

  // Тикет завёл бот сам (по входящему сообщению) — как только с ним
  // впервые что-то делает живой агент (меняет статус, правит текст и т.д.),
  // забираем авторство на него, чтобы "Бот" не висел вечно.
  const identity = await getCurrentIdentity();
  if (identity && existing?.createdBy === AUTO_ISSUE_CREATOR) {
    data.createdBy = identity.name;
  }

  const issue = await prisma.issue.update({ where: { id }, data });

  // Смена статуса — реакцией на исходное сообщение в Telegram (👀 взяли в
  // работу/пендинг/передали, 👍 решили), чтобы было видно прямо в чате.
  // "Отправлено" реакции не ставит (см. STATUS_META.SENT.reactionEmoji).
  // Та же функция используется при смене статуса inline-кнопкой в
  // Telegram (см. handleCallbackQuery в вебхуке) — чтобы оба места не
  // разъезжались логикой.
  if (typeof data.status === "string" && existing) {
    await reactToStatusChange(
      existing.status,
      data.status as IssueStatus,
      existing.telegramLink,
      "app",
      id
    );
  }

  return NextResponse.json({ issue });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  // Связь TelegramMessage -> Issue держится только по id (без внешнего ключа),
  // так что чистим её сами. Иначе во "Входящих" у сообщения так и остаётся
  // кнопка "Тикет заведён автоматически — изменить", которая ведёт в
  // никуда, и завести тикет заново уже нельзя.
  await prisma.$transaction([
    prisma.telegramMessage.updateMany({
      where: { usedForIssueId: id },
      data: { usedForIssueId: null },
    }),
    prisma.issue.delete({ where: { id } }),
  ]);
  return NextResponse.json({ ok: true });
}
