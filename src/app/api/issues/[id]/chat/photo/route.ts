import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { streamTelegramPhoto } from "@/lib/telegramPhoto";

type Params = { params: Promise<{ id: string }> };

// Фото, присланное куратором в переписке под тикетом (см. submissionChat.ts).
// Отдельно от GET /api/issues/[id]/photo: там фото самой заявки, здесь —
// фото конкретного сообщения переписки, поэтому нужен его id (?m=), а ?i=N
// выбирает одно из нескольких фото этого сообщения.
//
// Проверка «сообщение принадлежит этому тикету» обязательна: иначе по чужому
// id сообщения можно было бы вытащить фото из переписки по другому тикету.
export async function GET(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const messageId = request.nextUrl.searchParams.get("m");
  if (!messageId) {
    return NextResponse.json({ error: "Не указано сообщение" }, { status: 400 });
  }

  const chatMessage = await prisma.submissionMessage.findFirst({
    where: { id: messageId, submission: { issueId: id } },
    select: { photoFileIds: true },
  });
  if (!chatMessage) {
    return NextResponse.json({ error: "Сообщение не найдено" }, { status: 404 });
  }

  const index = Number(request.nextUrl.searchParams.get("i") ?? "0");
  const fileId =
    Number.isInteger(index) && index >= 0 ? chatMessage.photoFileIds[index] : undefined;
  if (!fileId) {
    return NextResponse.json({ error: "Такого фото нет" }, { status: 404 });
  }

  return streamTelegramPhoto(fileId, `переписка ${messageId}, фото ${index}`);
}
