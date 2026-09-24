"use client";

import { useEffect, useState } from "react";
import type { AutoRunState, RunCounts } from "@/components/useAutoReportRun";

// Виджет хода «Авто-репорта»: полоса, которая заполняется итогами по мере
// разбора — сразу видно не только «сколько осталось», но и «что выходит»:
// много зелёного — день закрыт, много серого — переписки мало.

const SEGMENTS: { key: keyof RunCounts; label: string; color: string }[] = [
  { key: "resolved", label: "решено", color: "bg-emerald-500" },
  { key: "inProgress", label: "в работе", color: "bg-sky-500" },
  { key: "pending", label: "ждём", color: "bg-amber-400" },
  { key: "unclear", label: "непонятно", color: "bg-slate-400" },
  { key: "skipped", label: "пропущено", color: "bg-slate-300" },
  { key: "error", label: "ошибка", color: "bg-rose-500" },
];

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AutoReportProgress({
  run,
  onResume,
}: {
  run: AutoRunState;
  onResume?: () => void;
}) {
  const running = !run.finishedAt && !run.failed;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  const pct = (n: number) => (run.total ? (n / run.total) * 100 : 0);
  const remaining = run.total - run.done;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-3 rounded-xl border p-3.5 ${
        run.failed
          ? "border-rose-200 bg-rose-50/60"
          : running
            ? "border-brand-100 bg-gradient-to-br from-brand-50 to-white"
            : "border-emerald-200 bg-emerald-50/50"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-800">
          {running ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-brand-600" />
            </span>
          ) : run.failed ? (
            <span aria-hidden>⚠️</span>
          ) : (
            <span aria-hidden>✅</span>
          )}
          {running ? "Разбираю переписку" : run.failed ? run.failed : "Разбор готов"}
        </div>
        <div className="text-xs tabular-nums text-slate-500">
          {run.done} из {run.total} · {clock(elapsed)}
        </div>
      </div>

      <div
        className="mt-2.5 flex h-2.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={run.total}
        aria-valuenow={run.done}
      >
        {SEGMENTS.map((s) =>
          run.counts[s.key] > 0 ? (
            <div
              key={s.key}
              className={`${s.color} transition-[width] duration-500 ease-out`}
              style={{ width: `${pct(run.counts[s.key])}%` }}
            />
          ) : null
        )}
        {remaining > 0 && (
          <div
            className={`bg-slate-200 ${running ? "motion-safe:animate-pulse" : ""}`}
            style={{ width: `${pct(remaining)}%` }}
          />
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
        {SEGMENTS.filter((s) => run.counts[s.key] > 0).map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${s.color}`} />
            {s.label} {run.counts[s.key]}
          </span>
        ))}
        {running && remaining > 0 && <span className="text-slate-400">осталось {remaining}</span>}
        {running && (
          <span className="text-slate-400">окно можно закрыть — разбор продолжится</span>
        )}
        {run.failed && onResume && (
          <button
            type="button"
            onClick={onResume}
            className="font-medium text-brand-600 hover:underline"
          >
            Продолжить разбор
          </button>
        )}
      </div>
    </div>
  );
}
