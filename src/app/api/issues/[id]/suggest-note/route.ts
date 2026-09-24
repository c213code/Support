import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { collectResolutionContext, resolverName } from "@/lib/resolutionNote";
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
export async function GET(request: NextRequest, { params }: Params) {
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

  // Переписку поднимаем до проверки ИИ: «кто ответил в чате» нужен и без
  // модели — это имя идёт в «X шешті» вместо того, кто перетащил карточку.
  const result = await collectResolutionContext(id);
  const resolver = result.ok ? resolverName(result.context) : null;

  // ?only=resolver — окну тикета нужно только имя, без запроса к модели.
  if (request.nextUrl.searchParams.get("only") === "resolver") {
    return NextResponse.json({ resolver });
  }

  if (!(await isAiCleaningEnabled())) {
    return NextResponse.json({ suggestion: null, exact: false, reason: "ai-off", resolver });
  }

  if (!result.ok) {
    return NextResponse.json({
      suggestion: null,
      exact: false,
      reason: result.reason,
      resolver,
    });
  }

  const summary = await summarizeResolutionNote(
    issue.description,
    result.context.thread
  );
  // Реплики нашлись, но решения в них не видно (SKIP) — или модель вовсе не
  // ответила. Для окна это разные вещи: в первом случае подсказывать нечего,
  // во втором стоит просто попробовать ещё раз.
  if (!summary.ok) {
    return NextResponse.json({
      suggestion: null,
      exact: false,
      reason: summary.reason === "skip" ? "no-outcome" : "ai-error",
      resolver,
    });
  }

  // Имя дописываем кодом, а не моделью: выдуманное моделью имя коллеги —
  // худшее, что может попасть в отчёт боссам. И это имя того, кто ответил в
  // чате, а не того, кто закрыл карточку на сайте: перетащить мог Ерош, а
  // решила Алпа. Не нашли, кто отвечал, — остаётся тот, кто закрывает.
  const suggestion = `${resolver ?? identity.name} шешті, ${summary.note}`;

  return NextResponse.json({ suggestion, exact: result.context.exact, resolver });
}
