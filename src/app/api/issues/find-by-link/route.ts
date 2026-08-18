import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Telegram Desktop иногда даёт ссылку с хвостом ("?single") или конечным
// слэшем, а сохраняем мы её в чистом виде (см. buildMessageLink в
// lib/telegram.ts) — без нормализации совпадение бы не находилось.
function normalizeLink(raw: string): string {
  return raw.trim().split("?")[0].replace(/\/+$/, "");
}

// Ищет тикет по ссылке на Telegram-сообщение вне зависимости от даты
// репорта — доска (`/inbox`) показывает один день, а ссылку, с которой
// заводили тикет, коллега может принести спустя недели. telegramLink —
// ссылка, с которой тикет завёлся, extraLinks — приклеенные повторные
// обращения по тому же запросу (см. схему).
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("link");
  if (!raw) {
    return NextResponse.json({ error: "link is required" }, { status: 400 });
  }
  const link = normalizeLink(raw);
  if (!link) {
    return NextResponse.json({ issue: null });
  }

  const issue = await prisma.issue.findFirst({
    where: { OR: [{ telegramLink: link }, { extraLinks: { has: link } }] },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ issue });
}
