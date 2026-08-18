import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";

type Params = { params: Promise<{ id: string }> };

// Приклеивает ещё одно Telegram-сообщение к уже существующему тикету:
// один и тот же запрос часто приходит несколько раз (три человека просят
// один и тот же доступ) — это один тикет с несколькими ссылками-пруфами, а
// не три карточки на доске.
export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.messageId !== "string") {
    return NextResponse.json(
      { error: "messageId is required" },
      { status: 400 }
    );
  }

  const [issue, message] = await Promise.all([
    prisma.issue.findUnique({ where: { id } }),
    prisma.telegramMessage.findUnique({ where: { id: body.messageId } }),
  ]);

  if (!issue) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }
  if (!message) {
    return NextResponse.json({ error: "message not found" }, { status: 404 });
  }

  // Ссылка уже на карточке — второй раз не добавляем (повторный клик или
  // сообщение, которое и породило этот тикет).
  const alreadyLinked =
    issue.telegramLink === message.messageLink ||
    issue.extraLinks.includes(message.messageLink);

  // Сообщение уже приклеено к ДРУГОМУ тикету — без этой проверки повторное
  // "Прикрепить" молча перецепляет usedForIssueId сюда, а старый тикет
  // продолжает показывать ту же ссылку как свою: на доске появляются два
  // тикета с одинаковой ссылкой на сообщение, один из которых теперь врёт.
  // Сначала нужно отвязать сообщение от прежнего тикета (кнопка "✕" на
  // карточке) — это осознанное действие, а не побочный эффект клика по
  // другому тикету.
  if (
    !alreadyLinked &&
    message.usedForIssueId &&
    message.usedForIssueId !== id
  ) {
    return NextResponse.json(
      { error: "message is already attached to another issue" },
      { status: 409 }
    );
  }

  // Пикер ранжирует тикеты по похожести текста без учёта группы (см.
  // AttachToIssuePicker) — сообщение из чата "IT & Product" может оказаться
  // визуально похоже на старый тикет из "Әдістеме & IT" и попасть наверх
  // списка. Группа известна только когда чат уже привязан к пресету
  // (message.groupName) — для ещё неразобранных сообщений её нет, и туда
  // можно приклеивать куда угодно, как и раньше.
  if (message.groupName && message.groupName !== issue.groupName) {
    return NextResponse.json(
      { error: "message belongs to a different group" },
      { status: 400 }
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const nextIssue = await tx.issue.update({
      where: { id },
      data: {
        extraLinks: alreadyLinked
          ? undefined
          : { push: message.messageLink },
        // Тикет тронул живой агент — забираем авторство у бота, как и при
        // любом другом действии над авто-тикетом.
        createdBy:
          issue.createdBy === AUTO_ISSUE_CREATOR ? identity.name : undefined,
      },
    });

    // Сообщение разобрано: уходит из ленты "Входящих" и больше не
    // предлагает завести по себе отдельный тикет.
    await tx.telegramMessage.update({
      where: { id: message.id },
      data: { usedForIssueId: id, archived: true, viewed: true },
    });

    return nextIssue;
  });

  return NextResponse.json({ issue: updated });
}

// Отвязать ссылку от тикета — приклеить не туда легко, и без отката это
// пришлось бы чинить руками в базе. Сообщение при этом возвращается во
// "Входящие" неразобранным, чтобы его можно было завести заново.
export async function DELETE(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.link !== "string") {
    return NextResponse.json({ error: "link is required" }, { status: 400 });
  }

  const issue = await prisma.issue.findUnique({ where: { id } });
  if (!issue) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const nextIssue = await tx.issue.update({
      where: { id },
      data: { extraLinks: issue.extraLinks.filter((l) => l !== body.link) },
    });

    await tx.telegramMessage.updateMany({
      where: { messageLink: body.link, usedForIssueId: id },
      data: { usedForIssueId: null, archived: false },
    });

    return nextIssue;
  });

  return NextResponse.json({ issue: updated });
}
