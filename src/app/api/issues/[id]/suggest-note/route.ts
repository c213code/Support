import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { collectResolutionContext } from "@/lib/resolutionNote";
import { summarizeResolutionNote } from "@/lib/ai";
import { isAiCleaningEnabled } from "@/lib/settings";

type Params = { params: Promise<{ id: string }> };

// Подсказка для окна "Как решили?": берём то, что агент уже написал в
// рабочем чате по этому тикету, и сжимаем в строку для репорта.
//
// Тот же тогл, что у ИИ-описаний ("✨ ИИ-описания"): это ровно та же
// операция, только на другом конце тикета — не "что случилось", а "что
// сделали". Заводить ради неё отдельный рубильник значило бы спрашивать
// человека дважды про одно и то же решение.
//
// Всегда 200 с `suggestion: null`, если подсказки нет (ИИ выключен, реплик
// в чате не нашлось, модель ответила SKIP): для модалки это не ошибка — она
// просто оставит прежний дефолт "<Имя> шешті".
export async function GET(_request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const issue = await prisma.issue.findUnique({
    where: { id },
    select: { description: true },
  });
  if (!issue) {
    return NextResponse.json({ error: "issue not found" }, { status: 404 });
  }

  if (!(await isAiCleaningEnabled())) {
    return NextResponse.json({ suggestion: null, exact: false, reason: "ai-off" });
  }

  const result = await collectResolutionContext(id);
  if (!result.ok) {
    return NextResponse.json({
      suggestion: null,
      exact: false,
      reason: result.reason,
    });
  }

  const summary = await summarizeResolutionNote(
    issue.description,
    result.context.agentTexts
  );
  // Реплики нашлись, но решения в них не видно (SKIP) — или модель вовсе не
  // ответила. Для окна это разные вещи: в первом случае подсказывать нечего,
  // во втором стоит просто попробовать ещё раз.
  if (!summary.ok) {
    return NextResponse.json({
      suggestion: null,
      exact: false,
      reason: summary.reason === "skip" ? "no-outcome" : "ai-error",
    });
  }

  // Имя дописываем кодом, а не моделью: в репорте оно значит "кто закрыл", и
  // выдуманное моделью имя коллеги — худшее, что может попасть в отчёт
  // боссам. Формат тот же, что дежурные пишут руками: "Ерош шешті, ...".
  const suggestion = `${identity.name} шешті, ${summary.note}`;

  return NextResponse.json({ suggestion, exact: result.context.exact });
}
