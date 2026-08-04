"use client";

import { useCallback, useEffect, useState } from "react";
import type { GroupPresetDTO, TelegramMessageDTO } from "@/lib/types";
import { IssueForm, type IssueFormValues } from "@/components/IssueForm";
import { AGENT_STORAGE_KEY } from "@/lib/agents";
import { todayDateString } from "@/lib/date";

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
  const [messages, setMessages] = useState<TelegramMessageDTO[]>([]);
  const [groups, setGroups] = useState<GroupPresetDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingFromId, setCreatingFromId] = useState<string | null>(null);
  const [defaultAgent, setDefaultAgent] = useState(() => {
    if (typeof window === "undefined") return "Ерош";
    return window.localStorage.getItem(AGENT_STORAGE_KEY) ?? "Ерош";
  });

  const loadGroups = useCallback(async () => {
    const res = await fetch("/api/groups");
    const data = await res.json();
    setGroups(data.groups ?? []);
  }, []);

  const loadMessages = useCallback(async () => {
    const res = await fetch("/api/telegram/messages?archived=false");
    const data = await res.json();
    setMessages(data.messages ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    loadGroups();
    loadMessages();
    const interval = setInterval(loadMessages, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadGroups, loadMessages]);

  function rememberAgent(agent: string) {
    setDefaultAgent(agent);
    window.localStorage.setItem(AGENT_STORAGE_KEY, agent);
  }

  async function handleAssignGroup(id: string, groupName: string) {
    if (!groupName) return;
    await fetch(`/api/telegram/messages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupName }),
    });
    await loadMessages();
  }

  async function handleDismiss(id: string) {
    await fetch(`/api/telegram/messages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    await loadMessages();
  }

  async function handleCreateIssue(
    message: TelegramMessageDTO,
    values: IssueFormValues
  ) {
    rememberAgent(values.createdBy);
    const res = await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, reportDate: todayDateString() }),
    });
    const data = await res.json();

    await fetch(`/api/telegram/messages/${message.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true, usedForIssueId: data.issue?.id }),
    });

    setCreatingFromId(null);
    await loadMessages();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-900">Входящие</h1>
        <span className="text-xs text-slate-400">
          Обновляется каждые {POLL_INTERVAL_MS / 1000} сек.
        </span>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400">Загрузка...</p>
      ) : messages.length === 0 ? (
        <p className="text-sm text-slate-400">
          Пока нет новых сообщений. Как только бот подключится к группам —
          они появятся здесь.
        </p>
      ) : (
        <div className="space-y-3">
          {messages.map((message) => (
            <div
              key={message.id}
              className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
            >
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  {message.groupName ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-700">
                      {message.groupName} {message.groupEmoji}
                    </span>
                  ) : (
                    <select
                      defaultValue=""
                      onChange={(e) =>
                        handleAssignGroup(message.id, e.target.value)
                      }
                      className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700"
                    >
                      <option value="" disabled>
                        {message.chatTitle ?? "Неизвестный чат"} — выбери
                        группу
                      </option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.name}>
                          {g.name} {g.emoji ?? ""}
                        </option>
                      ))}
                    </select>
                  )}
                  <span>{message.authorName ?? "Без имени"}</span>
                  <span>·</span>
                  <span>{formatTime(message.receivedAt)}</span>
                </div>
                <a
                  href={message.messageLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-sky-600 hover:underline"
                >
                  Открыть в Telegram ↗
                </a>
              </div>

              <p className="whitespace-pre-wrap text-sm text-slate-900">
                {message.text}
              </p>

              {creatingFromId === message.id ? (
                <div className="mt-3">
                  <IssueForm
                    groups={groups}
                    defaultAgent={defaultAgent}
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
                    className="text-sm font-medium text-slate-900 hover:underline"
                  >
                    + Создать тикет
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
