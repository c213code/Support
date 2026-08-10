import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanTicketDescription } from "@/lib/textClean";

type Params = { params: Promise<{ id: string }> };

// Для тикета с описанием, переписанным ИИ (см. lib/ai.ts), даёт агенту
// путь назад: исходное Telegram-сообщение плюс та же regex-чистка
// (lib/textClean.ts), что применяется, когда ИИ выключен. Если ИИ
// сформулировал не то — можно вернуться к предсказуемому варианту без
// ИИ и уже от него писать своими словами, а не вычищать чужой текст
// руками.
//
// Раздельного поля с "сырым" текстом на Issue нет: телеграм-сообщение,
// из которого тикет завёлся, находится по совпадению telegramLink с его
// messageLink — та же связь, что использует attach-message/merge-into.
export async function GET(_request: NextRequest, { params }: Params) {
  const { id } = await params;
  const issue = await prisma.issue.findUnique({
    where: { id },
    select: { telegramLink: true },
  });
  if (!issue) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }
  if (!issue.telegramLink) {
    return NextResponse.json({ raw: null, regexCleaned: null });
  }

  const message = await prisma.telegramMessage.findFirst({
    where: { messageLink: issue.telegramLink },
    select: { text: true },
  });
  if (!message?.text) {
    return NextResponse.json({ raw: null, regexCleaned: null });
  }

  return NextResponse.json({
    raw: message.text,
    regexCleaned: cleanTicketDescription(message.text),
  });
}
