import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

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
  if (typeof body.groupName === "string" && body.groupName) {
    const preset = await prisma.groupPreset.findUnique({
      where: { name: body.groupName },
    });

    data.groupName = body.groupName;
    data.groupEmoji = preset?.emoji ?? body.groupEmoji ?? null;

    if (preset) {
      await prisma.groupPreset.update({
        where: { id: preset.id },
        data: { chatId: existing.chatId },
      });

      await prisma.telegramMessage.updateMany({
        where: { chatId: existing.chatId, groupName: null },
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
