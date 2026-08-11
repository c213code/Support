import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { rewriteTicketDescriptionWithAI, isAiSkip } from "@/lib/ai";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";

// Разовая ручная перепроверка тикетов "Отправлено", заведённых ботом (см.
// AUTO_ISSUE_CREATOR) без участия агента, регуляркой (ИИ был выключен,
// упал по таймауту или квоте — см. GROQ daily TPD limit). Заводит ту же
// пару вопросов, что и живой ИИ при заведении тикета: (1) это вообще
// обращение ученика/родителя, а не рабочая переписка коллег (SKIP) — тогда
// это кандидат на удаление, ложное срабатывание regex-чистки; (2) если
// обращение настоящее, можно ли описание сформулировать короче/точнее.
// Как и "🤖 Найти дубли" — только подсказка, ничего не удаляет и не
// переписывает само: агент решает по каждому тикету через кнопки в
// /inbox.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const reportDate = body?.reportDate;
  if (typeof reportDate !== "string" || !reportDate) {
    return NextResponse.json({ error: "reportDate is required" }, { status: 400 });
  }

  if (!process.env.GROQ_API_KEY) {
    return NextResponse.json({ falsePositives: [], improvements: [], unavailable: true });
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate, status: "SENT", createdBy: AUTO_ISSUE_CREATOR },
    orderBy: { position: "asc" },
  });
  if (issues.length === 0) {
    return NextResponse.json({ falsePositives: [], improvements: [] });
  }

  const messages = await prisma.telegramMessage.findMany({
    where: { messageLink: { in: issues.map((i) => i.telegramLink).filter((l): l is string => l != null) } },
    select: { messageLink: true, text: true },
  });
  const rawByLink = new Map(messages.map((m) => [m.messageLink, m.text]));

  const results = await Promise.all(
    issues.map(async (issue) => {
      const raw = (issue.telegramLink && rawByLink.get(issue.telegramLink)) || issue.description;
      const aiResult = await rewriteTicketDescriptionWithAI(raw);
      return { issue, aiResult };
    })
  );

  const anyAiResponded = results.some((r) => r.aiResult !== null);
  if (!anyAiResponded) {
    return NextResponse.json({ falsePositives: [], improvements: [], unavailable: true });
  }

  const falsePositives = results
    .filter((r) => r.aiResult !== null && isAiSkip(r.aiResult))
    .map((r) => r.issue);

  const improvements = results
    .filter(
      (r) =>
        r.aiResult !== null &&
        !isAiSkip(r.aiResult) &&
        r.aiResult.trim() !== r.issue.description.trim()
    )
    .map((r) => ({ issue: r.issue, suggested: r.aiResult as string }));

  return NextResponse.json({ falsePositives, improvements });
}
