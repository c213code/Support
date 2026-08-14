"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GroupPresetDTO, IssueDTO, TelegramMessageDTO } from "@/lib/types";
import { IssueForm, type IssueFormValues } from "@/components/IssueForm";
import { KanbanBoard } from "@/components/KanbanBoard";
import { ResolveDialog } from "@/components/ResolveDialog";
import { EscalateDialog, type EscalateValues } from "@/components/EscalateDialog";
import { AttachToIssuePicker } from "@/components/AttachToIssuePicker";
import { Modal } from "@/components/Modal";
import { CommandPalette, type PaletteAction } from "@/components/CommandPalette";
import { ShortcutsHelp, type Shortcut } from "@/components/ShortcutsHelp";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useHotkeys } from "@/lib/useHotkeys";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import type { IssueStatus } from "@/lib/status";
import {
  formatDateHuman,
  shiftDateString,
  todayDateString,
} from "@/lib/date";
import { groupColor, isOfficialGroupName } from "@/lib/groups";
import { cleanTicketDescription } from "@/lib/textClean";
import { AUTO_ISSUE_CREATOR } from "@/lib/telegram";
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
  IconFilter,
} from "@/components/Icons";

const NO_GROUP_FILTER = "__none__";

const SHORTCUTS: Shortcut[] = [
  { keys: ["b"], description: "Доска" },
  { keys: ["m"], description: "Сообщения" },
  { keys: ["f"], description: "Фильтр по тексту" },
  { keys: ["←", "→"], description: "Предыдущий / следующий день" },
  { keys: ["t"], description: "Сегодня" },
  { keys: ["n"], description: "Новый тикет" },
];

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
  const [escalatingIssueId, setEscalatingIssueId] = useState<string | null>(
    null
  );
  const [mergingIssueId, setMergingIssueId] = useState<string | null>(null);
  const [aiCleaningEnabled, setAiCleaningEnabled] = useState<boolean | null>(
    null
  );
  const [autoReplyEnabled, setAutoReplyEnabled] = useState<boolean | null>(null);
  const [boardQuery, setBoardQuery] = useState("");
  const [duplicateGroups, setDuplicateGroups] = useState<IssueDTO[][] | null>(
    null
  );
  const [checkingDuplicates, setCheckingDuplicates] = useState(false);
  const [aiValidation, setAiValidation] = useState<{
    falsePositives: IssueDTO[];
    improvements: Array<{ issue: IssueDTO; suggested: string }>;
  } | null>(null);
  const [checkingAiValidation, setCheckingAiValidation] = useState(false);
  const [missedTickets, setMissedTickets] = useState<
    Array<{ message: TelegramMessageDTO; suggested: string }> | null
  >(null);
  const [checkingMissedTickets, setCheckingMissedTickets] = useState(false);
  const [addingNewIssue, setAddingNewIssue] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const boardSearchRef = useRef<HTMLInputElement>(null);
  const currentAgent = useCurrentAgent();
  const { confirm, element: confirmElement } = useConfirm();
  const toast = useToast();
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
    fetch("/api/settings/auto-reply")
      .then((res) => res.json())
      .then((data) => setAutoReplyEnabled(Boolean(data.enabled)));
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

  // Снимает привязку чата только у ОДНОЙ группы (см. комментарий в
  // api/telegram/reset-groups) — раньше кнопка сбрасывала все 4 группы
  // разом, и почин "поправить одну неверную привязку" сносил рабочие
  // привязки остальных.
  function handleResetGroup(groupName: string) {
    confirm({
      title: `Снять привязку чата у «${groupName}»?`,
      body: "Ещё не разобранные сообщения из этого чата снова станут «без группы». Остальные группы не тронутся.",
      confirmLabel: "Снять привязку",
      onConfirm: async () => {
        await fetch("/api/telegram/reset-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ groupName }),
        });
        await Promise.all([loadGroups(), loadMessages(date)]);
        toast(`Привязка «${groupName}» снята`);
      },
    });
  }

  async function handleDismiss(id: string) {
    await fetch(`/api/telegram/messages/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    await loadMessages(date);
  }

  // Тикет с нуля, без исходного сообщения во "Входящих" — когда ссылку
  // на Telegram-сообщение прислали в личку/другой чат, куда бот не
  // подключён, и заводить тикет не от чего кроме самой ссылки.
  async function handleCreateNewIssue(values: IssueFormValues) {
    await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, reportDate: date }),
    });
    setAddingNewIssue(false);
    await loadIssues(date);
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

  // ИИ-подсказка "это похоже один и тот же запрос, повторённый N раз" —
  // только предлагает, ничего не объединяет сама (см. комментарий у
  // findDuplicateGroups в lib/ai.ts). Дата фиксируется на момент клика,
  // а не пересчитывается при каждой смене `date`, — панель с находками
  // должна остаться на экране, даже если агент тем временем полистал день.
  async function handleFindDuplicates() {
    setCheckingDuplicates(true);
    setDuplicateGroups(null);
    try {
      const res = await fetch("/api/issues/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate: date }),
      });
      const data = await res.json();
      if (data.unavailable) {
        toast("ИИ недоступен — проверь GROQ_API_KEY", "error");
        return;
      }
      const groups: IssueDTO[][] = data.groups ?? [];
      setDuplicateGroups(groups);
      if (groups.length === 0) toast("Дублей не нашлось", "info");
    } finally {
      setCheckingDuplicates(false);
    }
  }

  // Схлопывает всю найденную группу в один тикет: первый (самый ранний по
  // позиции) остаётся, остальные вливаются в него по очереди — тот же
  // POST /api/issues/[id]/merge-into, что и у ручного объединения.
  async function handleMergeDuplicateGroup(group: IssueDTO[], index: number) {
    const [target, ...rest] = [...group].sort((a, b) => a.position - b.position);
    for (const source of rest) {
      await fetch(`/api/issues/${source.id}/merge-into`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: target.id }),
      });
    }
    setDuplicateGroups((prev) => prev?.filter((_, i) => i !== index) ?? null);
    await Promise.all([loadIssues(date), loadMessages(date)]);
    toast(`Объединено в 1 тикет (было ${group.length})`);
  }

  function handleDismissDuplicateGroup(index: number) {
    setDuplicateGroups((prev) => prev?.filter((_, i) => i !== index) ?? null);
  }

  // Отвязать приклеенное обращение (промахнулись при объединении/
  // приклеивании) — то же действие, что уже есть на Дашборде, теперь и на
  // доске "Входящих".
  async function handleDetach(issue: IssueDTO, link: string) {
    await fetch(`/api/issues/${issue.id}/attach-message`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link }),
    });
    await Promise.all([loadIssues(date), loadMessages(date)]);
    toast("Обращение отвязано", "info");
  }

  // Перепроверка тикетов "Отправлено", заведённых ботом без участия ИИ
  // (был выключен/упал/квота) — та же идея, что и у "Найти дубли": ИИ
  // только предлагает, ничего не удаляет и не переписывает сам (см.
  // POST /api/issues/ai-validate). Ловит два случая: ИИ решает, что это
  // вообще не обращение (рабочая переписка коллег, отсеялась бы SKIP-ом
  // при живом ИИ) — кандидат на удаление; и просто более короткая/точная
  // формулировка описания — кандидат на замену текста.
  async function handleAiValidate() {
    setCheckingAiValidation(true);
    setAiValidation(null);
    try {
      const res = await fetch("/api/issues/ai-validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate: date }),
      });
      const data = await res.json();
      if (data.unavailable) {
        toast("ИИ недоступен — проверь GROQ_API_KEY / квоту", "error");
        return;
      }
      const falsePositives: IssueDTO[] = data.falsePositives ?? [];
      const improvements: Array<{ issue: IssueDTO; suggested: string }> =
        data.improvements ?? [];
      setAiValidation({ falsePositives, improvements });
      if (falsePositives.length === 0 && improvements.length === 0) {
        toast("Всё чисто, замечаний нет", "info");
      }
    } finally {
      setCheckingAiValidation(false);
    }
  }

  function handleDeleteFalsePositive(issue: IssueDTO) {
    confirm({
      title: "Удалить тикет?",
      body: `ИИ считает, что это не обращение, а рабочая переписка:\n«${issue.description}»`,
      confirmLabel: "Удалить",
      tone: "danger",
      onConfirm: async () => {
        await fetch(`/api/issues/${issue.id}`, { method: "DELETE" });
        setAiValidation((prev) =>
          prev
            ? {
                ...prev,
                falsePositives: prev.falsePositives.filter((i) => i.id !== issue.id),
              }
            : null
        );
        await loadIssues(date);
        toast("Тикет удалён", "info");
      },
    });
  }

  function handleDismissFalsePositive(issue: IssueDTO) {
    setAiValidation((prev) =>
      prev
        ? {
            ...prev,
            falsePositives: prev.falsePositives.filter((i) => i.id !== issue.id),
          }
        : null
    );
  }

  async function handleApplyImprovement(issue: IssueDTO, suggested: string) {
    await fetch(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: suggested }),
    });
    setAiValidation((prev) =>
      prev
        ? {
            ...prev,
            improvements: prev.improvements.filter((i) => i.issue.id !== issue.id),
          }
        : null
    );
    await loadIssues(date);
    toast("Описание обновлено");
  }

  function handleDismissImprovement(issue: IssueDTO) {
    setAiValidation((prev) =>
      prev
        ? {
            ...prev,
            improvements: prev.improvements.filter((i) => i.issue.id !== issue.id),
          }
        : null
    );
  }

  // Перепроверка "Входящих" за день: сообщения с уже известной группой, по
  // которым тикет так и не завёлся — либо потому, что группу привязали
  // задним числом (см. PATCH /api/telegram/messages/[id], тикеты за
  // накопленные сообщения не создаёт сам), либо это старый пропуск ещё до
  // какого-то фикса. Прогоняет их через ту же логику, что и вебхук в
  // моменте (см. POST /api/telegram/ai-recheck-messages), и предлагает
  // завести тикет по тем, что теперь проходят.
  async function handleRecheckMessages() {
    setCheckingMissedTickets(true);
    setMissedTickets(null);
    try {
      const res = await fetch("/api/telegram/ai-recheck-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportDate: date }),
      });
      const data = await res.json();
      const missed: Array<{ message: TelegramMessageDTO; suggested: string }> =
        data.missed ?? [];
      setMissedTickets(missed);
      if (missed.length === 0) toast("Пропущенных тикетов не нашлось", "info");
    } finally {
      setCheckingMissedTickets(false);
    }
  }

  async function handleCreateMissedTicket(item: {
    message: TelegramMessageDTO;
    suggested: string;
  }) {
    await handleCreateIssue(item.message, {
      groupName: item.message.groupName ?? "",
      groupEmoji: item.message.groupEmoji,
      description: item.suggested,
      telegramLink: item.message.messageLink,
      status: "SENT",
      note: "",
      ticketLink: "",
      escalatedTeam: "",
      escalatedAssignee: "",
    });
    setMissedTickets((prev) =>
      prev ? prev.filter((x) => x.message.id !== item.message.id) : null
    );
  }

  function handleDismissMissedTicket(messageId: string) {
    setMissedTickets((prev) =>
      prev ? prev.filter((x) => x.message.id !== messageId) : null
    );
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

  async function handleConfirmEscalate(
    issue: IssueDTO,
    values: EscalateValues
  ) {
    await fetch(`/api/issues/${issue.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ESCALATED", ...values }),
    });
    setEscalatingIssueId(null);
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

  function handleDeleteIssue(issue: IssueDTO) {
    confirm({
      title: "Удалить тикет?",
      body: issue.description,
      confirmLabel: "Удалить",
      tone: "danger",
      onConfirm: async () => {
        await fetch(`/api/issues/${issue.id}`, { method: "DELETE" });
        await loadIssues(date);
        toast("Тикет удалён", "info");
      },
    });
  }

  // Разовое действие с кнопки на доске: тикеты, которые остались в
  // "Пендинг" со старых времён (когда это был дефолтный статус, а не
  // осознанный выбор), переносим в "Отправлено" за выбранный день.
  function handleNormalizePending() {
    confirm({
      title: "Перевести «Пендинг» в «Отправлено»?",
      body: "Только для тикетов за этот день, которым статус никто явно не выставлял.",
      confirmLabel: "Перевести",
      onConfirm: async () => {
        await fetch("/api/issues/normalize-status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportDate: date }),
        });
        await loadIssues(date);
        toast("Статусы обновлены");
      },
    });
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
    toast(
      data.updated > 0
        ? `Почистил описание у ${data.updated} тикет(ов)`
        : "Все описания уже чистые",
      data.updated > 0 ? "success" : "info"
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
    if (!res.ok) {
      setAiCleaningEnabled(!next);
      toast("Не удалось переключить ИИ-описания", "error");
      return;
    }
    toast(next ? "ИИ-описания включены" : "ИИ-описания выключены", "info");
  }

  // Тогл автоответов бота в рабочие группы. Единственная настройка,
  // которая заставляет бота писать от имени школы туда, где сидят
  // коллеги, — поэтому подтверждаем включение явно, а выключение делаем
  // без вопросов (выключить всегда должно быть легко).
  async function handleToggleAutoReply() {
    const next = !autoReplyEnabled;
    if (
      next &&
      !window.confirm(
        "Бот начнёт сам отвечать в рабочих группах: подтверждать приём обращений и сообщать о смене статуса. Включить?"
      )
    ) {
      return;
    }
    setAutoReplyEnabled(next);
    const res = await fetch("/api/settings/auto-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setAutoReplyEnabled(!next);
      toast("Не удалось переключить автоответы", "error");
      return;
    }
    toast(
      next ? "Автоответы включены" : "Автоответы выключены",
      next ? "success" : "info"
    );
  }

  // Фильтр по тексту на доске: за активный день набирается несколько
  // десятков карточек в трёх колонках, и найти "тот тикет про ДТ" глазами
  // дольше, чем набрать пару букв.
  const visibleIssues = useMemo(() => {
    const q = boardQuery.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter(
      (i) =>
        i.description.toLowerCase().includes(q) ||
        i.groupName.toLowerCase().includes(q) ||
        (i.note ?? "").toLowerCase().includes(q)
    );
  }, [issues, boardQuery]);

  // Подсветить тикет, выбранный в ⌘K: открываем его форму и заодно
  // помечаем на доске, чтобы после закрытия было видно, где он лежит.
  function focusIssue(issue: IssueDTO) {
    setTab("board");
    setHighlightId(issue.id);
    setEditingIssueId(issue.id);
    setTimeout(() => setHighlightId(null), 2500);
  }

  useHotkeys({
    ArrowLeft: () => setDate((d) => shiftDateString(d, -1)),
    ArrowRight: () => setDate((d) => shiftDateString(d, 1)),
    t: () => setDate(todayDateString()),
    b: () => setTab("board"),
    m: () => setTab("messages"),
    n: () => {
      setTab("board");
      setAddingNewIssue(true);
    },
    f: () => {
      setTab("board");
      // Фокус после переключения вкладки — поле рендерится только на доске.
      setTimeout(() => boardSearchRef.current?.focus(), 0);
    },
    "?": () => setShowShortcuts(true),
  });

  const paletteActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "today",
        label: "Перейти к сегодняшнему дню",
        hint: "t",
        Icon: IconRefresh,
        run: () => setDate(todayDateString()),
      },
      {
        id: "tab-board",
        label: "Открыть доску",
        hint: "b",
        Icon: IconColumns,
        run: () => setTab("board"),
      },
      {
        id: "tab-messages",
        label: "Открыть ленту сообщений",
        hint: "m",
        Icon: IconInbox,
        run: () => setTab("messages"),
      },
      {
        id: "toggle-ai",
        label: aiCleaningEnabled
          ? "Выключить ИИ-описания"
          : "Включить ИИ-описания",
        Icon: IconRefresh,
        run: handleToggleAiCleaning,
      },
      {
        id: "shortcuts",
        label: "Показать горячие клавиши",
        hint: "?",
        run: () => setShowShortcuts(true),
      },
    ],
    // handleToggleAiCleaning пересоздаётся каждый рендер, но зависит только
    // от aiCleaningEnabled — его и отслеживаем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [aiCleaningEnabled]
  );

  return (
    <div
      className={`mx-auto px-4 py-6 sm:px-6 ${tab === "board" ? "max-w-6xl" : "max-w-3xl"}`}
    >
      {confirmElement}
      <CommandPalette
        issues={issues}
        actions={paletteActions}
        onPickIssue={focusIssue}
      />
      {showShortcuts && (
        <ShortcutsHelp
          shortcuts={SHORTCUTS}
          onClose={() => setShowShortcuts(false)}
        />
      )}

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
          <button
            type="button"
            role="switch"
            aria-checked={autoReplyEnabled ?? false}
            onClick={handleToggleAutoReply}
            disabled={autoReplyEnabled === null}
            title="Бот сам отвечает в рабочих группах: подтверждает приём обращения и сообщает о смене статуса"
            className="flex items-center gap-1.5 rounded-full border border-slate-300 px-2 py-1 text-xs font-medium text-slate-500 disabled:opacity-50"
          >
            <span
              className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                autoReplyEnabled ? "bg-emerald-600" : "bg-slate-300"
              }`}
            >
              <span
                className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition ${
                  autoReplyEnabled ? "left-3.5" : "left-0.5"
                }`}
              />
            </span>
            🤖 Автоответы
          </button>
          {tab === "messages" && (
            <span className="text-xs text-slate-400">
              Обновляется каждые {POLL_INTERVAL_MS / 1000} сек.
            </span>
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
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-slate-700">
                Тикеты за день
              </h2>
              <div className="relative">
                <IconFilter className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-300" />
                <input
                  ref={boardSearchRef}
                  value={boardQuery}
                  onChange={(e) => setBoardQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setBoardQuery("");
                      e.currentTarget.blur();
                    }
                  }}
                  placeholder="Фильтр…"
                  aria-label="Фильтр тикетов по тексту"
                  className="w-32 rounded-lg border border-slate-200 bg-white py-1 pl-8 pr-2 text-xs outline-none transition focus:w-48 focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
              </div>
              {boardQuery && (
                <span className="text-xs text-slate-400">
                  {visibleIssues.length} из {issues.length}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => setAddingNewIssue(true)}
                title="Завести тикет по ссылке, которой ещё нет во «Входящих» (например, прислали в личку)"
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-brand-700 active:scale-95"
              >
                <IconPlus className="h-3.5 w-3.5" />
                Новый тикет
              </button>
              {issues.length >= 2 && (
                <button
                  onClick={handleFindDuplicates}
                  disabled={checkingDuplicates}
                  title="Спросить ИИ, нет ли среди тикетов дня повторов одного и того же запроса"
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-brand-600 disabled:opacity-50"
                >
                  🤖 {checkingDuplicates ? "Ищем дубли…" : "Найти дубли"}
                </button>
              )}
              {issues.some(
                (i) => i.status === "SENT" && i.createdBy === AUTO_ISSUE_CREATOR
              ) && (
                <button
                  onClick={handleAiValidate}
                  disabled={checkingAiValidation}
                  title="Перепроверить ИИ тикеты, заведённые ботом без него (был выключен/упал/квота)"
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-brand-600 disabled:opacity-50"
                >
                  🤖 {checkingAiValidation ? "Проверяем…" : "Проверить авто-тикеты"}
                </button>
              )}
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
          {duplicateGroups && duplicateGroups.length > 0 && (
            <div className="mb-3 space-y-2 rounded-xl border border-accent-400/40 bg-accent-500/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-accent-700">
                🤖 ИИ подозревает повторы — проверь и реши сам, объединять
                ли:
              </p>
              {duplicateGroups.map((group, index) => (
                <div
                  key={group.map((i) => i.id).join("-")}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2.5"
                >
                  <div className="flex flex-1 flex-wrap gap-1.5">
                    {group.map((issue) => {
                      const color = groupColor(issue.groupName);
                      return (
                        <span
                          key={issue.id}
                          className={`rounded-full px-2 py-0.5 text-[11px] ${color.bg} ${color.text}`}
                          title={issue.description}
                        >
                          {issue.description.length > 40
                            ? `${issue.description.slice(0, 40)}…`
                            : issue.description}
                        </span>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => handleMergeDuplicateGroup(group, index)}
                    className="shrink-0 rounded-lg bg-accent-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-accent-700"
                  >
                    Объединить
                  </button>
                  <button
                    onClick={() => handleDismissDuplicateGroup(index)}
                    className="shrink-0 text-xs text-slate-400 transition hover:text-slate-700"
                  >
                    Скрыть
                  </button>
                </div>
              ))}
            </div>
          )}
          {aiValidation &&
            (aiValidation.falsePositives.length > 0 ||
              aiValidation.improvements.length > 0) && (
              <div className="mb-3 space-y-2 rounded-xl border border-accent-400/40 bg-accent-500/5 p-3">
                {aiValidation.falsePositives.length > 0 && (
                  <>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-accent-700">
                      🤖 ИИ считает — это не обращение, а рабочая переписка,
                      без него так завелось ошибочно:
                    </p>
                    {aiValidation.falsePositives.map((issue) => (
                      <div
                        key={issue.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2.5"
                      >
                        <span className="flex-1 text-xs text-slate-700">
                          {issue.description}
                        </span>
                        <button
                          onClick={() => handleDeleteFalsePositive(issue)}
                          className="shrink-0 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-red-700"
                        >
                          Удалить
                        </button>
                        <button
                          onClick={() => handleDismissFalsePositive(issue)}
                          className="shrink-0 text-xs text-slate-400 transition hover:text-slate-700"
                        >
                          Оставить
                        </button>
                      </div>
                    ))}
                  </>
                )}
                {aiValidation.improvements.length > 0 && (
                  <>
                    <p className="flex items-center gap-1.5 text-xs font-medium text-accent-700">
                      🤖 ИИ предлагает описание точнее:
                    </p>
                    {aiValidation.improvements.map(({ issue, suggested }) => (
                      <div
                        key={issue.id}
                        className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-white p-2.5"
                      >
                        <span className="text-xs text-slate-400 line-through">
                          {issue.description}
                        </span>
                        <span className="text-xs text-slate-700">{suggested}</span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleApplyImprovement(issue, suggested)}
                            className="shrink-0 rounded-lg bg-accent-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-accent-700"
                          >
                            Применить
                          </button>
                          <button
                            onClick={() => handleDismissImprovement(issue)}
                            className="shrink-0 text-xs text-slate-400 transition hover:text-slate-700"
                          >
                            Оставить как есть
                          </button>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          {issues.length === 0 ? (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400">
              За этот день пока нет тикетов.
              <br />
              <span className="text-xs">
                Они появятся сами, как только в привязанный чат напишут.
              </span>
            </p>
          ) : (
            <KanbanBoard
              issues={visibleIssues}
              onStatusChange={handleStatusChange}
              onEdit={(issue) => setEditingIssueId(issue.id)}
              onDelete={handleDeleteIssue}
              onMerge={(issue) => setMergingIssueId(issue.id)}
              onEscalate={(issue) => setEscalatingIssueId(issue.id)}
              onDetach={handleDetach}
              onBotRepliesChanged={() => loadIssues(date)}
              onBotReplyError={(message) => toast(message, "error")}
              size="large"
              highlightId={highlightId}
            />
          )}
        </div>
      )}

      {mergingIssueId &&
        (() => {
          const source = issues.find((i) => i.id === mergingIssueId);
          if (!source) return null;
          return (
            <Modal
              onClose={() => setMergingIssueId(null)}
              labelledBy="merge-title"
            >
              <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
                <p
                  id="merge-title"
                  className="mb-1 text-sm font-semibold text-slate-900"
                >
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
            </Modal>
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

      {escalatingIssueId &&
        (() => {
          const escalatingIssue = issues.find(
            (i) => i.id === escalatingIssueId
          );
          if (!escalatingIssue) return null;
          return (
            <EscalateDialog
              issue={escalatingIssue}
              onCancel={() => setEscalatingIssueId(null)}
              onConfirm={(values) =>
                handleConfirmEscalate(escalatingIssue, values)
              }
            />
          );
        })()}

      {editingIssueId &&
        (() => {
          const editingIssue = issues.find((i) => i.id === editingIssueId);
          if (!editingIssue) return null;
          return (
            <Modal onClose={() => setEditingIssueId(null)} size="lg">
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
            </Modal>
          );
        })()}

      {addingNewIssue && (
        <Modal onClose={() => setAddingNewIssue(false)} size="lg">
          <IssueForm
            groups={groups}
            currentAgent={currentAgent ?? ""}
            showGroupPicker
            onCancel={() => setAddingNewIssue(false)}
            onSubmit={handleCreateNewIssue}
          />
        </Modal>
      )}

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
            <span
              key={g.id}
              className={`flex items-center rounded-full transition ${
                groupFilter === g.name
                  ? `${groupColor(g.name).bg} ${groupColor(g.name).text} ring-1 ring-inset ${groupColor(g.name).border}`
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200"
              }`}
            >
              <button
                onClick={() => setGroupFilter(g.name)}
                className="rounded-full py-1 pl-3 pr-1 text-xs font-medium"
              >
                {g.name} {g.emoji ?? ""}
              </button>
              {g.chatId && (
                <button
                  onClick={() => handleResetGroup(g.name)}
                  title={`Снять привязку чата у «${g.name}» и начать распределение заново`}
                  className="rounded-full p-1 pr-2 opacity-60 hover:text-red-600 hover:opacity-100"
                >
                  <IconRefresh className="h-3 w-3" />
                </button>
              )}
            </span>
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
        {messages.length > 0 && (
          <button
            onClick={handleRecheckMessages}
            disabled={checkingMissedTickets}
            title="Проверить сообщения с уже известной группой, по которым тикет так и не завёлся"
            className="ml-auto flex items-center gap-1 text-xs text-slate-400 hover:text-brand-600 disabled:opacity-50"
          >
            🔍 {checkingMissedTickets ? "Проверяем…" : "Найти пропущенные тикеты"}
          </button>
        )}
      </div>

      {missedTickets && missedTickets.length > 0 && (
        <div className="mb-4 space-y-2 rounded-xl border border-accent-400/40 bg-accent-500/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-accent-700">
            🔍 По этим сообщениям группа известна, а тикет так и не завёлся —
            проверь и заведи, если нужно:
          </p>
          {missedTickets.map((item) => (
            <div
              key={item.message.id}
              className="flex flex-col gap-1.5 rounded-lg border border-slate-200 bg-white p-2.5"
            >
              <span className="text-xs text-slate-400">
                {item.message.groupName} {item.message.groupEmoji}
              </span>
              <span className="text-xs text-slate-700">{item.suggested}</span>
              <div className="flex gap-2">
                <button
                  onClick={() => handleCreateMissedTicket(item)}
                  className="shrink-0 rounded-lg bg-accent-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-accent-700"
                >
                  Создать тикет
                </button>
                <button
                  onClick={() => handleDismissMissedTicket(item.message.id)}
                  className="shrink-0 text-xs text-slate-400 transition hover:text-slate-700"
                >
                  Скрыть
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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
