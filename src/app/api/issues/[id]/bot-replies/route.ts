import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import {
  editBotReply,
  deleteBotReply,
  describeBotReplyFailure,
} from "@/lib/botReply";

type Params = { params: Promise<{ id: string }> };

// Что бот написал в рабочую группу по этому тикету — показывается на
// карточке тикета, чтобы было видно, что уже сказано коллегам, и можно
// было это поправить или снять.
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const replies = await prisma.botReply.findMany({
    where: { issueId: id },
    orderBy: { sentAt: "asc" },
  });
  return NextResponse.json({ replies });
}

// Правка или удаление конкретного ответа бота. Правка — вариант по
// умолчанию: удаление ничего не исправляет для того, кто уже прочитал, а
// правку человек хотя бы увидит (Telegram пометит "изменено") и тред с
// реплаем не порвётся.
export async function POST(request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await params;
  const body = await request.json().catch(() => null);
  if (typeof body?.replyId !== "string") {
    return NextResponse.json({ error: "replyId is required" }, { status: 400 });
  }

  const result =
    body.action === "delete"
      ? await deleteBotReply(body.replyId)
      : typeof body.text === "string" && body.text.trim()
        ? await editBotReply(body.replyId, body.text.trim())
        : null;

  if (result === null) {
    return NextResponse.json(
      { error: "нужен text для правки или action: \"delete\"" },
      { status: 400 }
    );
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: describeBotReplyFailure(result.reason) },
      { status: 409 }
    );
  }

  return NextResponse.json({ ok: true });
}
