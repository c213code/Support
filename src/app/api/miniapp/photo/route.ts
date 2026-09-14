import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { pickPhotoFileId, streamTelegramPhoto } from "@/lib/telegramPhoto";

// Фото из обращения — для самого куратора, в списке «Менің өтініштерім».
//
// Отдельно от маршрута для агентов: там доступ по сессии сайта, здесь — по
// подписи Telegram, и отдаём фото строго из заявок того, кто спрашивает.
// POST — чтобы подпись не оседала в логах вместе с адресом; поэтому <img src>
// тут не годится, клиент берёт байты запросом и показывает их через blob.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) {
    return NextResponse.json({ error: "Форма әзірге өшірулі" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const initData = typeof body?.initData === "string" ? body.initData.slice(0, 8192) : "";
  const submissionId = typeof body?.submissionId === "string" ? body.submissionId : "";
  const index = typeof body?.index === "number" ? body.index : -1;

  const check = verifyInitData(initData);
  if (!check.ok) {
    console.warn(`[miniapp] фото куратору: initData отклонена: ${check.reason}`);
    return NextResponse.json({ error: "Форманы боттан қайта ашыңыз" }, { status: 401 });
  }

  const submission = submissionId
    ? await prisma.issueSubmission.findUnique({
        where: { id: submissionId },
        select: { telegramUserId: true, photoFileId: true, photoFileIds: true },
      })
    : null;
  // Чужую заявку не отдаём и даже не подтверждаем, что она существует: на
  // «нет такой» и «не твоя» — один и тот же ответ.
  if (!submission || submission.telegramUserId !== check.user.id) {
    return NextResponse.json({ error: "Фото табылмады" }, { status: 404 });
  }

  const fileId = pickPhotoFileId(submission, index);
  if (!fileId) {
    return NextResponse.json({ error: "Фото табылмады" }, { status: 404 });
  }

  return streamTelegramPhoto(fileId, `заявка ${submissionId}, фото ${index}`);
}
