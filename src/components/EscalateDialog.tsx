"use client";

import { useEffect, useRef, useState } from "react";
import type { IssueDTO } from "@/lib/types";
import { ESCALATION_TEAMS, type EscalationTeam } from "@/lib/escalation";
import { IconSend } from "@/components/Icons";

export type EscalateValues = {
  escalatedTeam: EscalationTeam;
  escalatedAssignee: string;
  note: string;
};

function escalationNote(team: EscalationTeam, assignee: string): string {
  return `Передано: ${team}${assignee.trim() ? ` (${assignee.trim()})` : ""}`;
}

// Спрашиваем "кому передали" в момент перевода тикета в статус "Передано"
// — та же логика, что у ResolveDialog для "Решено": решение/передача без
// заметки означает, что к вечеру никто не вспомнит, куда тикет делся.
// Работает и для первой передачи, и для правки уже переданного (кнопка
// остаётся кликабельной и после выбора команды).
export function EscalateDialog({
  issue,
  onCancel,
  onConfirm,
}: {
  issue: IssueDTO;
  onCancel: () => void;
  onConfirm: (values: EscalateValues) => Promise<void>;
}) {
  const [team, setTeam] = useState<EscalationTeam>(
    (issue.escalatedTeam as EscalationTeam | null) ?? ESCALATION_TEAMS[0]
  );
  const [assignee, setAssignee] = useState(issue.escalatedAssignee ?? "");
  const [note, setNote] = useState(
    issue.note?.trim() ?? escalationNote(team, assignee)
  );
  const [noteTouched, setNoteTouched] = useState(Boolean(issue.note?.trim()));
  const [saving, setSaving] = useState(false);
  const assigneeRef = useRef<HTMLInputElement>(null);

  // Пока заметку не тронули руками — держим её синхронной с выбранной
  // командой ("Передано: Backend (Аян)"), чтобы в репорте сразу было видно
  // куда ушёл тикет, а не просто "Пендинг". Синхронизация идёт прямо в
  // обработчиках изменений (handleTeamChange/handleAssigneeChange), а не
  // через эффект — обновление состояния внутри useEffect вызывает
  // каскадный лишний рендер.
  function handleTeamChange(next: EscalationTeam) {
    setTeam(next);
    if (!noteTouched) setNote(escalationNote(next, assignee));
  }

  function handleAssigneeChange(next: string) {
    setAssignee(next);
    if (!noteTouched) setNote(escalationNote(team, next));
  }

  useEffect(() => {
    assigneeRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm({
        escalatedTeam: team,
        escalatedAssignee: assignee.trim(),
        note: note.trim(),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16 sm:pt-24"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
      >
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-orange-100 text-orange-700">
              <IconSend className="h-3.5 w-3.5" />
            </span>
            Кому передали?
          </h2>
          <p className="mt-2 line-clamp-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {issue.description}
          </p>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">Команда</label>
          <div className="grid grid-cols-2 gap-2">
            {ESCALATION_TEAMS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => handleTeamChange(t)}
                className={`rounded-lg border px-2 py-1.5 text-sm font-medium transition ${
                  team === t
                    ? "border-orange-500 bg-orange-50 text-orange-700 ring-1 ring-orange-200"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="escalate-assignee"
            className="text-xs font-medium text-slate-500"
          >
            Кто занимается (необязательно)
          </label>
          <input
            id="escalate-assignee"
            ref={assigneeRef}
            type="text"
            value={assignee}
            onChange={(e) => handleAssigneeChange(e.target.value)}
            placeholder="Например: Аян"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        <div className="space-y-1">
          <label
            htmlFor="escalate-note"
            className="text-xs font-medium text-slate-500"
          >
            Заметка попадёт в репорт
          </label>
          <textarea
            id="escalate-note"
            value={note}
            onChange={(e) => {
              setNoteTouched(true);
              setNote(e.target.value);
            }}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
        </div>

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
            disabled={saving}
            className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-orange-700 disabled:opacity-50"
          >
            <IconSend className="h-3.5 w-3.5" />
            {saving ? "Сохраняем..." : "Передать"}
          </button>
        </div>
      </form>
    </div>
  );
}
