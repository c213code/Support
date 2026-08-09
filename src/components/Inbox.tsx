"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { GroupPresetDTO, IssueDTO, TelegramMessageDTO } from "@/lib/types";
import { IssueForm, type IssueFormValues } from "@/components/IssueForm";
import { KanbanBoard } from "@/components/KanbanBoard";
import { ResolveDialog } from "@/components/ResolveDialog";
import { AttachToIssuePicker } from "@/components/AttachToIssuePicker";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import type { IssueStatus } from "@/lib/status";
import {
  formatDateHuman,
  shiftDateString,
  todayDateString,
} from "@/lib/date";
import { groupColor, isOfficialGroupName } from "@/lib/groups";
import { cleanTicketDescription } from "@/lib/textClean";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconInbox,
  IconColumns,
  IconEdit,
  IconLink,
} from "@/components/Icons";

const NO_GROUP_FILTER = "__none__";

const POLL_INTERVAL_MS = 15000;

// Форматтер создаётся один раз: toLocaleString строит его заново на каждый
// вызов, а вызовов тут — по одному на сообщение на каждый рендер, и лента
// перерисовывается каждые 15 сек после опроса.
const TIME_FORMAT = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "Asia/Almaty",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatTime(iso: string) {
  return TIME_FORMAT.format(new Date(iso));
}

