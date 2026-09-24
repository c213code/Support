import { prisma } from "@/lib/prisma";
import type { IssueStatus } from "@/lib/status";
import { changeIssueStatus } from "@/lib/issueStatus";
import { collectResolutionContext, resolverName } from "@/lib/resolutionNote";
import { reconcileIssue, type ReconcileProvider } from "@/lib/dayReconcile";

// «Авто-репорт» по кнопке на доске: запуск, пошаговый разбор и применение.
//
// Разбор идёт шагами по несколько тикетов, а не одним запросом на весь день:
// на тикет уходит 3–8 секунд модели, и тридцать тикетов одним вызовом
// упёрлись бы в лимит функции Vercel, а человек смотрел бы на вечный
// спиннер. Шагами — и прогресс виден, и ничего не обрывается.
//
// Ничего не меняется само. Статус тикета меняется только в applyVerdicts —
// когда человек отметил решения и нажал «Применить».

// Модель разбора — переменной RECONCILE_MODEL: «gemini:<модель>» (нужен
// GEMINI_REPORT_KEY) или «groq».
export function reconcileProvider(): ReconcileProvider {
  const spec = process.env.RECONCILE_MODEL?.trim();
  if (spec === "groq") return { kind: "groq", model: "groq" };
  if (spec?.startsWith("gemini:") && process.env.GEMINI_REPORT_KEY) {
    return { kind: "gemini", model: spec.slice("gemini:".length) };
  }
  // По умолчанию — Groq, которым проект уже пользуется. Бесплатный ключ
  // Gemini упирается в дневную квоту (429) посреди разбора, поэтому Gemini
  // включается только явно: RECONCILE_MODEL=gemini:gemini-flash-latest.
  return { kind: "groq", model: "groq" };
}

function providerLabel(provider: ReconcileProvider): string {
  return provider.kind === "groq" ? "groq" : `gemini:${provider.model}`;
}

// Какие тикеты разбирать: все нерешённые тикеты дня. «Отправлено» тоже —
// часто по нему уже ответили в чате, просто карточку не тронули.
export async function startRun(reportDate: string, startedBy: string) {
  const issues = await prisma.issue.findMany({
    where: { reportDate, status: { not: "RESOLVED" } },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  return prisma.reconcileRun.create({
    data: {
      reportDate,
      startedBy,
      model: providerLabel(reconcileProvider()),
      finishedAt: issues.length === 0 ? new Date() : null,
      verdicts: {
        create: issues.map((issue) => ({ issueId: issue.id, statusBefore: issue.status })),
      },
    },
  });
}

// Почему тикет пропущен — словами для окна, а не кодом.
const SKIP_REASON: Record<"no-agent-ids" | "no-issue-messages" | "no-agent-messages", string> = {
  "no-agent-ids": "не задан список агентов (OWN_AGENT_TELEGRAM_IDS) — своих реплик не отличить",
  "no-issue-messages": "к тикету не привязано ни одного сообщения из чата",
  "no-agent-messages": "в чате по нему никто из агентов не отвечал",
};

// Разобрать следующие несколько тикетов запуска.
export async function stepRun(runId: string, batch = 3): Promise<{ remaining: number }> {
  const run = await prisma.reconcileRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) return { remaining: 0 };

  const pending = await prisma.reconcileVerdict.findMany({
    where: { runId, state: "pending" },
    orderBy: { createdAt: "asc" },
    take: batch,
    select: { id: true, issueId: true, issue: { select: { description: true } } },
  });
  const provider = reconcileProvider();

  for (const verdict of pending) {
    const context = await collectResolutionContext(verdict.issueId);
    // Судим только по точно привязанным репликам: найденные догадкой по окну
    // времени могут быть о соседнем тикете, а ошибка тут уходит в репорт.
    if (!context.ok || !context.context.exact) {
      await prisma.reconcileVerdict.update({
        where: { id: verdict.id },
        data: {
          state: "skipped",
          proposed: "UNCLEAR",
          error: context.ok ? "переписка найдена только догадкой — судить рискованно" : SKIP_REASON[context.reason],
        },
      });
      continue;
    }

    let result = await reconcileIssue(provider, verdict.issue.description, context.context.agentTexts);
    // Сетевой сбой и «модель перегружена» (503) проходят за секунды — один
    // повтор (на прогоне по прошлым дням Groq ронял так ~6% запросов).
    // Исчерпанную квоту Gemini (429) повтор не спасёт: такой тикет честно
    // помечается ошибкой, и его можно разобрать заново позже.
    if (!result.ok && /^(500|503)|UNAVAILABLE|high demand|overloaded|сеть/i.test(result.error)) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      result = await reconcileIssue(provider, verdict.issue.description, context.context.agentTexts);
    }
    await prisma.reconcileVerdict.update({
      where: { id: verdict.id },
      data: result.ok
        ? {
            state: "done",
            proposed: result.verdict.status,
            note: result.verdict.note,
            evidence: result.verdict.evidence,
            resolver: resolverName(context.context),
          }
        : { state: "error", error: result.error.slice(0, 300) },
    });
  }

  const remaining = await prisma.reconcileVerdict.count({ where: { runId, state: "pending" } });
  if (remaining === 0) {
    await prisma.reconcileRun.update({ where: { id: runId }, data: { finishedAt: new Date() } });
  }
  return { remaining };
}

