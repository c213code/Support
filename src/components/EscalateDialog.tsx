"use client";

import { useEffect, useRef, useState } from "react";
import type { IssueDTO } from "@/lib/types";
import {
  ESCALATION_TEAMS,
  escalationNote,
  type EscalationTeam,
} from "@/lib/escalation";
import { useDevTeams } from "@/lib/useDevTeams";
import { Modal } from "@/components/Modal";
import { AssigneePicker } from "@/components/AssigneePicker";
import { JiraBugDialog } from "@/components/JiraBugDialog";
import { IconSend } from "@/components/Icons";

export type EscalateValues = {
  escalatedTeam: EscalationTeam;
  escalatedAssignee: string;
  note: string;
};

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
  const { teams: devTeams, jiraEnabled } = useDevTeams();
  // Баг в Jira заводят до передачи — тогда ссылка на него уже есть и в
  // сообщении разработчику, и в репорте. У продукта багов не бывает.
  const [jiraOpen, setJiraOpen] = useState(false);
  const [jiraLink, setJiraLink] = useState(issue.ticketLink);
  // Что после создания бага не вышло: спринт, часть скриншотов.
  const [jiraWarnings, setJiraWarnings] = useState<string[]>([]);
  const canCreateBug = jiraEnabled && team !== "Product";

  // Пока заметку не тронули руками — держим её синхронной с выбранной
  // командой ("Передано: Backend (Аян)"), чтобы в репорте сразу было видно
  // куда ушёл тикет, а не просто "Пендинг". Синхронизация идёт прямо в
  // обработчиках изменений (handleTeamChange/handleAssigneeChange), а не
  // через эффект — обновление состояния внутри useEffect вызывает
  // каскадный лишний рендер.
  function handleTeamChange(next: EscalationTeam) {
    // Человек из прежней команды в новой не работает — сбрасываем. Имя,
    // вписанное руками, не трогаем: его в списке и не было.
    const fromOldTeam = (devTeams[team] ?? []).some((m) => m.name === assignee.trim());
    const nextAssignee = fromOldTeam && next !== team ? "" : assignee;
    setTeam(next);
    setAssignee(nextAssignee);
    if (!noteTouched) setNote(escalationNote(next, nextAssignee));
  }

  function handleAssigneeChange(next: string) {
    setAssignee(next);
    if (!noteTouched) setNote(escalationNote(team, next));
  }

  useEffect(() => {
    assigneeRef.current?.focus();
  }, []);

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
    <Modal onClose={onCancel} labelledBy="escalate-title">
      <form
        onSubmit={handleSubmit}
        className="space-y-4 support-dialog-surface p-5 sm:p-6"
      >
        <div>
          <h2
            id="escalate-title"
            className="flex items-center gap-2 text-sm font-semibold text-slate-900"
          >
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
          <AssigneePicker
            teams={devTeams}
            team={team}
            value={assignee}
            onChange={handleAssigneeChange}
            inputId="escalate-assignee"
            inputRef={assigneeRef}
            inputClassName="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
        </div>

        {jiraLink ? (
          <a
            href={jiraLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:underline"
          >
            🐞 Jira: {jiraLink.split("/").pop()}
            {jiraWarnings.length > 0 && (
              <span className="font-normal text-amber-700"> · {jiraWarnings.join("; ")}</span>
            )}
          </a>
        ) : (
          canCreateBug && (
            <button
              type="button"
              onClick={() => setJiraOpen(true)}
              className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
            >
              🐞 Баг в Jira
            </button>
          )
        )}

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
              // Так же, как в окне "Решено": Enter сохраняет, Shift+Enter —
              // перенос строки. Пока клавиатура набирает слово с подсказками,
              // Enter принадлежит ей, а не форме.
              if (e.key !== "Enter" || e.shiftKey) return;
              if (e.nativeEvent.isComposing) return;
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }}
            rows={2}
            className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
          />
          <p className="text-[11px] text-slate-400">
            Enter — передать, Shift+Enter — новая строка
          </p>
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
      {jiraOpen && (
        <JiraBugDialog
          issueId={issue.id}
          team={team}
          assignee={assignee.trim()}
          onCancel={() => setJiraOpen(false)}
          onCreated={(bug) => {
            setJiraLink(bug.url);
            setJiraWarnings(bug.warnings);
            setJiraOpen(false);
          }}
        />
      )}
    </Modal>
  );
}
