"use client";

import { useEffect, useState } from "react";
import type { EscalationTeam } from "@/lib/escalation";
import { Modal } from "@/components/Modal";

type JiraUser = { accountId: string; displayName: string };
type Priority = "low" | "medium" | "high" | "critical";
type Draft = {
  summary: string;
  component: string;
  problem: string;
  steps: string;
  actual: string;
  expected: string;
  priority: Priority;
  priorityReason: string;
  telegramLink: string | null;
  photoCount: number;
  aiFailed: boolean;
};
export type CreatedBug = { key: string; url: string; sprint: string | null; attached: number; warnings: string[] };

const PRIORITY_LABEL: Record<Priority, string> = {
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  critical: "Критический",
};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100";

// Баг в Jira по шаблону, которым их заводят руками: ИИ пишет заголовок и
// разделы, человек смотрит и правит, «Создать» — и ссылка встаёт в тикет.
// Исполнитель — тот, кого выбрали при передаче, если его Jira-аккаунт уже
// известен; выбранный здесь запоминается для следующих багов.
export function JiraBugDialog({
  issueId,
  team,
  assignee,
  onCancel,
  onCreated,
}: {
  issueId: string;
  team: EscalationTeam;
  assignee: string;
  onCancel: () => void;
  onCreated: (bug: CreatedBug) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [users, setUsers] = useState<JiraUser[]>([]);
  const [accountId, setAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/issues/${issueId}/jira/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ team, assignee }),
      }).then((r) => r.json()),
      fetch("/api/jira/users").then((r) => r.json()),
    ])
      .then(([d, u]) => {
        if (cancelled) return;
        if (d.error) {
          setError(d.error);
          return;
        }
        setDraft(d.draft);
        setUsers(u.users ?? []);
        if (u.error) setError(u.error);
        if (d.account?.accountId) setAccountId(d.account.accountId);
      })
      .catch(() => !cancelled && setError("Не получилось подготовить баг"));
    return () => {
      cancelled = true;
    };
  }, [issueId, team, assignee]);

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    const user = users.find((u) => u.accountId === accountId);
    try {
      const res = await fetch(`/api/issues/${issueId}/jira`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          team,
          assignee,
          summary: draft.summary,
          component: draft.component,
          problem: draft.problem,
          steps: draft.steps,
          actual: draft.actual,
          expected: draft.expected,
          priority: draft.priority,
          telegramLink: draft.telegramLink,
          accountId: user?.accountId ?? null,
          displayName: user?.displayName ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Не получилось создать баг");
        return;
      }
      onCreated(data.created);
    } catch {
      setError("Не получилось создать баг");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onCancel} labelledBy="jira-bug-title" size="lg">
      <form
        onSubmit={handleCreate}
        className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
      >
        <h2 id="jira-bug-title" className="text-sm font-semibold text-slate-900">
          🐞 Баг в Jira
        </h2>

        {!draft && !error && (
          <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
            ИИ пишет баг по сообщениям куратора…
          </p>
        )}

        {draft && (
          <>
            {draft.aiFailed && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                ИИ недоступен — подставлено описание тикета, допиши разделы сам.
              </p>
            )}
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-500">Заголовок</span>
              <input
                value={draft.summary}
                onChange={(e) => update("summary", e.target.value)}
                className={inputClass}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_11rem]">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-500">Компонент</span>
                <input
                  value={draft.component}
                  onChange={(e) => update("component", e.target.value)}
                  placeholder="Страница, экран, тест"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-500">Приоритет</span>
                <select
                  value={draft.priority}
                  onChange={(e) => update("priority", e.target.value as Priority)}
                  className={inputClass}
                >
                  {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
                    <option key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {draft.priorityReason && (
              <p className="-mt-1 text-[11px] text-slate-400">ИИ: {draft.priorityReason}</p>
            )}
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-500">Описание проблемы</span>
              <textarea
                value={draft.problem}
                onChange={(e) => update("problem", e.target.value)}
                rows={4}
                className={inputClass}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-slate-500">Шаги воспроизведения — по одному в строке</span>
              <textarea
                value={draft.steps}
                onChange={(e) => update("steps", e.target.value)}
                rows={4}
                placeholder={"Открыть курс…\nПерейти в урок…\nНажать…"}
                className={inputClass}
              />
            </label>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-500">Фактический результат</span>
                <textarea
                  value={draft.actual}
                  onChange={(e) => update("actual", e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-500">Ожидаемый результат</span>
                <textarea
                  value={draft.expected}
                  onChange={(e) => update("expected", e.target.value)}
                  rows={2}
                  className={inputClass}
                />
              </label>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-500">Исполнитель в Jira</span>
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  className={inputClass}
                >
                  <option value="">Без исполнителя</option>
                  {users.map((u) => (
                    <option key={u.accountId} value={u.accountId}>
                      {u.displayName}
                    </option>
                  ))}
                </select>
                {assignee && !accountId && users.length > 0 && (
                  <span className="text-[11px] text-slate-400">
                    Выбери, кто в Jira «{assignee}», — в следующий раз подставится сам
                  </span>
                )}
              </label>
              <label className="block space-y-1">
                <span className="text-xs font-medium text-slate-500">Ссылка на сообщение</span>
                <input
                  value={draft.telegramLink ?? ""}
                  onChange={(e) => update("telegramLink", e.target.value || null)}
                  placeholder="https://t.me/c/..."
                  className={inputClass}
                />
              </label>
            </div>
            <p className="text-xs text-slate-400">
              Bug · в активный спринт
              {draft.photoCount > 0 ? ` · скриншотов приложим: ${draft.photoCount}` : " · скриншотов нет"}
            </p>
          </>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={!draft || saving}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "Создаём…" : "Создать в Jira"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
