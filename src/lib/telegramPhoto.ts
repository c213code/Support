import { NextResponse } from "next/server";
import { getFileDownloadUrl } from "@/lib/telegram";

// Сколько ждать файл от Telegram. Фото из формы сжаты до сотен КБ.
const FILE_TIMEOUT_MS = 10_000;

// Какое фото отдать по номеру. У обращений, поданных до того, как фото стало
// несколько, photoFileIds пуст, а единственное фото лежит в photoFileId.
export function pickPhotoFileId(
  submission: { photoFileId: string; photoFileIds: string[] },
  index: number
): string | undefined {
  const fileIds =
    submission.photoFileIds.length > 0 ? submission.photoFileIds : [submission.photoFileId];
  return Number.isInteger(index) && index >= 0 ? fileIds[index] : undefined;
}

// Отдаёт фото из Telegram по file_id — общая часть маршрута для агентов
// (GET /api/issues/[id]/photo) и для куратора (POST /api/miniapp/photo).
//
// Ссылка на файл содержит токен бота, поэтому байты качает сервер и отдаёт
// сам, а не редиректит браузер в Telegram. Каждый отказ пишем в лог с
// контекстом: и агент, и куратор видят только «фото не загрузилось», причина
// есть лишь здесь. Саму ссылку и текст сетевой ошибки не логируем — в них
// может оказаться токен бота.
export async function streamTelegramPhoto(fileId: string, context: string): Promise<Response> {
  const unavailable = () =>
    NextResponse.json({ error: "Telegram не отдал фото — попробуйте позже" }, { status: 502 });

  // Причину отказа getFile (например, file_id от другого бота) уже написал
  // в лог callBotApi строкой [telegram] getFile.
  const url = await getFileDownloadUrl(fileId);
  if (!url) {
    console.warn(`[photo] ${context}: getFile не дал ссылку на файл`);
    return unavailable();
  }

  let file: Response;
  try {
    file = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) });
  } catch (err) {
    console.warn(
      `[photo] ${context}: файл не скачался: ${err instanceof Error ? err.name : "ошибка"}`
    );
    return unavailable();
  }
  if (!file.ok || !file.body) {
    console.warn(`[photo] ${context}: файловый сервер Telegram ответил ${file.status}`);
    return unavailable();
  }

  // Telegram может отдать файл без image/* типа; фото после sendPhoto — JPEG.
  const type = file.headers.get("content-type");
  return new Response(file.body, {
    headers: {
      "Content-Type": type?.startsWith("image/") ? type : "image/jpeg",
      // На фото данные учеников — только в браузере смотрящего, без общих кэшей.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
