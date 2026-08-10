import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Снимает привязку "чат -> группа" только у ОДНОЙ группы — не у всех
// четырёх разом, как было раньше. Один клик сбрасывал chatId у всех групп
// сразу (и groupName у вообще всех неразобранных сообщений, включая чужие
// чаты), из-за чего однажды слетела вся привязка целиком, хотя чинить
// нужно было только одну ошибочно привязанную группу. Теперь — только
// выбранная группа и только сообщения из её чата.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const groupName = body?.groupName;
  if (typeof groupName !== "string" || !groupName) {
    return NextResponse.json({ error: "groupName is required" }, { status: 400 });
  }

  const preset = await prisma.groupPreset.findUnique({ where: { name: groupName } });
  if (!preset) {
    return NextResponse.json({ error: "group not found" }, { status: 404 });
  }
  if (!preset.chatId) {
    return NextResponse.json({ ok: true });
  }

  await prisma.$transaction([
    prisma.groupPreset.update({
      where: { id: preset.id },
      data: { chatId: null },
    }),
    prisma.telegramMessage.updateMany({
      where: { chatId: preset.chatId, archived: false },
      data: { groupName: null, groupEmoji: null },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
