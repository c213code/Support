"use client";

import { useState } from "react";
import type { IssueDTO } from "@/lib/types";
import { STATUS_META, type IssueStatus } from "@/lib/status";
import { Avatar } from "@/components/Avatar";
import { BotReplies } from "@/components/BotReplies";
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

// С какого возраста тикет в работе стоит пометить. Три часа — не срок
// выполнения, а срок молчания: по выгрузке рабочих групп агент отвечает на
// обращение за минуты, так что тикет, который держится в "В работе" полдня,
// почти всегда уже сделан и просто не переставлен.
//
// Это прямое следствие того, что статус ставится по репликам в чате: о
// начале работы в чате говорят ("қараймыз"), а о завершении — лишь в трети
// разговоров. Вход в колонку дешевле выхода, и без такой пометки разница
// копится молча.
//
// Считается по statusChangedAt, а не updatedAt: последний обновляется от
// любой правки — поправили описание, ИИ переписал текст, автор сменился с
// "Бота" на живого агента — и счётчик обнулялся, хотя статус не двигался.
const STALL_HOURS = 3;

function stalledHours(issue: IssueDTO): number | null {
  if (issue.status !== "IN_PROGRESS" && issue.status !== "PENDING") return null;
  const hours = Math.floor(
    (Date.now() - new Date(issue.statusChangedAt).getTime()) / 3_600_000
  );
  return hours >= STALL_HOURS ? hours : null;
}

