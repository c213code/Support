"use client";

import { useState } from "react";
import type { IssueDTO } from "@/lib/types";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { Avatar } from "@/components/Avatar";
import { groupColor } from "@/lib/groups";
import { issueLinks } from "@/lib/report";
import {
  IconTicket,
  IconEdit,
  IconTrash,
  IconExternalLink,
  IconLink,
  IconSend,
} from "@/components/Icons";

type Column = {
  key: "sent" | "active" | "resolved";
  title: string;
  statuses: readonly IssueStatus[];
  dropStatus: IssueStatus;
  // Цветная точка в заголовке колонки: три серые колонки взглядом не
  // различаются, а цвет тут совпадает с полосой на карточках того же
  // статуса — глаз цепляется за один и тот же код.
  dot: string;
};

// Три колонки по просьбе: "отправили в группу" (ещё не начали смотреть),
// "в работе или пендинг" (объединены — это один рабочий процесс), "решено".
// Внутри средней колонки статус переключается парой кнопок, не перетаскиванием.
const COLUMNS: Column[] = [
  {
    key: "sent",
    title: "Отправлено",
    statuses: ["SENT"],
    dropStatus: "SENT",
    dot: "bg-violet-400",
  },
  {
    key: "active",
    title: "В работе / Пендинг",
    statuses: ["IN_PROGRESS", "PENDING", "ESCALATED"],
    dropStatus: "IN_PROGRESS",
    dot: "bg-sky-400",
  },
  {
    key: "resolved",
    title: "Решено",
    statuses: ["RESOLVED"],
    dropStatus: "RESOLVED",
    dot: "bg-emerald-400",
  },
];

