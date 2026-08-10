"use client";

import { useState } from "react";
import type { GroupPresetDTO } from "@/lib/types";
import { Avatar } from "@/components/Avatar";
import { ISSUE_STATUSES, STATUS_META, type IssueStatus } from "@/lib/status";
import { useAiCleaningEnabled } from "@/lib/useAiCleaningEnabled";
import { IconRefresh } from "@/components/Icons";

export type IssueFormValues = {
  groupName: string;
  groupEmoji: string | null;
  description: string;
  telegramLink: string;
  status: IssueStatus;
  note: string;
  ticketLink: string;
};

export type IssueFormInitial = Partial<{
  id: string;
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
  currentAgent: string;
  initial?: IssueFormInitial;
  showGroupPicker?: boolean;
  fixedGroupName?: string;
  onCancel: () => void;
  onSubmit: (values: IssueFormValues) => Promise<void>;
};

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100";

export function IssueForm({
  groups,
  currentAgent,
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
    initial?.status ?? "SENT"
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [ticketLink, setTicketLink] = useState(initial?.ticketLink ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "Вернуть без ИИ" — путь назад для тикета, чей описание переписал ИИ:
  // подтягиваем исходное Telegram-сообщение и то, что дала бы обычная
  // regex-чистка (см. GET /api/issues/[id]/raw-source), чтобы не вычищать
  // чужой ИИ-текст руками, а начать с предсказуемого варианта. Показываем
  // только когда тогл ИИ включён и у тикета вообще есть источник — иначе
  // кнопка либо бессмысленна (regex и так всё, что было), либо
  // возвращать неоткуда (тикет заведён вручную, без сообщения).
  const aiCleaningEnabled = useAiCleaningEnabled();
  const canRevertToRegex = Boolean(
    initial?.id && initial?.telegramLink && aiCleaningEnabled
  );
  const [showSource, setShowSource] = useState(false);
  const [source, setSource] = useState<{
    raw: string;
    regexCleaned: string;
  } | null>(null);
  const [sourceState, setSourceState] = useState<
    "idle" | "loading" | "empty"
  >("idle");

  const author = initial?.createdBy ?? currentAgent;

  async function handleToggleSource() {
    if (showSource) {
      setShowSource(false);
      return;
    }
    setShowSource(true);
    if (source || sourceState === "loading") return;
    setSourceState("loading");
    const res = await fetch(`/api/issues/${initial!.id}/raw-source`);
    const data = await res.json();
    if (data.regexCleaned) {
      setSource(data);
      setSourceState("idle");
    } else {
      setSourceState("empty");
    }
  }

  function handleUseRegexVersion() {
    if (!source) return;
    if (
      description.trim() &&
      description.trim() !== source.regexCleaned.trim() &&
      !window.confirm(
        "Заменить текущее описание вариантом без ИИ? Несохранённые правки будут потеряны."
      )
    ) {
      return;
    }
    setDescription(source.regexCleaned);
  }

  function pickStatus(next: IssueStatus) {
    setStatus(next);
    // При переводе в "Решено" сразу подставляем "Имя шешті", если заметка
    // ещё пустая — чтобы в репорте было видно, кто закрыл.
    if (next === "RESOLVED" && !note.trim() && author) {
      setNote(`${author} шешті`);
    }
  }

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
      className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex items-center justify-between gap-3">
        {showGroupPicker && !fixedGroupName ? (
          <div className="flex flex-1 flex-wrap items-center gap-2">
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
              className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
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
                className="min-w-[220px] flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
              />
            )}
          </div>
        ) : (
          <span />
        )}

        <div
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-slate-50 py-1 pl-1 pr-2.5 text-xs text-slate-500 ring-1 ring-slate-200"
          title="Кто ведёт этот тикет"
        >
          <Avatar name={author} size="sm" />
          {author}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-slate-500">
            Описание проблемы
          </label>
          {canRevertToRegex && (
            <button
              type="button"
              onClick={handleToggleSource}
              className="flex items-center gap-1 text-xs font-medium text-accent-600 hover:underline"
            >
              <IconRefresh className="h-3 w-3" />
              {showSource ? "Скрыть" : "ИИ написал не то?"}
            </button>
          )}
        </div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          className={`${inputClass} resize-y`}
          placeholder="Оқушы аккаунтына кіре алмай жатыр..."
        />
        {showSource && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs">
            {sourceState === "loading" ? (
              <p className="text-slate-400">Загружаем исходное сообщение…</p>
            ) : sourceState === "empty" ? (
              <p className="text-slate-400">
                Исходное сообщение не нашлось — похоже, тикет создан вручную.
              </p>
            ) : (
              source && (
                <>
                  <p className="mb-1 font-medium text-slate-500">
                    Исходное сообщение из Telegram:
                  </p>
                  <p className="mb-2 whitespace-pre-wrap text-slate-600">
                    {source.raw}
                  </p>
                  <button
                    type="button"
                    onClick={handleUseRegexVersion}
                    className="rounded-md bg-white px-2.5 py-1.5 text-xs font-medium text-brand-600 shadow-sm ring-1 ring-slate-300 hover:bg-brand-50"
                  >
                    ↺ Вставить вариант без ИИ, напишу сам
                  </button>
                </>
              )
            )}
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-500">
          Ссылка на сообщение в Telegram (необязательно)
        </label>
        <input
          type="text"
          value={telegramLink}
          onChange={(e) => setTelegramLink(e.target.value)}
          className={inputClass}
          placeholder="https://t.me/c/..."
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-slate-500">Статус</label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ISSUE_STATUSES.map((s) => {
            const meta = STATUS_META[s];
            const selected = status === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => pickStatus(s)}
                className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition ${
                  selected ? meta.active : meta.idle
                }`}
              >
                {meta.emoji} {meta.label}
              </button>
            );
          })}
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
          className={`${inputClass} resize-y`}
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
          className={inputClass}
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
          className="rounded-lg bg-brand-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50"
        >
          {submitting ? "Сохраняем..." : "Сохранить"}
        </button>
      </div>
    </form>
  );
}
