"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { STATUS_META, type IssueStatus } from "@/lib/status";

// «Авто-репорт»: ИИ читает переписку по открытым тикетам дня и предлагает, чем
// каждый закончился (см. lib/dayReconcile.ts). Сам ничего не меняет — человек
// отмечает решения и жмёт «Применить».
//
// Внизу — журнал запусков за день: вечером по нему видно, что ИИ посчитал
// сделанным, на какой цитате из чата это основано и что из этого применили.

type Verdict = {
  id: string;
  issueId: string;
  statusBefore: IssueStatus;
  state: "pending" | "done" | "skipped" | "error";
  proposed: string | null;
  note: string | null;
  evidence: string | null;
  resolver: string | null;
  error: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
  issue: { description: string; groupName: string; groupEmoji: string | null; status: IssueStatus };
};

type Run = {
  id: string;
  model: string;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
  verdicts: Verdict[];
};

const APPLICABLE = new Set(["RESOLVED", "IN_PROGRESS", "PENDING"]);

const PROPOSED_LABEL: Record<string, string> = {
  RESOLVED: "✅ Решено",
  IN_PROGRESS: "🔄 В работе",
  PENDING: "⚠️ Пендинг",
  ESCALATED: "📤 Передано",
  UNCLEAR: "❔ Непонятно",
};