// Статусы, которые разбор может поставить сам. «Передано» — нет: для него
// нужна команда, а её из чата надёжно не вытащить. «Непонятно» — не статус.
const APPLICABLE = new Set<IssueStatus>(["RESOLVED", "IN_PROGRESS", "PENDING"]);

export type ApplyOutcome = { verdictId: string; applied: boolean; reason?: string };

// Применить отмеченные человеком решения.
export async function applyVerdicts(
  runId: string,
  verdictIds: string[],
  actor: string
): Promise<ApplyOutcome[]> {
  const verdicts = await prisma.reconcileVerdict.findMany({
    where: { runId, id: { in: verdictIds } },
    select: {
      id: true,
      issueId: true,
      state: true,
      proposed: true,
      note: true,
      resolver: true,
      statusBefore: true,
      appliedAt: true,
      issue: { select: { status: true } },
    },
  });

  const outcomes: ApplyOutcome[] = [];
  for (const verdict of verdicts) {
    const status = verdict.proposed as IssueStatus | null;
    if (verdict.appliedAt) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "уже применено" });
      continue;
    }
    if (verdict.state !== "done" || !status || !APPLICABLE.has(status)) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "это не статус для применения" });
      continue;
    }
    // Пока разбор шёл, тикет могли тронуть руками — тогда решение человека
    // важнее догадки модели.
    if (verdict.issue.status !== verdict.statusBefore) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "статус уже поменяли вручную" });
      continue;
    }

    const note =
      status === "RESOLVED"
        ? `${verdict.resolver ?? actor} шешті${verdict.note ? `, ${verdict.note}` : ""}`
        : verdict.note || undefined;
    // source "chat": в группе ответ дежурного уже прозвучал — повторять его
    // словами бота незачем (правило одной строки в CLAUDE.md).
    const result = await changeIssueStatus({
      issueId: verdict.issueId,
      status,
      actor,
      source: "chat",
      note,
    });
    if (!result.ok) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "тикет не найден" });
      continue;
    }
    await prisma.reconcileVerdict.update({
      where: { id: verdict.id },
      data: { appliedAt: new Date(), appliedBy: actor },
    });
    outcomes.push({ verdictId: verdict.id, applied: true });
  }
  return outcomes;
}

// Журнал: запуски дня с решениями — для окна «Авто-репорт» и для вечерней
// сверки «что ИИ посчитал сделанным и что из этого применили».
export async function runsForDay(reportDate: string) {
  return prisma.reconcileRun.findMany({
    where: { reportDate },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      verdicts: {
        orderBy: { createdAt: "asc" },
        include: { issue: { select: { description: true, groupName: true, groupEmoji: true, status: true } } },
      },
    },
  });
}
