import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { getFileDownloadUrl } from "@/lib/telegram";

type Params = { params: Promise<{ id: string }> };

// Сколько ждать файл от Telegram. Фото из формы сжаты до сотен КБ.
const FILE_TIMEOUT_MS = 10_000;

// Фото из обращения, поданного формой мини-аппа. Их может быть несколько —
// какое отдать, говорит ?i=N (нумерация с нуля, по умолчанию первое).
//
// Сами фото лежат в Telegram (у нас только file_id), и ссылка на них
// содержит токен бота — поэтому байты качает сервер и отдаёт агенту, а не
// редиректит браузер в Telegram.
//
// Каждый отказ пишем в лог с номером тикета: агент видит на карточке только
// «фото не загрузилось», и понять причину можно лишь отсюда. Саму ссылку и
// текст сетевой ошибки не логируем — в них может оказаться токен бота.
export async function GET(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.issueSubmission.findUnique({
    where: { issueId: id },
    select: { photoFileId: true, photoFileIds: true },
  });
  if (!submission) {
    return NextResponse.json({ error: "У тикета нет фото" }, { status: 404 });
  }

  // photoFileIds пуст у обращений, поданных до того, как фото стало
  // несколько, — там всё лежит в photoFileId.
  const fileIds =
    submission.photoFileIds.length > 0 ? submission.photoFileIds : [submission.photoFileId];
  const index = Number(request.nextUrl.searchParams.get("i") ?? "0");
  const fileId = Number.isInteger(index) ? fileIds[index] : undefined;
  if (!fileId) {
    return NextResponse.json({ error: "Такого фото у тикета нет" }, { status: 404 });
  }

  const unavailable = () =>
    NextResponse.json({ error: "Telegram не отдал фото — попробуйте позже" }, { status: 502 });

  // Причину отказа getFile (например, file_id от другого бота) уже написал
  // в лог callBotApi строкой [telegram] getFile.
  const url = await getFileDownloadUrl(fileId);
  if (!url) {
    console.warn(`[photo] тикет ${id}: getFile не дал ссылку на файл ${index}`);
    return unavailable();
  }

  let file: Response;
  try {
    file = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  } catch (err) {
    console.warn(
      `[photo] тикет ${id}: файл ${index} не скачался: ${err instanceof Error ? err.name : "ошибка"}`
    );
    return unavailable();
  }
  if (!file.ok || !file.body) {
    console.warn(`[photo] тикет ${id}: файловый сервер Telegram ответил ${file.status}`);
    return unavailable();
  }

  // Telegram может отдать файл без image/* типа; фото после sendPhoto — JPEG.
  const type = file.headers.get("content-type");
  return new Response(file.body, {
    headers: {
      "Content-Type": type?.startsWith("image/") ? type : "image/jpeg",
      // На фото данные учеников — только в браузере агента, без общих кэшей.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