// Что отметить сразу: только то, что можно применить и что меняет статус.
// «Непонятно», «Передано» и совпадающее с текущим — без галочки.
function preselect(verdict: Verdict): boolean {
  return (
    verdict.state === "done" &&
    !verdict.appliedAt &&
    Boolean(verdict.proposed) &&
    APPLICABLE.has(verdict.proposed!) &&
    verdict.proposed !== verdict.statusBefore
  );
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function runSummary(run: Run): string {
  const count = (status: string) => run.verdicts.filter((v) => v.proposed === status).length;
  const applied = run.verdicts.filter((v) => v.appliedAt).length;
  return [
    `решено ${count("RESOLVED")}`,
    `в работе ${count("IN_PROGRESS")}`,
    `ждём ${count("PENDING")}`,
    `непонятно ${count("UNCLEAR")}`,
    `применено ${applied}`,
  ].join(" · ");
}

export function AutoReportDialog({
  date,
  onClose,
  onApplied,
}: {
  date: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (): Promise<Run[]> => {
    const res = await fetch(`/api/reconcile?date=${date}`);
    const data = res.ok ? await res.json().catch(() => null) : null;
    const list: Run[] = data?.runs ?? [];
    setRuns(list);
    return list;
  }, [date]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const list = await loadRuns();
      if (cancelled) return;
      // Открываем последний запуск дня — его обычно и продолжают разбирать.
      if (list[0]) {
        setActiveRunId(list[0].id);
        setSelected(new Set(list[0].verdicts.filter(preselect).map((v) => v.id)));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [loadRuns]);

  const activeRun = runs?.find((r) => r.id === activeRunId) ?? null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate: date }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.runId) {
        setError(data?.error ?? "Не удалось запустить разбор");
        return;
      }
      const runId: string = data.runId;
      setActiveRunId(runId);
      let list = await loadRuns();
      const total = list.find((r) => r.id === runId)?.verdicts.length ?? 0;
      setProgress({ done: 0, total });

      // Разбор идёт шагами по несколько тикетов — так виден прогресс и ничего
      // не упирается в лимит времени запроса.
      for (;;) {
        const step = await fetch(`/api/reconcile/${runId}/step`, { method: "POST" });
        const stepData = await step.json().catch(() => null);
        if (!step.ok) {
          setError("Разбор прервался — можно запустить заново");
          break;
        }
        list = await loadRuns();
        const run = list.find((r) => r.id === runId);
        const pending = run?.verdicts.filter((v) => v.state === "pending").length ?? 0;
        setProgress({ done: total - pending, total });
        if ((stepData?.remaining ?? 0) === 0) {
          setSelected(new Set(run?.verdicts.filter(preselect).map((v) => v.id) ?? []));
          break;
        }
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function apply() {
    if (!activeRun || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reconcile/${activeRun.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdictIds: [...selected] }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? "Не удалось применить");
        return;
      }
      const skipped = (data?.outcomes ?? []).filter((o: { applied: boolean }) => !o.applied);
      if (skipped.length > 0) {
        setError(`Не применено: ${skipped.length} (статус уже меняли вручную или это не статус)`);
      }
      setSelected(new Set());
      await loadRuns();
      onApplied();
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Modal onClose={onClose} size="xl" labelledBy="auto-report-title">
      <div className="flex max-h-[85vh] flex-col rounded-2xl bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <h2 id="auto-report-title" className="text-base font-semibold text-slate-900">
            🤖 Авто-репорт
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            ИИ читает переписку по открытым тикетам дня и предлагает, чем каждый закончился.
            Сам ничего не меняет — отметьте, что верно, и нажмите «Применить».
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {progress && (
            <p className="mb-3 text-sm text-slate-600">
              Разбираю переписку… {progress.done} из {progress.total}
            </p>
          )}
          {error && (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {error}
            </p>
          )}

          {runs === null && <p className="text-sm text-slate-400">Загружаю журнал…</p>}
          {runs?.length === 0 && !busy && (
            <p className="text-sm text-slate-500">
              За этот день разбора ещё не было. Нажмите «Разобрать день».
            </p>
          )}

          {activeRun && (
            <ul className="space-y-2">
              {activeRun.verdicts.map((v) => {
                const canApply =
                  v.state === "done" && !v.appliedAt && Boolean(v.proposed) && APPLICABLE.has(v.proposed!);
                return (
                  <li
                    key={v.id}
                    className={`rounded-xl border px-3 py-2.5 text-sm ${
                      v.appliedAt ? "border-emerald-200 bg-emerald-50/50" : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        aria-label="Применить это решение"
                        className="mt-1 h-4 w-4 shrink-0 accent-brand-600"
                        disabled={!canApply || busy}
                        checked={selected.has(v.id)}
                        onChange={() => toggle(v.id)}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-slate-800">
                          <span className="text-slate-400">
                            {v.issue.groupEmoji} {v.issue.groupName} ·{" "}
                          </span>
                          {v.issue.description}
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                            {STATUS_META[v.statusBefore].emoji} {STATUS_META[v.statusBefore].label}
                          </span>
                          <span className="text-slate-400">→</span>
                          <span className="rounded bg-brand-50 px-1.5 py-0.5 font-medium text-brand-700">
                            {v.state === "pending"
                              ? "…"
                              : v.state === "error"
                                ? "⚠️ ИИ не ответил"
                                : (PROPOSED_LABEL[v.proposed ?? ""] ?? v.proposed)}
                          </span>
                          {v.note && <span className="text-slate-700">{v.proposed === "RESOLVED" ? `${v.resolver ?? "…"} шешті, ${v.note}` : v.note}</span>}
                        </p>
                        {v.evidence && (
                          <p className="mt-1 text-xs italic text-slate-500">«{v.evidence}»</p>
                        )}
                        {v.state === "skipped" && (
                          <p className="mt-1 text-xs text-slate-400">{v.error}</p>
                        )}
                        {v.state === "error" && (
                          <p className="mt-1 text-xs text-red-500">{v.error}</p>
                        )}
                        {v.proposed === "ESCALATED" && !v.appliedAt && (
                          <p className="mt-1 text-xs text-slate-400">
                            «Передано» ставится вручную — нужна команда
                          </p>
                        )}
                        {v.appliedAt && (
                          <p className="mt-1 text-xs text-emerald-700">
                            ✅ Применено · {v.appliedBy} · {time(v.appliedAt)}
                          </p>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {runs && runs.length > 0 && (
            <div className="mt-5">
              <h3 className="text-xs font-semibold text-slate-500">Журнал разборов за день</h3>
              <ul className="mt-1.5 space-y-1">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveRunId(run.id);
                        setSelected(new Set(run.verdicts.filter(preselect).map((v) => v.id)));
                      }}
                      className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition ${
                        run.id === activeRunId ? "bg-slate-100 text-slate-800" : "text-slate-500 hover:bg-slate-50"
                      }`}
                    >
                      {time(run.createdAt)} · {run.startedBy} · {run.model}
                      <br />
                      {run.finishedAt ? runSummary(run) : "не закончен"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-slate-500 hover:bg-slate-100"
          >
            Закрыть
          </button>
          <button
            type="button"
            onClick={start}
            disabled={busy}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy && progress ? "Разбираю…" : "Разобрать день"}
          </button>
          <button
            type="button"
            onClick={apply}
            disabled={busy || selected.size === 0}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Применить отмеченные ({selected.size})
          </button>
        </div>
      </div>
    </Modal>
  );
}
