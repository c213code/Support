import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { isOfficialGroupName } from "@/lib/groups";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Params) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const existing = await prisma.telegramMessage.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (typeof body.archived === "boolean") data.archived = body.archived;
  if (typeof body.usedForIssueId === "string")
    data.usedForIssueId = body.usedForIssueId;

  // Присвоение группы вручную: запоминаем chatId -> группа на будущее,
  // чтобы следующие сообщения из этого чата подхватывались автоматически.
  // Привязка чата разрешена только к одной из 4 официальных групп —
  // личные чаты через этот механизм не заводятся.
  if (typeof body.groupName === "string" && body.groupName) {
    if (!isOfficialGroupName(body.groupName)) {
      return NextResponse.json(
        { error: "groupName must be one of the 4 official groups" },
        { status: 400 }
      );
    }

    const preset = await prisma.groupPreset.findUnique({
      where: { name: body.groupName },
    });

    data.groupName = body.groupName;
    data.groupEmoji = preset?.emoji ?? body.groupEmoji ?? null;

    if (preset) {
      // chatId уникален на GroupPreset — сначала освобождаем его у группы,
      // за которой он мог быть закреплён раньше по ошибке.
      await prisma.groupPreset.updateMany({
        where: { chatId: existing.chatId, NOT: { id: preset.id } },
        data: { chatId: null },
      });

      await prisma.groupPreset.update({
        where: { id: preset.id },
        data: { chatId: existing.chatId },
      });

      // Переносим все сообщения этого чата на верную группу — включая те,
      // что уже были ошибочно помечены другой группой раньше.
      await prisma.telegramMessage.updateMany({
        where: { chatId: existing.chatId },
        data: { groupName: preset.name, groupEmoji: preset.emoji },
      });
    }
  }

  const message = await prisma.telegramMessage.update({
    where: { id },
    data,
  });

  return NextResponse.json({ message });
}
