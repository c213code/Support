import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Полный сброс автоматической привязки "чат -> группа": снимает chatId
// со всех 4 официальных групп и убирает groupName у ещё не разобранных
// (неархивированных) сообщений — чтобы начать распределение по группам
// заново, если где-то в начале выбрали не ту группу и это разошлось на
// все сообщения из того же чата.
export async function POST() {
  await prisma.groupPreset.updateMany({ data: { chatId: null } });
  await prisma.telegramMessage.updateMany({
    where: { archived: false },
    data: { groupName: null, groupEmoji: null },
  });

  return NextResponse.json({ ok: true });
}
