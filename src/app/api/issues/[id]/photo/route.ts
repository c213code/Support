import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { pickPhotoFileId, streamTelegramPhoto } from "@/lib/telegramPhoto";

type Params = { params: Promise<{ id: string }> };

// Фото из обращения, поданного формой мини-аппа, — для агента на карточке
// доски и в окне тикета. Какое фото отдать, говорит ?i=N (с нуля).
export async function GET(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  // После склейки у тикета может быть несколько заявок. На карточке
  // показывается первая (самая ранняя) — её фото и отдаём.
  const submission = await prisma.issueSubmission.findFirst({
    where: { issueId: id },
    orderBy: { createdAt: "asc" },
    select: { photoFileId: true, photoFileIds: true },
  });
  if (!submission) {
    return NextResponse.json({ error: "У тикета нет фото" }, { status: 404 });
  }

  const index = Number(request.nextUrl.searchParams.get("i") ?? "0");
  const fileId = pickPhotoFileId(submission, index);
  if (!fileId) {
    return NextResponse.json({ error: "Такого фото у тикета нет" }, { status: 404 });
  }

  return streamTelegramPhoto(fileId, `тикет ${id}, фото ${index}`);
}
