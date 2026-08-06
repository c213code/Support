"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GroupPresetDTO, TelegramMessageDTO } from "@/lib/types";
import { IssueForm, type IssueFormValues } from "@/components/IssueForm";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import {
  formatDateHuman,
  shiftDateString,
  todayDateString,
} from "@/lib/date";
import { groupColor, isOfficialGroupName } from "@/lib/groups";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconPlus,
  IconRefresh,
} from "@/components/Icons";

const NO_GROUP_FILTER = "__none__";

const POLL_INTERVAL_MS = 15000;

function formatTime(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: "Asia/Almaty",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function Inbox() {
  const [date, setDate] = useState(todayDateString());
  const [messages, setMessages] = useState<TelegramMessageDTO[]>([]);
  const [groups, setGroups] = useState<GroupPresetDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingFromId, setCreatingFromId] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string>("");
  const currentAgent = useCurrentAgent();
  const isToday = date === todayDateString();

  const loadGroups = useCallback(async () => {
    const res = await fetch("/api/groups");
    const data = await res.json();
    setGroups(data.groups ?? []);
  }, []);

  const loadMessages = useCallback(async (d: string) => {
    const res = await fetch(`/api/telegram/messages?archived=false&date=${d}`);
    const data = await res.json();
    setMessages(data.messages ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on date change
    setLoading(true);
    loadMessages(date);
    const interval = setInterval(() => loadMessages(date), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [date, loadMessages]);

  const filteredMessages = useMemo(
    () =>
      groupFilter
        ? messages.filter((m) =>
            groupFilter === NO_GROUP_FILTER
              ? !m.groupName
              : m.groupName === groupFilter
          )
        : messages,
    [messages, groupFilter]
  );

  // Отмечаем "новые" сообщения просмотренными спустя пару секунд после
  // показа — как галочки "прочитано" в мессенджерах, чтобы индикатор
  // успел мелькнуть перед глазами, а не исчезал мгновенно. Считаем только
  // видимые (с учётом фильтра по группе), а не все загруженные.
  useEffect(() => {
    const unviewedIds = filteredMessages
      .filter((m) => !m.viewed)
      .map((m) => m.id);
    if (unviewedIds.length === 0) return;

    const timeout = setTimeout(() => {
      Promise.all(
        unviewedIds.map((id) =>
          fetch(`/api/telegram/messages/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ viewed: true }),
          })
        )
      ).then(() => {
        setMessages((prev) =>
          prev.map((m) =>
            unviewedIds.includes(m.id) ? { ...m, viewed: true } : m
          )
        );
      });
    }, 2000);

    return () => clearTimeout(timeout);
  }, [filteredMessages]);

  async function handleAssignGroup(id: string, groupName: string) {
    if (!groupName) return;
    await fetch(`/api/telegram/messages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupName }),
    });
    await loadMessages(date);
  }

  async function handleResetGroups() {
    if (
      !window.confirm(
        "Сбросить привязку групп у всех чатов? Все ещё не разобранные сообщения снова станут «без группы», и группу нужно будет выбрать заново для каждого чата."
      )
    )
      return;
    await fetch("/api/telegram/reset-groups", { method: "POST" });
    await loadMessages(date);
  }

  async function handleDismiss(id: string) {
    await fetch(`/api/telegram/messages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    await loadMessages(date);
  }

  async function handleCreateIssue(
    message: TelegramMessageDTO,
    values: IssueFormValues
  ) {
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, reportDate: date }),
    });
    const data = await res.json();

    await fetch(`/api/telegram/messages/${message.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true, usedForIssueId: data.issue?.id }),
    });

    setCreatingFromId(null);
    await loadMessages(date);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Входящие</h1>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-400">
            Обновляется каждые {POLL_INTERVAL_MS / 1000} сек.
          </span>
          <button
            onClick={handleResetGroups}
            title="Снять привязку групп у всех чатов и начать распределение заново"
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-red-600"
          >
            <IconRefresh className="h-3.5 w-3.5" />
            Сбросить группы
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDate(shiftDateString(date, -1))}
            className="flex items-center rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-100"
            aria-label="Предыдущий день"
          >
            <IconChevronLeft />
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
            className="flex items-center rounded-lg border border-slate-300 p-1.5 text-slate-600 hover:bg-slate-100"
            aria-label="Следующий день"
          >
            <IconChevronRight />
          </button>
        </div>

        <button
          onClick={() => setDate(todayDateString())}
          disabled={isToday}
          className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:pointer-events-none disabled:opacity-0"
        >
          Сегодня
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setGroupFilter("")}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            groupFilter === ""
              ? "bg-brand-600 text-white"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          Все
        </button>
        {groups
          .filter((g) => isOfficialGroupName(g.name))
          .map((g) => (
            <button
              key={g.id}
              onClick={() => setGroupFilter(g.name)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                groupFilter === g.name
                  ? `${groupColor(g.name).bg} ${groupColor(g.name).text} ring-1 ring-inset ${groupColor(g.name).border}`
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              }`}
            >
              {g.name} {g.emoji ?? ""}
            </button>
          ))}
        <button
          onClick={() => setGroupFilter(NO_GROUP_FILTER)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition ${
            groupFilter === NO_GROUP_FILTER
              ? "bg-amber-100 text-amber-700 ring-1 ring-inset ring-amber-300"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200"
          }`}
        >
          Без группы
        </button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl bg-slate-100"
            />
          ))}
        </div>
      ) : messages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
          {isToday
            ? "За сегодня пока нет сообщений. Как только бот подключится к группам — они появятся здесь."
            : "За этот день сообщений нет."}
        </p>
      ) : filteredMessages.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
          По этому фильтру сообщений нет.
        </p>
      ) : (
        <div className="space-y-3">
          {filteredMessages.map((message) => (
            <div
              key={message.id}
              className={`rounded-xl border bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow-md ${
                message.viewed
                  ? "border-slate-200"
                  : "border-accent-400/40 bg-accent-500/5"
              }`}
            >
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  {!message.viewed && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-accent-500"
                      title="Новое, ещё не просмотрено"
                    />
                  )}
                  <select
                    value={message.groupName ?? ""}
                    onChange={(e) =>
                      handleAssignGroup(message.id, e.target.value)
                    }
                    title="Перевыбрать группу для этого чата"
                    className={`rounded-full border-0 px-2 py-0.5 font-medium outline-none ${
                      message.groupName
                        ? `${groupColor(message.groupName).bg} ${groupColor(message.groupName).text}`
                        : "bg-amber-50 text-amber-700 ring-1 ring-amber-300"
                    }`}
                  >
                    <option value="" disabled>
                      {message.chatTitle ?? "Неизвестный чат"} — выбери группу
                    </option>
                    {groups
                      .filter((g) => isOfficialGroupName(g.name))
                      .map((g) => (
                        <option key={g.id} value={g.name}>
                          {g.name} {g.emoji ?? ""}
                        </option>
                      ))}
                  </select>
                  <span>{message.authorName ?? "Без имени"}</span>
                  <span>·</span>
                  <span>{formatTime(message.receivedAt)}</span>
                </div>
                <a
                  href={message.messageLink}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 text-xs text-accent-600 hover:underline"
                >
                  Открыть в Telegram
                  <IconExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              <p className="whitespace-pre-wrap text-sm text-slate-900">
                {message.text}
              </p>

              {creatingFromId === message.id ? (
                <div className="mt-3">
                  <IssueForm
                    groups={groups}
                    currentAgent={currentAgent ?? ""}
                    showGroupPicker={!message.groupName}
                    fixedGroupName={message.groupName ?? undefined}
                    initial={{
                      description: message.text ?? "",
                      telegramLink: message.messageLink,
                      groupName: message.groupName ?? undefined,
                    }}
                    onCancel={() => setCreatingFromId(null)}
                    onSubmit={(values) => handleCreateIssue(message, values)}
                  />
                </div>
              ) : (
                <div className="mt-2 flex gap-3">
                  <button
                    onClick={() => setCreatingFromId(message.id)}
                    className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
                  >
                    <IconPlus className="h-3.5 w-3.5" />
                    Создать тикет
                  </button>
                  <button
                    onClick={() => handleDismiss(message.id)}
                    className="text-sm text-slate-400 hover:text-slate-700"
                  >
                    Скрыть
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
