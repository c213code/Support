"use client";

import { useState } from "react";
import type { GroupPresetDTO, IssueStatus } from "@/lib/types";
import { AGENTS } from "@/lib/agents";

export type IssueFormValues = {
  groupName: string;
  groupEmoji: string | null;
  description: string;
  telegramLink: string;
  status: IssueStatus;
  note: string;
  ticketLink: string;
  createdBy: string;
};

export type IssueFormInitial = Partial<{
  groupName: string;
  description: string;
  telegramLink: string | null;
  status: IssueStatus;
  note: string | null;
  ticketLink: string | null;
  createdBy: string;
}>;

type Props = {
  groups: GroupPresetDTO[];
  defaultAgent: string;
  initial?: IssueFormInitial;
  showGroupPicker?: boolean;
  fixedGroupName?: string;
  onCancel: () => void;
  onSubmit: (values: IssueFormValues) => Promise<void>;
};

export function IssueForm({
  groups,
  defaultAgent,
  initial,
  showGroupPicker = true,
  fixedGroupName,
  onCancel,
  onSubmit,
}: Props) {
  const [groupMode, setGroupMode] = useState<"preset" | "custom">(
    initial?.groupName && !groups.some((g) => g.name === initial.groupName)
      ? "custom"
      : "preset"
  );
  const [groupName, setGroupName] = useState(
    initial?.groupName ?? fixedGroupName ?? groups[0]?.name ?? ""
  );
  const [customGroupName, setCustomGroupName] = useState(
    groupMode === "custom" ? (initial?.groupName ?? "") : ""
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [telegramLink, setTelegramLink] = useState(
    initial?.telegramLink ?? ""
  );
  const [status, setStatus] = useState<IssueStatus>(
    initial?.status ?? "PENDING"
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [ticketLink, setTicketLink] = useState(initial?.ticketLink ?? "");
  const [createdBy, setCreatedBy] = useState(
    initial?.createdBy ?? defaultAgent
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const finalGroupName =
      fixedGroupName ??
      (groupMode === "custom" ? customGroupName.trim() : groupName);

    if (!finalGroupName) {
      setError("Укажите группу");
      return;
    }
    if (!description.trim()) {
      setError("Опишите проблему");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const preset = groups.find((g) => g.name === finalGroupName);
      await onSubmit({
        groupName: finalGroupName,
        groupEmoji: preset?.emoji ?? null,
        description: description.trim(),
        telegramLink: telegramLink.trim(),
        status,
        note: note.trim(),
        ticketLink: ticketLink.trim(),
        createdBy,
      });
    } catch {
      setError("Не удалось сохранить, попробуйте ещё раз");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      {showGroupPicker && !fixedGroupName && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">Группа</label>
          <div className="flex flex-wrap gap-2">
            <select
              value={groupMode === "preset" ? groupName : "__custom__"}
              onChange={(e) => {
                if (e.target.value === "__custom__") {
                  setGroupMode("custom");
                } else {
                  setGroupMode("preset");
                  setGroupName(e.target.value);
                }
              }}
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
            >
              {groups.map((g) => (
                <option key={g.id} value={g.name}>
                  {g.name} {g.emoji ?? ""}
                </option>
              ))}
              <option value="__custom__">+ Другая группа / личный чат</option>
            </select>
            {groupMode === "custom" && (
              <input
                type="text"
                value={customGroupName}
                onChange={(e) => setCustomGroupName(e.target.value)}
                placeholder="Например: Жеке чат: Асем Қайырбекова"
                className="min-w-[240px] flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            )}
          </div>
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-500">
          Описание проблемы
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Оқушы аккаунтына кіре алмай жатыр..."
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-500">
          Ссылка на сообщение в Telegram (необязательно)
        </label>
        <input
          type="text"
          value={telegramLink}
          onChange={(e) => setTelegramLink(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="https://t.me/c/..."
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">Статус</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setStatus("RESOLVED")}
              className={`flex-1 rounded-lg border px-3 py-1.5 text-sm transition ${
                status === "RESOLVED"
                  ? "border-emerald-600 bg-emerald-50 text-emerald-700"
                  : "border-slate-300 text-slate-500"
              }`}
            >
              ✅ Решено
            </button>
            <button
              type="button"
              onClick={() => setStatus("PENDING")}
              className={`flex-1 rounded-lg border px-3 py-1.5 text-sm transition ${
                status === "PENDING"
                  ? "border-amber-600 bg-amber-50 text-amber-700"
                  : "border-slate-300 text-slate-500"
              }`}
            >
              ⚠️ Пендинг
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs font-medium text-slate-500">
            Кто вносит
          </label>
          <select
            value={createdBy}
            onChange={(e) => setCreatedBy(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {AGENTS.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-500">
          Заметка (что сделали / статус)
        </label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="Алпа шешті / Пока смотрим / ..."
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-500">
          Ссылка на тикет (если завели баг-репорт)
        </label>
        <input
          type="text"
          value={ticketLink}
          onChange={(e) => setTicketLink(e.target.value)}
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          placeholder="https://juz.atlassian.net/browse/DV-..."
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submitting ? "Сохраняем..." : "Сохранить"}
        </button>
      </div>
    </form>
  );
}