export function Inbox() {
  const [date, setDate] = useState(todayDateString());
  const [messages, setMessages] = useState<TelegramMessageDTO[]>([]);
  const [groups, setGroups] = useState<GroupPresetDTO[]>([]);
  const [issues, setIssues] = useState<IssueDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingFromId, setCreatingFromId] = useState<string | null>(null);
  const [attachingFromId, setAttachingFromId] = useState<string | null>(null);
  const [groupFilter, setGroupFilter] = useState<string>("");
  const [tab, setTab] = useState<"messages" | "board">("board");
  const [editingIssueId, setEditingIssueId] = useState<string | null>(null);
  const [resolvingIssueId, setResolvingIssueId] = useState<string | null>(null);
  const [mergingIssueId, setMergingIssueId] = useState<string | null>(null);
  const [aiCleaningEnabled, setAiCleaningEnabled] = useState<boolean | null>(
    null
  );
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

  const loadIssues = useCallback(async (d: string) => {
    const res = await fetch(`/api/issues?date=${d}`);
    const data = await res.json();
    setIssues(data.issues ?? []);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    loadGroups();
    fetch("/api/settings/ai-cleaning")
      .then((res) => res.json())
      .then((data) => setAiCleaningEnabled(Boolean(data.enabled)));
  }, [loadGroups]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on date change
    setLoading(true);
    loadMessages(date);
    loadIssues(date);

    // В фоновой вкладке опрашивать сервер незачем — вкладку с доской
    // держат открытой весь день, и это два лишних запроса каждые 15 сек в
    // пустоту. Зато при возврате на вкладку обновляемся сразу, не
    // дожидаясь следующего тика.
    function refreshIfVisible() {
      if (document.hidden) return;
      loadMessages(date);
      loadIssues(date);
    }

    const interval = setInterval(refreshIfVisible, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [date, loadMessages, loadIssues]);

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
      fetch("/api/telegram/messages/mark-viewed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: unviewedIds }),
      }).then(() => {
        const marked = new Set(unviewedIds);
        setMessages((prev) =>
          prev.map((m) => (marked.has(m.id) ? { ...m, viewed: true } : m))
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
    await Promise.all([loadMessages(date), loadIssues(date)]);
  }

  // Приклеить сообщение к уже существующему тикету вместо заведения
  // нового: один и тот же запрос часто приходит по нескольку раз.
  async function handleAttachToIssue(
    message: TelegramMessageDTO,
    issue: IssueDTO
  ) {
    await fetch(`/api/issues/${issue.id}/attach-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId: message.id }),
    });
    setAttachingFromId(null);
    await Promise.all([loadMessages(date), loadIssues(date)]);
  }

  // Объединение тикета-дубля с основным: ссылки переезжают туда, дубль
  // исчезает с доски.
  async function handleMergeIssue(source: IssueDTO, target: IssueDTO) {
    await fetch(`/api/issues/${source.id}/merge-into`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetId: target.id }),
    });
    setMergingIssueId(null);
    await Promise.all([loadIssues(date), loadMessages(date)]);
  }

  // Быстрая смена статуса тикета на доске (перетаскиванием или кнопкой).
  // Перевод в "Решено" — единственный, который не применяется сразу:
  // сначала спрашиваем "как решили" в модалке (см. ResolveDialog), потому
  // что эта заметка и есть то, что попадёт в вечерний репорт.
  async function handleStatusChange(issue: IssueDTO, status: IssueStatus) {
    if (status === "RESOLVED") {
      setResolvingIssueId(issue.id);
      return;
    }
    await fetch(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadIssues(date);
  }

  async function handleConfirmResolve(issue: IssueDTO, note: string) {
    await fetch(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "RESOLVED", note }),
    });
    setResolvingIssueId(null);
    await loadIssues(date);
  }

  async function handleUpdateIssue(id: string, values: IssueFormValues) {
    await fetch(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    setEditingIssueId(null);
    await loadIssues(date);
  }

  async function handleDeleteIssue(issue: IssueDTO) {
    if (!window.confirm(`Удалить тикет «${issue.description}»?`)) return;
    await fetch(`/api/issues/${issue.id}`, { method: "DELETE" });
    await loadIssues(date);
  }

  // Разовое действие с кнопки на доске: тикеты, которые остались в
  // "Пендинг" со старых времён (когда это был дефолтный статус, а не
  // осознанный выбор), переносим в "Отправлено" за выбранный день.
  async function handleNormalizePending() {
    if (
      !window.confirm(
        "Перевести тикеты со статусом «Пендинг» за этот день в «Отправлено»? Это только для тикетов, которым статус никто явно не выставлял."
      )
    )
      return;
    await fetch("/api/issues/normalize-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportDate: date }),
    });
    await loadIssues(date);
  }

  // Разовое действие с кнопки на доске: прогоняет описания тикетов
  // "Отправлено" за день через ту же автоочистку, что применяется к новым
  // сообщениям — для тех, что успели завестись до появления автоочистки в
  // вебхуке и всё ещё занимают место ссылками/приветствиями/логинами.
  async function handleCleanDescriptions() {
    const res = await fetch("/api/issues/clean-descriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportDate: date }),
    });
    const data = await res.json();
    await loadIssues(date);
    window.alert(
      data.updated > 0
        ? `Почистил описание у ${data.updated} тикет(ов).`
        : "Все описания уже чистые."
    );
  }

  // Тогл "описания авто-тикетов пишет ИИ" — общая настройка на всё
  // приложение (не по агенту), сразу шлём на сервер и откатываем чекбокс
  // назад, если запрос не прошёл.
  async function handleToggleAiCleaning() {
    const next = !aiCleaningEnabled;
    setAiCleaningEnabled(next);
    const res = await fetch("/api/settings/ai-cleaning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) setAiCleaningEnabled(!next);
  }

  return (
    <div
      className={`mx-auto px-4 py-6 sm:px-6 ${tab === "board" ? "max-w-6xl" : "max-w-3xl"}`}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-slate-900">Входящие</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={aiCleaningEnabled ?? false}
            onClick={handleToggleAiCleaning}
            disabled={aiCleaningEnabled === null}
            title="Описания новых авто-тикетов пишет ИИ (Groq) вместо обычной чистки регулярками"
            className="flex items-center gap-1.5 rounded-full border border-slate-300 px-2 py-1 text-xs font-medium text-slate-500 disabled:opacity-50"
          >
            <span
              className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                aiCleaningEnabled ? "bg-brand-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition ${
                  aiCleaningEnabled ? "left-3.5" : "left-0.5"
                }`}
              />
            </span>
            ✨ ИИ-описания
          </button>
          {tab === "messages" && (
            <>
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
            </>
          )}
          <div className="flex items-center rounded-lg border border-slate-300 p-0.5">
            <button
              onClick={() => setTab("messages")}
              title="Лента входящих сообщений"
              aria-pressed={tab === "messages"}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                tab === "messages"
                  ? "bg-brand-600 text-white"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <IconInbox className="h-3.5 w-3.5" />
              Сообщения
            </button>
            <button
              onClick={() => setTab("board")}
              title="Доска тикетов по статусам"
              aria-pressed={tab === "board"}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                tab === "board"
                  ? "bg-brand-600 text-white"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <IconColumns className="h-3.5 w-3.5" />
              Доска
            </button>
          </div>
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

      {tab === "board" && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-700">
              Тикеты за день
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              {issues.some((i) => i.status === "SENT") && (
                <button
                  onClick={handleCleanDescriptions}
                  title="Убрать ссылки/приветствия/логины из описаний тикетов «Отправлено»"
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-brand-600"
                >
                  <IconRefresh className="h-3.5 w-3.5" />
                  Почистить описания в «Отправлено»
                </button>
              )}
              {issues.some((i) => i.status === "PENDING") && (
                <button
                  onClick={handleNormalizePending}
                  title="Тикеты без явного статуса перевести в «Отправлено»"
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-brand-600"
                >
                  <IconRefresh className="h-3.5 w-3.5" />
                  Пендинг без статуса → Отправлено
                </button>
              )}
            </div>
          </div>
          {issues.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
              За этот день пока нет тикетов.
            </p>
          ) : (
            <KanbanBoard
              issues={issues}
              onStatusChange={handleStatusChange}
              onEdit={(issue) => setEditingIssueId(issue.id)}
              onDelete={handleDeleteIssue}
              onMerge={(issue) => setMergingIssueId(issue.id)}
              size="large"
            />
          )}
        </div>
      )}

      {mergingIssueId &&
        (() => {
          const source = issues.find((i) => i.id === mergingIssueId);
          if (!source) return null;
          return (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16 sm:pt-24"
              onClick={(e) => {
                if (e.target === e.currentTarget) setMergingIssueId(null);
              }}
            >
              <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
                <p className="mb-1 text-sm font-semibold text-slate-900">
                  Объединить дубль
                </p>
                <p className="mb-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  {source.description}
                </p>
                <p className="mb-1 text-xs text-slate-400">
                  Этот тикет исчезнет, а его ссылки переедут в выбранный.
                </p>
                <AttachToIssuePicker
                  messageText={source.description}
                  issues={issues.filter((i) => i.id !== source.id)}
                  title="В какой тикет объединить?"
                  emptyText="Других тикетов за этот день нет."
                  pendingText="Объединяем…"
                  onCancel={() => setMergingIssueId(null)}
                  onPick={(target) => handleMergeIssue(source, target)}
                />
              </div>
            </div>
          );
        })()}

      {resolvingIssueId &&
        (() => {
          const resolvingIssue = issues.find((i) => i.id === resolvingIssueId);
          if (!resolvingIssue) return null;
          return (
            <ResolveDialog
              issue={resolvingIssue}
              currentAgent={currentAgent ?? ""}
              onCancel={() => setResolvingIssueId(null)}
              onConfirm={(note) => handleConfirmResolve(resolvingIssue, note)}
            />
          );
        })()}

      {editingIssueId &&
        (() => {
          const editingIssue = issues.find((i) => i.id === editingIssueId);
          if (!editingIssue) return null;
          return (
            <div
              className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-10 sm:pt-16"
              onClick={(e) => {
                if (e.target === e.currentTarget) setEditingIssueId(null);
              }}
            >
              <div className="w-full max-w-lg">
                <IssueForm
                  groups={groups}
                  currentAgent={currentAgent ?? ""}
                  initial={editingIssue}
                  showGroupPicker={false}
                  fixedGroupName={editingIssue.groupName}
                  onCancel={() => setEditingIssueId(null)}
                  onSubmit={(values) =>
                    handleUpdateIssue(editingIssue.id, values)
                  }
                />
              </div>
            </div>
          );
        })()}

      {tab === "messages" && (
        <>
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
                      description: message.text
                        ? cleanTicketDescription(message.text)
                        : "",
                      telegramLink: message.messageLink,
                      groupName: message.groupName ?? undefined,
                    }}
                    onCancel={() => setCreatingFromId(null)}
                    onSubmit={(values) => handleCreateIssue(message, values)}
                  />
                </div>
              ) : message.usedForIssueId ? (
                <div className="mt-2 flex items-center gap-3">
                  <button
                    onClick={() => setEditingIssueId(message.usedForIssueId)}
                    className="flex items-center gap-1 text-sm font-medium text-emerald-600 hover:underline"
                  >
                    <IconEdit className="h-3.5 w-3.5" />
                    Тикет заведён автоматически — изменить
                  </button>
                  <button
                    onClick={() => handleDismiss(message.id)}
                    className="text-sm text-slate-400 hover:text-slate-700"
                  >
                    Скрыть
                  </button>
                </div>
              ) : attachingFromId === message.id ? (
                <AttachToIssuePicker
                  messageText={message.text ?? ""}
                  issues={issues}
                  onCancel={() => setAttachingFromId(null)}
                  onPick={(issue) => handleAttachToIssue(message, issue)}
                />
              ) : (
                <div className="mt-2 flex flex-wrap gap-3">
                  <button
                    onClick={() => setCreatingFromId(message.id)}
                    className="flex items-center gap-1 text-sm font-medium text-brand-600 hover:underline"
                  >
                    <IconPlus className="h-3.5 w-3.5" />
                    Создать тикет
                  </button>
                  <button
                    onClick={() => setAttachingFromId(message.id)}
                    title="Это повтор уже заведённого запроса — приклеить ссылку к тому тикету"
                    className="flex items-center gap-1 text-sm text-slate-500 hover:text-accent-600"
                  >
                    <IconLink className="h-3.5 w-3.5" />
                    К существующему
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
        </>
      )}
    </div>
  );
}