export function KanbanBoard({
  issues,
  onStatusChange,
  onEdit,
  onDelete,
  onMerge,
  onEscalate,
  size = "compact",
}: {
  issues: IssueDTO[];
  onStatusChange: (issue: IssueDTO, status: IssueStatus) => void;
  onEdit?: (issue: IssueDTO) => void;
  onDelete?: (issue: IssueDTO) => void;
  onMerge?: (issue: IssueDTO) => void;
  // ESCALATED — единственный статус, для которого мало сменить значение:
  // нужно ещё выбрать команду. Поэтому вместо прямого onStatusChange у него
  // отдельный колбэк, открывающий диалог (см. EscalateDialog).
  onEscalate?: (issue: IssueDTO) => void;
  size?: "compact" | "large";
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<Column["key"] | null>(null);
  const large = size === "large";

  function handleDrop(column: Column) {
    setOverColumn(null);
    const issue = issues.find((i) => i.id === draggingId);
    setDraggingId(null);
    if (!issue || column.statuses.includes(issue.status)) return;
    onStatusChange(issue, column.dropStatus);
  }

  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-3 ${large ? "gap-4" : "gap-3"}`}
    >
      {COLUMNS.map((column) => {
        const items = issues.filter((i) => column.statuses.includes(i.status));
        const isOver = overColumn === column.key;
        return (
          <div
            key={column.key}
            onDragOver={(e) => {
              e.preventDefault();
              setOverColumn(column.key);
            }}
            onDragLeave={(e) => {
              // dragleave стреляет и когда курсор переходит на карточку
              // внутри той же колонки — без этой проверки подсветка
              // колонки мигает всю дорогу, пока тащишь тикет.
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) {
                return;
              }
              setOverColumn((c) => (c === column.key ? null : c));
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDrop(column);
            }}
            className={`flex flex-col rounded-xl border transition ${
              large ? "min-h-[60vh] gap-3 p-3" : "min-h-[140px] gap-2 p-2"
            } ${
              isOver
                ? "border-brand-400 bg-brand-50/50"
                : "border-slate-200 bg-slate-50/60"
            }`}
          >
            <div className="flex items-center justify-between px-1">
              <h3
                className={`flex items-center gap-2 font-semibold text-slate-700 ${large ? "text-base" : "text-sm"}`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${column.dot}`}
                />
                {column.title}
              </h3>
              <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-slate-400 ring-1 ring-slate-200">
                {items.length}
              </span>
            </div>

            {items.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-xs text-slate-400">
                Пусто
              </p>
            ) : (
              items.map((issue) => {
                const color = groupColor(issue.groupName);
                return (
                  <div
                    key={issue.id}
                    draggable
                    onDragStart={() => setDraggingId(issue.id)}
                    onDragEnd={() => {
                      setDraggingId(null);
                      setOverColumn(null);
                    }}
                    className={`cursor-grab rounded-lg border-l-4 border-y border-r border-slate-200 bg-white shadow-sm transition active:cursor-grabbing ${
                      large ? "p-3.5 text-sm" : "p-2.5 text-sm"
                    } ${STATUS_META[issue.status].bar} ${
                      draggingId === issue.id ? "opacity-40" : ""
                    }`}
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${color.bg} ${color.text}`}
                      >
                        {issue.groupName} {issue.groupEmoji}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        {onMerge && (
                          <button
                            onClick={() => onMerge(issue)}
                            title="Это дубль — объединить с другим тикетом"
                            className="text-slate-300 hover:text-accent-600"
                          >
                            <IconLink className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {onEdit && (
                          <button
                            onClick={() => onEdit(issue)}
                            title="Изменить тикет"
                            className="text-slate-300 hover:text-slate-600"
                          >
                            <IconEdit className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {onDelete && (
                          <button
                            onClick={() => onDelete(issue)}
                            title="Удалить тикет"
                            className="text-slate-300 hover:text-red-500"
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="text-slate-900">{issue.description}</p>
                    {issueLinks(issue).map((link, i) => (
                      <a
                        key={link}
                        href={link}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 flex items-center gap-1 text-xs text-accent-600 hover:underline"
                      >
                        <IconExternalLink className="h-3 w-3 shrink-0" />
                        {i === 0
                          ? "Открыть в Telegram"
                          : `Ещё обращение №${i + 1}`}
                      </a>
                    ))}
                    {issue.escalatedTeam && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-orange-600">
                        <IconSend className="h-3 w-3 shrink-0" />
                        Передано: {issue.escalatedTeam}
                        {issue.escalatedAssignee
                          ? ` (${issue.escalatedAssignee})`
                          : ""}
                      </p>
                    )}
                    {issue.ticketLink && (
                      <a
                        href={issue.ticketLink}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 flex items-center gap-1 truncate text-xs text-brand-600 hover:underline"
                      >
                        <IconTicket className="h-3 w-3 shrink-0" />
                        {issue.ticketLink}
                      </a>
                    )}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      {column.key === "active" ? (
                        <div className="flex flex-wrap gap-1">
                          {(["IN_PROGRESS", "PENDING"] as const).map((s) => (
                            <button
                              key={s}
                              onClick={() => onStatusChange(issue, s)}
                              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                                issue.status === s
                                  ? STATUS_META[s].badge
                                  : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                              }`}
                            >
                              {STATUS_META[s].emoji} {STATUS_META[s].label}
                            </button>
                          ))}
                          {onEscalate && (
                            <button
                              onClick={() => onEscalate(issue)}
                              title="Передать другой команде"
                              className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                                issue.status === "ESCALATED"
                                  ? STATUS_META.ESCALATED.badge
                                  : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                              }`}
                            >
                              {STATUS_META.ESCALATED.emoji}{" "}
                              {STATUS_META.ESCALATED.label}
                            </button>
                          )}
                        </div>
                      ) : (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_META[issue.status].badge}`}
                        >
                          {STATUS_META[issue.status].emoji}{" "}
                          {STATUS_META[issue.status].label}
                        </span>
                      )}
                      <Avatar name={issue.createdBy} size="sm" />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
