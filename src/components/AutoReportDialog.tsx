"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { AutoReportProgress } from "@/components/AutoReportProgress";
import { countVerdicts, type AutoRunState } from "@/components/useAutoReportRun";

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
  reason: string | null;
  resolver: string | null;
  mergeTargetId: string | null;
  error: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
  issue: {
    description: string;
    groupName: string;
    groupEmoji: string | null;
    status: IssueStatus;
    telegramLink: string | null;
    reportDate: string;
  };
};

type MergeTarget = { id: string; description: string; reportDate: string; groupName: string };

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
    untouched(verdict) &&
    verdict.state === "done" &&
    !verdict.appliedAt &&
    Boolean(verdict.proposed) &&
    APPLICABLE.has(verdict.proposed!) &&
    verdict.proposed !== verdict.statusBefore
  );
}

// Статус тикета не меняли с начала разбора — только тогда решение ещё
// актуально (сервер проверяет то же самое, см. applyVerdicts).
function untouched(verdict: Verdict): boolean {
  return !verdict.appliedAt && verdict.issue.status === verdict.statusBefore;
}

// Что человек может поставить сам. «Передано» — не здесь: для него нужна
// команда, и открывается обычное окно передачи (onEscalate).
const CHOICES: { value: IssueStatus; label: string }[] = [
  { value: "RESOLVED", label: "✅ Решено" },
  { value: "IN_PROGRESS", label: "🔄 В работе" },
  { value: "PENDING", label: "⚠️ Пендинг" },
];
const ESCALATE = "ESCALATE";

