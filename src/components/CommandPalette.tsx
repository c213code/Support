"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { STATUS_META } from "@/lib/status";
import { groupColor } from "@/lib/groups";
import type { IssueDTO } from "@/lib/types";
import {
  IconInbox,
  IconReport,
  IconHistory,
  IconCalendar,
  IconExternalLink,
} from "@/components/Icons";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  Icon?: (p: { className?: string }) => React.ReactElement;
  run: () => void;
};

// Одно окно на всё: ⌘K/Ctrl+K открывает поиск по тикетам дня и список
// действий страницы. Живой смысл — не «модно», а вполне конкретный: на
// доске за день набирается несколько десятков карточек в трёх колонках,
// и «найти вон тот тикет про ДТ» глазами дольше, чем набрать «дт».
export function CommandPalette({
  issues,
  actions,
  onPickIssue,
}: {
  issues: IssueDTO[];
  actions: PaletteAction[];
  // Что делать с найденным тикетом на текущей странице (обычно — открыть
  // его форму редактирования).
  onPickIssue?: (issue: IssueDTO) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const navActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "nav-today",
        label: "Перейти: Сегодня",
        hint: "Дашборд и текст репорта",
        Icon: IconReport,
        run: () => router.push("/"),
      },
      {
        id: "nav-inbox",
        label: "Перейти: Входящие",
        hint: "Доска и лента сообщений",
        Icon: IconInbox,
        run: () => router.push("/inbox"),
      },
      {
        id: "nav-history",
        label: "Перейти: История",
        hint: "Репорты за прошлые дни",
        Icon: IconHistory,
        run: () => router.push("/history"),
      },
    ],
    [router]
  );

  const q = query.trim().toLowerCase();

  const matchedActions = useMemo(() => {
    const all = [...actions, ...navActions];
    if (!q) return all;
    return all.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, navActions, q]);

  const matchedIssues = useMemo(() => {
    if (!q) return issues.slice(0, 6);
    return issues
      .filter(
        (i) =>
          i.description.toLowerCase().includes(q) ||
          i.groupName.toLowerCase().includes(q) ||
          (i.note ?? "").toLowerCase().includes(q)
      )
      .slice(0, 12);
  }, [issues, q]);

  const rows = useMemo(
    () => [
      ...matchedActions.map((a) => ({ kind: "action" as const, action: a })),
      ...matchedIssues.map((i) => ({ kind: "issue" as const, issue: i })),
    ],
    [matchedActions, matchedIssues]
  );

  // Клампим курсор здесь, а не эффектом: setState в useEffect вызывает
  // лишний каскадный рендер, а результат тот же.
  const activeIndex = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    setCursor(0);
  }

  function runRow(index: number) {
    const row = rows[index];
    if (!row) return;
    close();
    if (row.kind === "action") {
      row.action.run();
    } else if (onPickIssue) {
      onPickIssue(row.issue);
    }
  }

  function onInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, Math.max(rows.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runRow(activeIndex);
    }
  }

  if (!open) return null;

  return (
    <Modal onClose={close} size="lg" labelledBy="palette-input">
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3.5">
          <span className="text-slate-300">⌘</span>
          <input
            id="palette-input"
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={onInputKeyDown}
            placeholder="Найти тикет или действие…"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-slate-400"
          />
          <kbd className="shrink-0 rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[55vh] overflow-y-auto p-1.5">
          {rows.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-slate-400">
              Ничего не нашлось
            </p>
          )}

          {rows.map((row, index) => {
            const active = index === activeIndex;
            if (row.kind === "action") {
              const { action } = row;
              const Icon = action.Icon;
              return (
                <button
                  key={action.id}
                  type="button"
                  onMouseMove={() => setCursor(index)}
                  onClick={() => runRow(index)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition ${
                    active ? "bg-brand-50 text-brand-800" : "text-slate-700"
                  }`}
                >
                  {Icon ? (
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" />
                  ) : (
                    <span className="w-4" />
                  )}
                  <span className="flex-1 truncate">{action.label}</span>
                  {action.hint && (
                    <span className="hidden shrink-0 text-xs text-slate-400 sm:inline">
                      {action.hint}
                    </span>
                  )}
                </button>
              );
            }

            const { issue } = row;
            const color = groupColor(issue.groupName);
            const meta = STATUS_META[issue.status];
            return (
              <button
                key={issue.id}
                type="button"
                onMouseMove={() => setCursor(index)}
                onClick={() => runRow(index)}
                className={`flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition ${
                  active ? "bg-brand-50" : ""
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${color.bg} ${color.text}`}
                >
                  {issue.groupEmoji ?? "•"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 block text-sm text-slate-800">
                    {issue.description}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                    <span
                      className={`rounded-full px-1.5 py-px font-medium ${meta.badge}`}
                    >
                      {meta.emoji} {meta.label}
                    </span>
                    {issue.groupName}
                  </span>
                </span>
                <IconExternalLink className="mt-1 h-3 w-3 shrink-0 text-slate-300" />
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-slate-200 bg-slate-50 px-3.5 py-2 text-[11px] text-slate-400">
          <span className="flex items-center gap-1">
            <IconCalendar className="h-3 w-3" />
            {issues.length} тикет(ов) за день
          </span>
          <span className="ml-auto hidden sm:inline">↑↓ выбрать · ↵ открыть</span>
        </div>
      </div>
    </Modal>
  );
}
