import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const archivedParam = request.nextUrl.searchParams.get("archived");
  const archived = archivedParam === "true";

  const messages = await prisma.telegramMessage.findMany({
    where: { archived },
    orderBy: { receivedAt: "desc" },
    take: 200,
  });

  return NextResponse.json({ messages });
}
