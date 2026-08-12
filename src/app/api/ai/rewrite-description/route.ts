import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { rewriteTicketDescriptionWithAI, isAiSkip } from "@/lib/ai";

// Ручной вызов ИИ-переписывания из формы тикета — кнопка "✨ ИИ напишет"
// рядом с полем описания (см. IssueForm.tsx). В отличие от автоматической
// чистки в вебхуке (тогл "aiCleaningEnabled", см. lib/settings.ts) — это
// разовое явное действие агента, не зависит от тогла: тот решает, включать
// ли ИИ для новых входящих сообщений, а это "попроси ИИ прямо сейчас".
// Агент вставляет в описание сырой текст (скопировал из Telegram, куда бот
// не подключён) и просит переписать в стиле тикета вместо того, чтобы
// сокращать вручную.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const text = body?.text;
  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ result: null, unavailable: true });
  }

  const result = await rewriteTicketDescriptionWithAI(text);
  if (result === null) {
    return NextResponse.json({ result: null, unavailable: true });
  }
  if (isAiSkip(result)) {
    return NextResponse.json({ result: null, skip: true });
  }

  return NextResponse.json({ result });
}
