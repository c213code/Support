import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";

// Черновик из пересланной переписки — форме при открытии.
//
// Отдаём текст и число фото, а не сами file_id: они нужны только серверу
// (по ним фото уходят в тикет), а на телефоне по ним всё равно ничего не
// сделать. Сами картинки форма показывает через /api/miniapp/draft-photo.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) return NextResponse.json({ draft: null });

  const body = (await request.json().catch(() => null)) as { initData?: unknown } | null;
  const check = verifyInitData(typeof body?.initData === "string" ? body.initData : "");
  if (!check.ok) {
    return NextResponse.json({ error: "Форманы боттан қайта ашыңыз" }, { status: 401 });
  }

  const draft = await prisma.forwardDraft.findUnique({
    where: { telegramUserId: check.user.id },
    select: { text: true, photoFileIds: true, updatedAt: true },
  });
  if (!draft) return NextResponse.json({ draft: null });

  return NextResponse.json({
    draft: {
      text: draft.text,
      photoCount: draft.photoFileIds.length,
      updatedAt: draft.updatedAt.toISOString(),
    },
  });
}

// Куратор передумал — черновик убирается, и форма открывается чистой.
export async function DELETE(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { initData?: unknown } | null;
  const check = verifyInitData(typeof body?.initData === "string" ? body.initData : "");
  if (!check.ok) {
    return NextResponse.json({ error: "Форманы боттан қайта ашыңыз" }, { status: 401 });
  }
  await prisma.forwardDraft.deleteMany({ where: { telegramUserId: check.user.id } });
  return NextResponse.json({ ok: true });
}