// «Почему так?»: вывод модели одной фразой и то, что она видела. Переписку
// грузим, только когда блок раскрыли, — это килобайты на тикет.
function WhyBlock({ verdictId, reason }: { verdictId: string; reason: string | null }) {
  const [input, setInput] = useState<string | null | undefined>(undefined);
  async function load() {
    if (input !== undefined) return;
    const res = await fetch(`/api/reconcile/verdict/${verdictId}`).catch(() => null);
    const data = res?.ok ? await res.json().catch(() => null) : null;
    setInput(data?.input ?? null);
  }
  return (
    <details
      className="mt-1 text-xs text-slate-500"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer select-none text-slate-400 hover:text-slate-600">
        Почему так?
      </summary>
      <div className="mt-1 space-y-1.5 rounded-lg bg-slate-50 p-2">
        {reason && <p className="text-slate-700">{reason}</p>}
        {input === undefined ? (
          <p className="text-slate-400">Загружаю, что видела модель…</p>
        ) : input ? (
          <>
            <p className="text-slate-400">Что видела модель:</p>
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-slate-600">
              {input}
            </pre>
          </>
        ) : (
          <p className="text-slate-400">Переписка не сохранена (разбор до 24.09).</p>
        )}
      </div>
    </details>
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
  onEscalate,
  refreshToken,
  autoRun,
  onStart,
  onResume,
}: {
  date: string;
  onClose: () => void;
  onApplied: () => void;
  // Ход разбора держит доска (useAutoReportRun) — окно его только
  // показывает, поэтому закрытое окно разбор не останавливает.
  autoRun: AutoRunState | null;
  onStart: () => Promise<string | null>;
  onResume: (runId: string) => void;
  // Открыть окно передачи с доски (выбор команды) для этого тикета.
  onEscalate?: (issueId: string) => void;
  // Меняется, когда доска перечитала тикеты (например, после передачи) —
  // тогда и здесь перечитываем журнал, чтобы увидеть новый статус.
  refreshToken?: unknown;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  // Тикеты, с которыми предлагается объединить (см. findSplitOriginal).
  const [mergeTargets, setMergeTargets] = useState<Record<string, MergeTarget>>({});
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Статус, выбранный человеком вместо предложенного моделью.
  const [choice, setChoice] = useState<Record<string, IssueStatus>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async (): Promise<Run[]> => {
    const res = await fetch(`/api/reconcile?date=${date}`);
    const data = res.ok ? await res.json().catch(() => null) : null;
    const list: Run[] = data?.runs ?? [];
    setRuns(list);
    setMergeTargets(data?.mergeTargets ?? {});
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

  // Доска перечитала тикеты — перечитываем журнал, не сбрасывая отметки.
  useEffect(() => {
    if (refreshToken === undefined) return;
    const t = setTimeout(() => void loadRuns(), 0);
    return () => clearTimeout(t);
  }, [refreshToken, loadRuns]);

  // Разбор этого дня, идущий прямо сейчас.
  const live = autoRun && autoRun.date === date ? autoRun : null;
  const running = Boolean(live && !live.finishedAt && !live.failed);
  const liveRunId = live?.runId ?? null;
  const liveDone = live?.done ?? 0;
  const liveFinished = live?.finishedAt ?? null;

  // Пошёл новый разбор — показываем его; каждый шаг — перечитываем журнал;
  // закончился — отмечаем уверенные решения.
  useEffect(() => {
    if (!liveRunId) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const list = await loadRuns();
      if (cancelled) return;
      setActiveRunId(liveRunId);
      if (liveFinished) {
        const run = list.find((r) => r.id === liveRunId);
        setSelected(new Set(run?.verdicts.filter(preselect).map((v) => v.id) ?? []));
      }
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [liveRunId, liveDone, liveFinished, loadRuns]);

  const activeRun = runs?.find((r) => r.id === activeRunId) ?? null;
  // Незаконченный запуск, который эта вкладка не гонит: страницу обновили
  // посреди разбора — или его прямо сейчас ведёт коллега в своём браузере.
  // Отличить нельзя, поэтому без слова «прервался»: показываем, где он, и
  // даём продолжить (повторный шаг по тем же тикетам только перезапишет их).
  const stalled: AutoRunState | null =
    activeRun && !activeRun.finishedAt && activeRun.id !== liveRunId
      ? (() => {
          const { done, counts } = countVerdicts(activeRun.verdicts);
          return {
            runId: activeRun.id,
            date,
            total: activeRun.verdicts.length,
            done,
            counts,
            startedAt: new Date(activeRun.createdAt).getTime(),
            finishedAt: null,
            failed: "Разбор не закончен",
          };
        })()
      : null;
  const progressRun = live && live.runId === activeRunId ? live : stalled;

  async function start() {
    setError(null);
    const failure = await onStart();
    if (failure) setError(failure);
  }

  async function apply() {
    if (!activeRun || selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reconcile/${activeRun.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [...selected].map((verdictId) => ({ verdictId, status: choice[verdictId] })),
        }),
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
      setChoice({});
      await loadRuns();
      onApplied();
    } finally {
      setBusy(false);
    }
  }

  // Объединить тикет с тем, продолжением которого он оказался. Тот же
  // маршрут, что у ручного объединения на доске; этот тикет исчезает, его
  // сообщения и ответы переезжают в старший.
  async function merge(verdict: Verdict, target: MergeTarget) {
    setMergingId(verdict.id);
    setError(null);
    try {
      const res = await fetch(`/api/issues/${verdict.issueId}/merge-into`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: target.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? "Не удалось объединить");
        return;
      }
      await loadRuns();
      onApplied();
    } finally {
      setMergingId(null);
    }
  }

  function choose(verdict: Verdict, value: string) {
    if (value === ESCALATE) {
      onEscalate?.(verdict.issueId);
      return;
    }
    setChoice((prev) => {
      const next = { ...prev };
      if (value) next[verdict.id] = value as IssueStatus;
      else delete next[verdict.id];
      return next;
    });
    // Выбрал статус — значит, хочет его применить; сбросил на «как у ИИ» —
    // отметка остаётся, только если сам вывод ИИ применим.
    setSelected((prev) => {
      const next = new Set(prev);
      if (value || preselect(verdict)) next.add(verdict.id);
      else next.delete(verdict.id);
      return next;
    });
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
          {progressRun && (
            <AutoReportProgress run={progressRun} onResume={() => onResume(progressRun.runId)} />
          )}
          {error && (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {error}
            </p>
          )}

          {runs === null && <p className="text-sm text-slate-400">Загружаю журнал…</p>}
          {runs?.length === 0 && !running && (
            <p className="text-sm text-slate-500">
              За этот день разбора ещё не было. Нажмите «Разобрать день».
            </p>
          )}

          {activeRun && (
            <ul className="space-y-2">
              {activeRun.verdicts.map((v) => {
                const open = untouched(v) && v.state !== "pending";
                const canApply =
                  open &&
                  (Boolean(choice[v.id]) ||
                    (v.state === "done" && Boolean(v.proposed) && APPLICABLE.has(v.proposed!)));
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
                          {/* Тикет прошлого дня, по которому писали в этот день. */}
                          {v.issue.reportDate !== date && (
                            <span className="mr-1 rounded bg-amber-50 px-1 text-xs text-amber-700">
                              📅 с {v.issue.reportDate.slice(8, 10)}.{v.issue.reportDate.slice(5, 7)}
                            </span>
                          )}
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
                        {v.mergeTargetId && mergeTargets[v.mergeTargetId] && !v.appliedAt && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg bg-violet-50 px-2 py-1.5 text-xs text-violet-800">
                            <span className="min-w-0 flex-1">
                              🔗 Похоже на продолжение тикета «
                              {mergeTargets[v.mergeTargetId].description.slice(0, 80)}» (📅{" "}
                              {mergeTargets[v.mergeTargetId].reportDate.slice(8, 10)}.
                              {mergeTargets[v.mergeTargetId].reportDate.slice(5, 7)}) — тот же автор;
                              проверьте переписку перед объединением
                            </span>
                            <button
                              type="button"
                              disabled={busy || mergingId !== null}
                              onClick={() => merge(v, mergeTargets[v.mergeTargetId!])}
                              className="rounded-md bg-violet-600 px-2 py-1 font-medium text-white hover:bg-violet-700 disabled:opacity-50"
                            >
                              {mergingId === v.id ? "Объединяю…" : "Объединить"}
                            </button>
                          </div>
                        )}
                        {/* Проверить вывод модели: карточка тикета на доске и
                            сама переписка в Telegram — в новой вкладке, чтобы
                            не терять разбор. */}
                        <p className="mt-1 flex gap-3 text-xs">
                          <a
                            href={`/inbox?issue=${encodeURIComponent(v.issueId)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-brand-600 hover:underline"
                          >
                            Открыть тикет ↗
                          </a>
                          {v.issue.telegramLink && (
                            <a
                              href={v.issue.telegramLink}
                              target="_blank"
                              rel="noreferrer"
                              className="text-brand-600 hover:underline"
                            >
                              Переписка в Telegram ↗
                            </a>
                          )}
                        </p>
                        {(v.state === "done" || v.state === "error") && (
                          <WhyBlock verdictId={v.id} reason={v.reason} />
                        )}
                        {v.state === "skipped" && (
                          <p className="mt-1 text-xs text-slate-400">{v.error}</p>
                        )}
                        {v.state === "error" && (
                          <p className="mt-1 text-xs text-red-500">{v.error}</p>
                        )}
                        {open && (
                          <label className="mt-1.5 flex items-center gap-2 text-xs text-slate-500">
                            Поставить:
                            <select
                              value={choice[v.id] ?? ""}
                              disabled={busy}
                              onChange={(e) => choose(v, e.target.value)}
                              className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-800"
                            >
                              <option value="">
                                {v.state === "done" && v.proposed && APPLICABLE.has(v.proposed)
                                  ? `как предлагает ИИ (${PROPOSED_LABEL[v.proposed]})`
                                  : "— выбрать —"}
                              </option>
                              {CHOICES.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                              {onEscalate && <option value={ESCALATE}>📤 Передать…</option>}
                            </select>
                          </label>
                        )}
                        {!v.appliedAt && v.issue.status !== v.statusBefore && (
                          <p className="mt-1 text-xs text-slate-500">
                            Статус уже изменён: {STATUS_META[v.issue.status].emoji}{" "}
                            {STATUS_META[v.issue.status].label}
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
            disabled={busy || running}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {running ? "Разбираю…" : "Разобрать день"}
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
