import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Отметка "просмотрено" пачкой: во "Входящих" за раз становятся видны
// сразу все новые сообщения, и по одному PATCH на каждое — это десяток
// параллельных запросов и столько же UPDATE'ов на каждый разбор дня.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const ids: unknown = body?.ids;

  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    return NextResponse.json(
      { error: "ids must be an array of strings" },
      { status: 400 }
    );
  }
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, updated: 0 });
  }

  const { count } = await prisma.telegramMessage.updateMany({
    where: { id: { in: ids as string[] } },
    data: { viewed: true },
  });

  return NextResponse.json({ ok: true, updated: count });
}
