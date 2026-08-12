import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { dayRangeUtc } from "@/lib/date";
import { buildDescription } from "@/lib/ticketDescription";

// Разовая перепроверка "Входящих" за день кнопкой "🔍 Найти пропущенные
// тикеты" в /inbox. Ловит сообщения, у которых уже известна группа
// (иначе просто дальше живут во "Входящих" — группу выбирают вручную), но
// тикет по ним так и не завёлся. Реальная причина такого разрыва — не
// только сбой ИИ (при нём и так тихо откатывается на regex, см.
// buildDescription): чаще это ручная привязка чата задним числом —
// PATCH /api/telegram/messages/[id] проставляет groupName пачкой всем
// накопленным сообщениям чата, но тикеты за них не создаёт, это было
// осознанно оставлено на "Создать тикет" вручную по каждому. Прогоняет
// каждое такое сообщение через ту же логику, что и вебхук в моменте
// получения, и предлагает завести тикет тем, что теперь проходит.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const reportDate = body?.reportDate;
  if (typeof reportDate !== "string" || !reportDate) {
    return NextResponse.json({ error: "reportDate is required" }, { status: 400 });
  }

  const { start, end } = dayRangeUtc(reportDate);
  const messages = await prisma.telegramMessage.findMany({
    where: {
      archived: false,
      usedForIssueId: null,
      groupName: { not: null },
      receivedAt: { gte: start, lt: end },
    },
    orderBy: { receivedAt: "asc" },
  });

  const results = await Promise.all(
    messages
      .filter((m) => m.text)
      .map(async (message) => ({
        message,
        suggested: await buildDescription(message.text as string, message.text as string),
      }))
  );

  const missed = results
    .filter((r): r is { message: (typeof messages)[number]; suggested: string } => r.suggested !== null)
    .map((r) => ({ message: r.message, suggested: r.suggested }));

  return NextResponse.json({ missed });
}
