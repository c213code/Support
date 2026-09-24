"use client";

import { useCallback, useRef, useState } from "react";

// Ход «Авто-репорта» живёт на доске, а не в окне: раньше цикл шагов сидел в
// AutoReportDialog, и закрытое окно или обновлённая страница оставляли
// запуск «не законченным» навсегда. Теперь окно можно закрыть и работать
// дальше — разбор идёт, а кнопка на доске показывает, сколько осталось.
// Прерванный (обновили страницу) продолжается кнопкой «Продолжить разбор».

export type RunCounts = {
  resolved: number;
  inProgress: number;
  pending: number;
  unclear: number;
  skipped: number;
  error: number;
};

export type AutoRunState = {
  runId: string;
  date: string;
  total: number;
  done: number;
  counts: RunCounts;
  startedAt: number;
  finishedAt: number | null;
  failed: string | null;
};

type VerdictLite = { state: string; proposed: string | null };

export function countVerdicts(verdicts: VerdictLite[]): { done: number; counts: RunCounts } {
  const counts: RunCounts = { resolved: 0, inProgress: 0, pending: 0, unclear: 0, skipped: 0, error: 0 };
  for (const v of verdicts) {
    if (v.state === "skipped") counts.skipped++;
    else if (v.state === "error") counts.error++;
    else if (v.state === "done") {
      if (v.proposed === "RESOLVED") counts.resolved++;
      else if (v.proposed === "IN_PROGRESS" || v.proposed === "ESCALATED") counts.inProgress++;
      else if (v.proposed === "PENDING") counts.pending++;
      else counts.unclear++;
    }
  }
  const done = verdicts.filter((v) => v.state !== "pending").length;
  return { done, counts };
}

async function fetchRun(runId: string, date: string): Promise<VerdictLite[] | null> {
  const res = await fetch(`/api/reconcile?date=${date}`).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  const run = (data?.runs as { id: string; verdicts: VerdictLite[] }[] | undefined)?.find(
    (r) => r.id === runId
  );
  return run?.verdicts ?? null;
}

export function useAutoReportRun() {
  const [run, setRun] = useState<AutoRunState | null>(null);
  // Какой запуск сейчас гоняет эта вкладка — второй цикл по тому же запуску
  // разбирал бы те же тикеты дважды.
  const driving = useRef<string | null>(null);

  const drive = useCallback(async (runId: string, date: string) => {
    if (driving.current) return;
    driving.current = runId;
    const startedAt = Date.now();
    const snapshot = (verdicts: VerdictLite[], finished: boolean): AutoRunState => ({
      runId,
      date,
      total: verdicts.length,
      ...countVerdicts(verdicts),
      startedAt,
      finishedAt: finished ? Date.now() : null,
      failed: null,
    });
    try {
      const first = await fetchRun(runId, date);
      if (first) setRun(snapshot(first, false));
      for (;;) {
        const step = await fetch(`/api/reconcile/${runId}/step`, { method: "POST" }).catch(() => null);
        const stepData = step?.ok ? await step.json().catch(() => null) : null;
        if (!stepData) {
          setRun((prev) =>
            prev?.runId === runId ? { ...prev, failed: "Разбор прервался — можно продолжить" } : prev
          );
          return;
        }
        const verdicts = await fetchRun(runId, date);
        const finished = (stepData.remaining ?? 0) === 0;
        if (verdicts) setRun(snapshot(verdicts, finished));
        if (finished) return;
      }
    } finally {
      driving.current = null;
    }
  }, []);

  // Возвращает текст ошибки или null.
  const start = useCallback(
    async (date: string): Promise<string | null> => {
      if (driving.current) return "Разбор уже идёт";
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate: date }),
      }).catch(() => null);
      const data = res ? await res.json().catch(() => null) : null;
      if (!res?.ok || !data?.runId) return data?.error ?? "Не удалось запустить разбор";
      void drive(data.runId as string, date);
      return null;
    },
    [drive]
  );

  const dismiss = useCallback(() => setRun(null), []);

  return { run, start, resume: drive, dismiss };
}
