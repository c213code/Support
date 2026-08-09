"use client";

import { useEffect, useRef, useState } from "react";
import type { IssueDTO } from "@/lib/types";
import { IconCheck } from "@/components/Icons";

// Спрашиваем "что сделали" в момент перевода тикета в "Решено" — заметка
// уходит прямо в текст репорта, и если её не заполнить сразу, к вечеру уже
// никто не помнит, чем закончилось. Дефолт "Имя шешті" остаётся тем же, что
// подставлялся раньше молча, — теперь его просто видно и можно дополнить.
export function ResolveDialog({
  issue,
  currentAgent,
  onCancel,
  onConfirm,
}: {
  issue: IssueDTO;
  currentAgent: string;
  onCancel: () => void;
  onConfirm: (note: string) => Promise<void>;
}) {
  const defaultNote = issue.note?.trim()
    ? issue.note
    : currentAgent
      ? `${currentAgent} шешті`
      : "";
  const [note, setNote] = useState(defaultNote);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    // Курсор в конец, а не выделение всего текста: дефолт "Имя шешті"
    // обычно дополняют, а не переписывают с нуля.
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
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
      await onConfirm(note.trim());
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
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <IconCheck className="h-3.5 w-3.5" />
            </span>
            Как решили?
          </h2>
          <p className="mt-2 line-clamp-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            {issue.description}
          </p>
        </div>

        <div className="space-y-1">
          <label
            htmlFor="resolve-note"
            className="text-xs font-medium text-slate-500"
          >
            Заметка попадёт в репорт
          </label>
          <textarea
            id="resolve-note"
            ref={textareaRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter — привычный "отправить" для однострочных
              // заметок, чтобы не тянуться мышкой к кнопке.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={3}
            placeholder="Например: Алпа шешті, тест қайта ашылды"
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
            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
          >
            <IconCheck className="h-3.5 w-3.5" />
            {saving ? "Сохраняем..." : "Решено"}
          </button>
        </div>
      </form>
    </div>
  );
}
