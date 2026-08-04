"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { GroupPresetDTO, IssueDTO } from "@/lib/types";
import { formatDateHuman, shiftDateString, todayDateString } from "@/lib/date";
import { IssueForm, type IssueFormValues } from "@/components/IssueForm";
import { groupIssues } from "@/lib/report";
import { AGENT_STORAGE_KEY } from "@/lib/agents";

function statusBadge(status: "RESOLVED" | "PENDING") {
  return status === "RESOLVED" ? (
    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
      ✅ Решено
    </span>
  ) : (
    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
      ⚠️ Пендинг
    </span>
  );
}

export function Dashboard({ initialDate }: { initialDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [issues, setIssues] = useState<IssueDTO[]>([]);
  const [groups, setGroups] = useState<GroupPresetDTO[]>([]);
  const [reportText, setReportText] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [addingToGroup, setAddingToGroup] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [defaultAgent, setDefaultAgent] = useState(() => {
    if (typeof window === "undefined") return "Ерош";
    return window.localStorage.getItem(AGENT_STORAGE_KEY) ?? "Ерош";
  });

  const loadGroups = useCallback(async () => {
    const res = await fetch("/api/groups");
    const data = await res.json();
    setGroups(data.groups ?? []);
  }, []);

  const loadIssues = useCallback(async (d: string) => {
    setLoading(true);
    const [issuesRes, reportRes] = await Promise.all([
      fetch(`/api/issues?date=${d}`),
      fetch(`/api/report?date=${d}`),
    ]);
    const issuesData = await issuesRes.json();
    const reportData = await reportRes.json();
    setIssues(issuesData.issues ?? []);
    setReportText(reportData.text ?? "");
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on date change
    loadIssues(date);
    router.replace(`/?date=${date}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  function rememberAgent(agent: string) {
    setDefaultAgent(agent);
    window.localStorage.setItem(AGENT_STORAGE_KEY, agent);
  }

  async function handleCreate(values: IssueFormValues) {
    rememberAgent(values.createdBy);
    await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, reportDate: date }),
    });
    setAddingToGroup(null);
    setAddingNew(false);
    await Promise.all([loadIssues(date), loadGroups()]);
  }

  async function handleUpdate(id: string, values: IssueFormValues) {
    rememberAgent(values.createdBy);
    await fetch(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    setEditingId(null);
    await loadIssues(date);
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Удалить этот тикет?")) return;
    await fetch(`/api/issues/${id}`, { method: "DELETE" });
    await loadIssues(date);
  }

  async function handleMove(
    groupItems: IssueDTO[],
    index: number,
    direction: -1 | 1
  ) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= groupItems.length) return;
    const a = groupItems[index];
    const b = groupItems[targetIndex];
    await Promise.all([
      fetch(`/api/issues/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: b.position }),
      }),
      fetch(`/api/issues/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: a.position }),
      }),
    ]);
    await loadIssues(date);
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(reportText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const grouped = groupIssues(issues, groups);
  const usedGroupNames = new Set(grouped.map((g) => g.name));
  const isToday = date === todayDateString();

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDate(shiftDateString(date, -1))}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            aria-label="Предыдущий день"
          >
            ←
          </button>
          <div className="flex flex-col items-center">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            />
            <span className="mt-0.5 text-xs text-slate-400">
              {formatDateHuman(date)}
              {isToday ? " · сегодня" : ""}
            </span>
          </div>
          <button
            onClick={() => setDate(shiftDateString(date, 1))}
            className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            aria-label="Следующий день"
          >
            →
          </button>
        </div>

        <button
          onClick={() => setDate(todayDateString())}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
        >
          Сегодня
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Загрузка...</p>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <section key={group.name}>
              <h2 className="mb-2 flex items-center gap-1 text-base font-semibold text-slate-900">
                {group.name}
                <span>{group.emoji}</span>
              </h2>
              <div className="space-y-2">
                {group.items.map((issue, index) => (
                  <div key={issue.id}>
                    {editingId === issue.id ? (
                      <IssueForm
                        groups={groups}
                        defaultAgent={defaultAgent}
                        initial={issue}
                        showGroupPicker={false}
                        fixedGroupName={issue.groupName}
                        onCancel={() => setEditingId(null)}
                        onSubmit={(values) => handleUpdate(issue.id, values)}
                      />
                    ) : (
                      <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1">
                            <p className="text-sm text-slate-900">
                              {index + 1}. {issue.description}
                            </p>
                            {issue.telegramLink && (
                              <a
                                href={issue.telegramLink}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 block truncate text-xs text-sky-600 hover:underline"
                              >
                                {issue.telegramLink}
                              </a>
                            )}
                            <p className="mt-1 text-sm text-slate-500">
                              {issue.note || (
                                <span className="italic text-slate-300">
                                  без заметки
                                </span>
                              )}
                            </p>
                            {issue.ticketLink && (
                              <a
                                href={issue.ticketLink}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 block truncate text-xs text-indigo-600 hover:underline"
                              >
                                🎫 {issue.ticketLink}
                              </a>
                            )}
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              {statusBadge(issue.status)}
                              <span className="text-xs text-slate-400">
                                {issue.createdBy}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex gap-1">
                              <button
                                onClick={() =>
                                  handleMove(group.items, index, -1)
                                }
                                disabled={index === 0}
                                className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 disabled:opacity-20"
                                aria-label="Вверх"
                              >
                                ↑
                              </button>
                              <button
                                onClick={() =>
                                  handleMove(group.items, index, 1)
                                }
                                disabled={index === group.items.length - 1}
                                className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 disabled:opacity-20"
                                aria-label="Вниз"
                              >
                                ↓
                              </button>
                            </div>
                            <button
                              onClick={() => setEditingId(issue.id)}
                              className="text-xs text-slate-500 hover:text-slate-900"
                            >
                              Изменить
                            </button>
                            <button
                              onClick={() => handleDelete(issue.id)}
                              className="text-xs text-red-400 hover:text-red-600"
                            >
                              Удалить
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {addingToGroup === group.name ? (
                <div className="mt-2">
                  <IssueForm
                    groups={groups}
                    defaultAgent={defaultAgent}
                    showGroupPicker={false}
                    fixedGroupName={group.name}
                    onCancel={() => setAddingToGroup(null)}
                    onSubmit={handleCreate}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setAddingToGroup(group.name)}
                  className="mt-2 text-sm text-slate-500 hover:text-slate-900"
                >
                  + Добавить тикет в «{group.name}»
                </button>
              )}
            </section>
          ))}

          <section>
            {addingNew ? (
              <IssueForm
                groups={groups}
                defaultAgent={defaultAgent}
                showGroupPicker
                onCancel={() => setAddingNew(false)}
                onSubmit={handleCreate}
              />
            ) : (
              <button
                onClick={() => setAddingNew(true)}
                className="rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-500 hover:border-slate-400 hover:text-slate-900"
              >
                + Добавить тикет{usedGroupNames.size ? " в новую группу" : ""}
              </button>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">
                Готовый репорт
              </h3>
              <button
                onClick={handleCopy}
                disabled={!reportText}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {copied ? "Скопировано ✓" : "Скопировать"}
              </button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-3 text-sm text-slate-800 ring-1 ring-slate-200">
              {reportText || "Нет тикетов за этот день."}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
