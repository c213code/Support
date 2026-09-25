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

// Как часто подтягивать журнал, пока идёт шаг.
const STEP_POLL_MS = 1500;
// Сколько ждём ответа на шаг: maxDuration маршрута — 300 с, плюс запас.
const STEP_TIMEOUT_MS = 330_000;

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
  // «Остановить»: новые шаги не начинаются, текущий запрос обрывается.
  // Тикеты, которые сервер уже взял в этот шаг, он доделает сам.
  const stopRequested = useRef(false);
  const stepAbort = useRef<AbortController | null>(null);

  const drive = useCallback(async (runId: string, date: string) => {
    if (driving.current) return;
    driving.current = runId;
    stopRequested.current = false;
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
        if (stopRequested.current) {
          setRun((prev) =>
            prev?.runId === runId ? { ...prev, failed: "Разбор остановлен" } : prev
          );
          return;
        }
        // Шаг — несколько тикетов одновременно, и ответ на него приходит,
        // когда готов самый медленный. Но каждый тикет пишется в журнал сразу
        // по готовности — поэтому, пока шаг идёт, подтягиваем журнал сами:
        // полоса растёт по одному тикету, а не прыгает раз в шаг.
        let polling = false;
        const poll = setInterval(async () => {
          if (polling) return;
          polling = true;
          const verdicts = await fetchRun(runId, date);
          polling = false;
          if (verdicts) {
            // Все тикеты уже разобраны — показываем «готово», не дожидаясь
            // ответа на шаг: он мог и не прийти (25.09 полоса 20 минут висела
            // на «6 из 6 · разбираю», хотя разбор давно закончился).
            const allDone = verdicts.length > 0 && verdicts.every((v) => v.state !== "pending");
            // Опоздавший ответ не должен откатывать полосу назад.
            setRun((prev) => {
              if (prev?.runId !== runId || prev.finishedAt) return prev;
              const next = snapshot(verdicts, allDone);
              return allDone || next.done > prev.done ? next : prev;
            });
          }
        }, STEP_POLL_MS);
        // Шаг не может идти дольше maxDuration маршрута (300 с); если ответа
        // нет дольше — не ждём вечно, а смотрим журнал.
        const controller = new AbortController();
        stepAbort.current = controller;
        const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
        const step = await fetch(`/api/reconcile/${runId}/step`, {
          method: "POST",
          signal: controller.signal,
        })
          .catch(() => null)
          .finally(() => {
            clearInterval(poll);
            clearTimeout(timeout);
            stepAbort.current = null;
          });
        const stepData = step?.ok ? await step.json().catch(() => null) : null;
        const verdicts = await fetchRun(runId, date);
        const allDone = verdicts ? verdicts.every((v) => v.state !== "pending") : false;
        if (!stepData && !allDone) {
          const reason = stopRequested.current ? "Разбор остановлен" : "Разбор прервался — можно продолжить";
          setRun((prev) => {
            if (prev?.runId !== runId) return prev;
            const next = verdicts ? snapshot(verdicts, false) : prev;
            return { ...next, failed: reason };
          });
          return;
        }
        const finished = allDone || (stepData?.remaining ?? 0) === 0;
        // Журнал не пришёл, но шаг сказал «всё» — отмечаем готовым с тем,
        // что уже показано: иначе окно так и осталось бы «разбираю».
        if (verdicts) setRun(snapshot(verdicts, finished));
        else if (finished) {
          setRun((prev) =>
            prev?.runId === runId && !prev.finishedAt ? { ...prev, finishedAt: Date.now() } : prev
          );
        }
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

  const stop = useCallback(() => {
    if (!driving.current) return;
    stopRequested.current = true;
    stepAbort.current?.abort();
  }, []);

  return { run, start, resume: drive, dismiss, stop };
}
