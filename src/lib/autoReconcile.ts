import { prisma } from "@/lib/prisma";
import { applyVerdicts, isAutoApplicable, startRun, stepRun } from "@/lib/reconcileRun";

// Вечерний авто-разбор: в 21:30 по Алматы (cron /api/cron/auto-reconcile)
// тот же разбор дня, что кнопка «Разобрать день» в окне «Авто-репорт», и
// сразу — применение того, что окно отметило бы галочкой само
// (isAutoApplicable). В 22:00 дежурный получает уже обновлённую сводку и до
// отправки в 10:30 может поправить руками.
//
// Защиты те же, что у ручного «Применить» (applyVerdicts): «Непонятно» и
// «Передано» не применяются, тикет, который человек тронул во время разбора,
// не перезаписывается. Выключается переменной AUTO_RECONCILE=off.
//
// Повторный вызов за тот же день (cron в 21:45 — на случай, если первый не
// успел за 300 с) продолжает тот же запуск, а не начинает новый за те же
// деньги; уже применённое второй раз не применяется.

export const AUTO_RECONCILE_ACTOR = "Авто-репорт";

export function autoReconcileEnabled(): boolean {
  return process.env.AUTO_RECONCILE?.trim().toLowerCase() !== "off";
}

export type AutoReconcileResult = {
  runId: string | null;
  remaining: number;
  applied: number;
  skipped: number;
};

export async function runAutoReconcile(reportDate: string, deadline: number): Promise<AutoReconcileResult> {
  const existing = await prisma.reconcileRun.findFirst({
    where: { reportDate, startedBy: AUTO_RECONCILE_ACTOR, instructions: { isEmpty: true } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const run = existing ?? (await startRun(reportDate, AUTO_RECONCILE_ACTOR));

  // Шаг длится как самый долгий тикет (до ~2 мин с повтором к запасной
  // модели), поэтому новый шаг начинаем, только если до deadline больше
  // этого. Не успели — доделает вызов в 21:45.
  const STEP_BUDGET_MS = 130_000;
  let remaining = await prisma.reconcileVerdict.count({ where: { runId: run.id, state: "pending" } });
  while (remaining > 0 && Date.now() + STEP_BUDGET_MS < deadline) {
    ({ remaining } = await stepRun(run.id));
  }

  const verdicts = await prisma.reconcileVerdict.findMany({
    where: { runId: run.id },
    select: { id: true, state: true, appliedAt: true, proposed: true, statusBefore: true },
  });
  const items = verdicts.filter(isAutoApplicable).map((v) => ({ verdictId: v.id }));
  const outcomes = items.length
    ? await applyVerdicts(run.id, items, AUTO_RECONCILE_ACTOR, { automatic: true })
    : [];
  return {
    runId: run.id,
    remaining,
    applied: outcomes.filter((o) => o.applied).length,
    skipped: outcomes.filter((o) => !o.applied).length,
  };
}
