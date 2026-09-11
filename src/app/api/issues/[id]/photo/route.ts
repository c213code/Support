import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { getFileDownloadUrl } from "@/lib/telegram";

type Params = { params: Promise<{ id: string }> };

// Фото из обращения, поданного формой мини-аппа. Само фото лежит в Telegram
// (у нас только file_id), и ссылка на него содержит токен бота — поэтому
// байты качает сервер и отдаёт агенту, а не редиректит браузер в Telegram.
export async function GET(_request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const submission = await prisma.issueSubmission.findUnique({
    where: { issueId: id },
    select: { photoFileId: true },
  });
  if (!submission) {
    return NextResponse.json({ error: "У тикета нет фото" }, { status: 404 });
  }

  const url = await getFileDownloadUrl(submission.photoFileId);
  const file = url ? await fetch(url).catch(() => null) : null;
  if (!file?.ok || !file.body) {
    return NextResponse.json(
      { error: "Telegram не отдал фото — попробуйте позже" },
      { status: 502 }
    );
  }

  // Telegram отдаёт файлы как application/octet-stream; фото после sendPhoto
  // всегда JPEG.
  const type = file.headers.get("content-type");
  return new Response(file.body, {
    headers: {
      "Content-Type": type?.startsWith("image/") ? type : "image/jpeg",
      // На фото данные учеников — только в браузере агента, без общих кэшей.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
