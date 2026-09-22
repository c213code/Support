import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { isAgentTelegramId } from "@/lib/agentTelegram";
import { deleteTelegramMessage } from "@/lib/telegram";

// Удаление обращения из мини-аппа.
//
// Право разное у своих и у кураторов, и это не формальность:
//
// • дежурный (его Telegram-id в AGENT_TELEGRAM_IDS/OWN_AGENT_TELEGRAM_IDS) —
//   удаляет любое обращение, как и кнопкой на доске;
// • куратор — только своё и только пока его никто не взял (статус SENT).
//   Дальше удаление стёрло бы чужую работу: заметку дежурного, переписку и
//   строку в репорте руководству за день, где тикет уже посчитан.
//
// Удаляется сам тикет — заявка, переписка и ответы бота уходят за ним
// каскадом (см. внешние ключи в schema.prisma).
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) {
    return NextResponse.json({ error: "Форма әзірге өшірулі" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as {
    initData?: unknown;
    submissionId?: unknown;
  } | null;

  const check = verifyInitData(typeof body?.initData === "string" ? body.initData : "");
  if (!check.ok) {
    return NextResponse.json({ error: "Форманы боттан қайта ашыңыз" }, { status: 401 });
  }

  const submissionId = typeof body?.submissionId === "string" ? body.submissionId : "";
  const submission = await prisma.issueSubmission.findUnique({
    where: { id: submissionId },
    select: {
      id: true,
      telegramUserId: true,
      issueId: true,
      issue: { select: { status: true } },
    },
  });
  // Нет такого обращения и чужое обращение для куратора — один и тот же
  // ответ: по коду ошибки нельзя узнать, существует ли чужая заявка.
  const agent = isAgentTelegramId(check.user.id);
  const own = submission?.telegramUserId === check.user.id;
  if (!submission || (!agent && !own)) {
    return NextResponse.json({ error: "Өтініш табылмады" }, { status: 404 });
  }
  if (!agent && submission.issue.status !== "SENT") {
    return NextResponse.json(
      { error: "Өтініш жұмысқа алынған — кезекшіге жазыңыз" },
      { status: 409 }
    );
  }

  // Сообщения бота об этом обращении в рабочей группе забираем ДО удаления:
  // вместе с тикетом строки уйдут каскадом, и убрать их из чата будет уже
  // нечем — в группе осталась бы заявка, которой больше нет.
  const botReplies = await prisma.botReply.findMany({
    where: { issueId: submission.issueId, deleted: false },
    select: { chatId: true, messageId: true },
  });

  await prisma.$transaction([
    // Связь TelegramMessage -> Issue держится без внешнего ключа (см. DELETE
    // /api/issues/[id]) — чистим руками, иначе сообщение во «Входящих»
    // останется со ссылкой в никуда.
    prisma.telegramMessage.updateMany({
      where: { usedForIssueId: submission.issueId },
      data: { usedForIssueId: null },
    }),
    prisma.issue.delete({ where: { id: submission.issueId } }),
  ]);

  // Telegram разрешает удалять свои сообщения только 48 часов — дальше
  // молча не выйдет, и это нормально: тикета уже нет, а сообщение в группе
  // останется частью переписки.
  for (const reply of botReplies) {
    await deleteTelegramMessage(reply.chatId, reply.messageId);
  }

  console.warn(
    `[miniapp] обращение ${submission.id} удалено (${agent ? "агент" : "автор"} ${check.user.id})`
  );
  return NextResponse.json({ ok: true });
}
