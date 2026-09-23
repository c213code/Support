import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { streamTelegramPhoto } from "@/lib/telegramPhoto";

// Фото из черновика (пересылка или сообщение боту) — форме, пока обращение
// не подано: куратор видит, что именно приложится, и не досылает то же
// самое второй раз. Только свои: черновик ищется по подписи Telegram, а не
// по номеру в теле запроса.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) {
    return NextResponse.json({ error: "Форма әзірге өшірулі" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as {
    initData?: unknown;
    index?: unknown;
  } | null;
  const check = verifyInitData(typeof body?.initData === "string" ? body.initData : "");
  if (!check.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const draft = await prisma.forwardDraft.findUnique({
    where: { telegramUserId: check.user.id },
    select: { photoFileIds: true },
  });
  const index = typeof body?.index === "number" ? body.index : -1;
  const fileId = draft?.photoFileIds[index];
  if (!fileId) return NextResponse.json({ error: "Сурет жоқ" }, { status: 404 });

  return streamTelegramPhoto(fileId, `черновик ${check.user.id}, фото ${index}`);
}
