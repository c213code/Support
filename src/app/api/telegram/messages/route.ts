import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { dayRangeUtc } from "@/lib/date";

export async function GET(request: NextRequest) {
  const archivedParam = request.nextUrl.searchParams.get("archived");
  const archived = archivedParam === "true";
  const date = request.nextUrl.searchParams.get("date");

  const where: Record<string, unknown> = { archived };
  if (date) {
    const { start, end } = dayRangeUtc(date);
    where.receivedAt = { gte: start, lt: end };
  }

  // Счётчику в шапке нужно только число — тянуть ради него до 200 полных
  // сообщений (с текстом) каждые 20 секунд смысла нет.
  if (request.nextUrl.searchParams.get("count") === "true") {
    const count = await prisma.telegramMessage.count({ where });
    return NextResponse.json({ count });
  }

  const messages = await prisma.telegramMessage.findMany({
    where,
    orderBy: { receivedAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ messages });
}