export function KanbanBoard({
  issues,
  onStatusChange,
  onEdit,
  onDelete,
  onMerge,
  onEscalate,
  onDetach,
  onBotRepliesChanged,
  onBotReplyError,
  size = "compact",
  highlightId,
}: {
  issues: IssueDTO[];
  onStatusChange: (issue: IssueDTO, status: IssueStatus) => void;
  onEdit?: (issue: IssueDTO) => void;
  onDelete?: (issue: IssueDTO) => void;
  onMerge?: (issue: IssueDTO) => void;
  // Отвязать приклеенное обращение (см. extraLinks на Issue) — приклеили
  // не туда через "объединить"/"прикрепить" и без отката пришлось бы
  // чинить руками в базе. Только для extraLinks — основную ссылку
  // (issue.telegramLink), с которой тикет и завёлся, так не отвязать.
  onDetach?: (issue: IssueDTO, link: string) => void;
  // ESCALATED — единственный статус, для которого мало сменить значение:
  // нужно ещё выбрать команду. Поэтому вместо прямого onStatusChange у него
  // отдельный колбэк, открывающий диалог (см. EscalateDialog).
  onEscalate?: (issue: IssueDTO) => void;
  // Ответы бота на карточке правятся и удаляются прямо там (см.
  // BotReplies) — доске остаётся перечитать список и показать ошибку.
  onBotRepliesChanged?: () => void;
  onBotReplyError?: (message: string) => void;
  size?: "compact" | "large";
  // Тикет, на который надо обратить внимание (нашли через ⌘K) — подсвечиваем
  // кольцом на пару секунд, иначе после закрытия поиска непонятно, куда
  // смотреть на доске из трёх колонок.
  highlightId?: string | null;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<Column["key"] | null>(null);
  // На узком экране три колонки по 60vh превращаются в простыню на три
  // экрана прокрутки. Показываем по одной, переключаясь табами — доска
  // остаётся доской, а не списком.
  const [mobileColumn, setMobileColumn] = useState<Column["key"]>("active");
  const large = size === "large";

  function handleDrop(column: Column) {
    setOverColumn(null);
    const issue = issues.find((i) => i.id === draggingId);
    setDraggingId(null);
    if (!issue || column.statuses.includes(issue.status)) return;
    onStatusChange(issue, column.dropStatus);
  }

  return (
    <>
      <div className="mb-3 flex gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:hidden">
        {COLUMNS.map((column) => {
          const count = issues.filter((i) =>
            column.statuses.includes(i.status)
          ).length;
          const active = mobileColumn === column.key;
          return (
            <button
              key={column.key}
              onClick={() => setMobileColumn(column.key)}
              aria-pressed={active}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition ${
                active
                  ? "bg-slate-100 text-slate-800"
                  : "text-slate-400 hover:bg-slate-50"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${column.dot}`} />
              {column.title.split(" / ")[0]}
              <span className="text-slate-400">{count}</span>
            </button>
          );
        })}
      </div>

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
              className={`flex-col rounded-xl border transition ${
                mobileColumn === column.key ? "flex" : "hidden sm:flex"
              } ${large ? "gap-3 p-3 sm:min-h-[60vh]" : "gap-2 p-2 sm:min-h-[140px]"} ${
                isOver
                  ? "border-brand-400 bg-brand-50/60 ring-2 ring-brand-200"
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
                  {isOver ? "Отпусти здесь" : "Пусто"}
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
                    className={`group/card cursor-grab rounded-lg border-l-4 border-y border-r border-slate-200 bg-white shadow-sm transition hover:-translate-y-px hover:shadow-md active:cursor-grabbing ${
                      large ? "p-3.5 text-sm" : "p-2.5 text-sm"
                    } ${STATUS_META[issue.status].bar} ${
                      draggingId === issue.id
                        ? "rotate-1 opacity-40 shadow-lg"
                        : ""
                    } ${
                      highlightId === issue.id
                        ? "j40-ping ring-2 ring-accent-400"
                        : ""
                    }`}
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${color.bg} ${color.text}`}
                      >
                        {issue.groupName} {issue.groupEmoji}
                      </span>
                      {/* Кнопки проявляются на hover: три иконки на каждой из
                          пары десятков карточек создавали визуальный шум,
                          из-за которого текст тикета читался хуже. На
                          тач-устройствах hover нет — там они видны всегда. */}
                      <div className="flex shrink-0 items-center gap-2 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/card:opacity-100 sm:focus-within:opacity-100">
                        {onMerge && (
                          <button
                            onClick={() => onMerge(issue)}
                            title="Это дубль — объединить с другим тикетом"
                            className="text-slate-300 transition hover:text-accent-600"
                          >
                            <IconLink className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {onEdit && (
                          <button
                            onClick={() => onEdit(issue)}
                            title="Изменить тикет"
                            className="text-slate-300 transition hover:text-slate-600"
                          >
                            <IconEdit className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {onDelete && (
                          <button
                            onClick={() => onDelete(issue)}
                            title="Удалить тикет"
                            className="text-slate-300 transition hover:text-red-500"
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="leading-snug text-slate-900">
                      {issue.description}
                    </p>
                    {issueLinks(issue).map((link, i) => (
                      <span key={link} className="mt-1 flex items-center gap-1">
                        <a
                          href={link}
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-1 text-xs text-accent-600 hover:underline"
                        >
                          <IconExternalLink className="h-3 w-3 shrink-0" />
                          {i === 0
                            ? "Открыть в Telegram"
                            : `Ещё обращение №${i + 1}`}
                        </a>
                        {onDetach && issue.extraLinks?.includes(link) && (
                          <button
                            onClick={() => onDetach(issue, link)}
                            title="Отвязать это обращение от тикета"
                            className="shrink-0 text-xs text-slate-300 hover:text-red-500"
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    ))}
                    {/* Почта/телефон/вложение — то, что чистка описания
                        выкидывает, потому что в репорт боссам это не нужно.
                        Агенту же без почты нечего искать в админке, а строка
                        "мәселе суретте тұр" без самой картинки не значит
                        ничего. Показываем прямо тут, чтобы не ходить в
                        Telegram за каждым тикетом. */}
                    {(issue.hints?.emails.length ||
                      issue.hints?.phones.length ||
                      issue.hints?.hasAttachment) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {issue.hints.emails.map((email) => (
                          <button
                            key={email}
                            onClick={() => navigator.clipboard?.writeText(email)}
                            title="Скопировать почту"
                            className="max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 transition hover:bg-slate-200"
                          >
                            ✉️ {email}
                          </button>
                        ))}
                        {issue.hints.phones.map((phone) => (
                          <button
                            key={phone}
                            onClick={() => navigator.clipboard?.writeText(phone)}
                            title="Скопировать номер"
                            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 transition hover:bg-slate-200"
                          >
                            📞 {phone}
                          </button>
                        ))}
                        {issue.hints.hasAttachment && (
                          <span
                            title="В обращении есть фото или файл — суть может быть только там"
                            className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700"
                          >
                            📎 вложение
                          </span>
                        )}
                      </div>
                    )}
                    {/* Распознан запрос «смените почту A → B» — кнопка ведёт в
                        инструмент смены с уже подставленными почтами. Меняет
                        всё равно агент (там предпросмотр и подтверждение). */}
                    {issue.emailChange && (
                      <div className="mt-1">
                        <a
                          href={`/platform/change-email?old=${encodeURIComponent(
                            issue.emailChange.oldEmail
                          )}&new=${encodeURIComponent(issue.emailChange.newEmail)}`}
                          onClick={(e) => e.stopPropagation()}
                          title={`Сменить почту: ${issue.emailChange.oldEmail} → ${issue.emailChange.newEmail}`}
                          className="inline-flex max-w-full items-center gap-1 truncate rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 transition hover:bg-brand-100"
                        >
                          ✉️ Сменить почту →
                        </a>
                      </div>
                    )}
                    {onBotRepliesChanged && onBotReplyError && (
                      <BotReplies
                        issueId={issue.id}
                        replies={issue.botReplies ?? []}
                        onChanged={onBotRepliesChanged}
                        onError={onBotReplyError}
                      />
                    )}
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
                      {stalledHours(issue) !== null && (
                        <span
                          title="Столько тикет висит в этом статусе. Часто это значит, что работа уже сделана, просто статус не переставили."
                          className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                        >
                          ⏳ {stalledHours(issue)} ч
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
    </>
  );
}
