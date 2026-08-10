"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { GroupPresetDTO, IssueDTO } from "@/lib/types";
import { formatDateHuman, shiftDateString, todayDateString } from "@/lib/date";
import { IssueForm, type IssueFormValues } from "@/components/IssueForm";
import { ResolveDialog } from "@/components/ResolveDialog";
import { EscalateDialog, type EscalateValues } from "@/components/EscalateDialog";
import { CommandPalette, type PaletteAction } from "@/components/CommandPalette";
import { ShortcutsHelp, type Shortcut } from "@/components/ShortcutsHelp";
import { useConfirm } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { useHotkeys } from "@/lib/useHotkeys";
import { groupIssues, issueLinks } from "@/lib/report";
import { Avatar } from "@/components/Avatar";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import { groupColor } from "@/lib/groups";
import { ISSUE_STATUSES, STATUS_META, type IssueStatus } from "@/lib/status";
import {
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconCheck,
  IconTicket,
  IconEdit,
  IconTrash,
  IconSend,
  IconPlus,
} from "@/components/Icons";

const SHORTCUTS: Shortcut[] = [
  { keys: ["n"], description: "Новый тикет" },
  { keys: ["c"], description: "Скопировать репорт" },
  { keys: ["←", "→"], description: "Предыдущий / следующий день" },
  { keys: ["t"], description: "Сегодня" },
];

export function Dashboard({ initialDate }: { initialDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [issues, setIssues] = useState<IssueDTO[]>([]);
  const [groups, setGroups] = useState<GroupPresetDTO[]>([]);
  const [reportText, setReportText] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [addingToGroup, setAddingToGroup] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [escalatingId, setEscalatingId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const currentAgent = useCurrentAgent();
  const { confirm, element: confirmElement } = useConfirm();
  const toast = useToast();

  const loadGroups = useCallback(async () => {
    const res = await fetch("/api/groups");
    const data = await res.json();
    setGroups(data.groups ?? []);
  }, []);

  const loadIssues = useCallback(async (d: string) => {
    setLoading(true);
    const [issuesRes, reportRes] = await Promise.all([
      fetch(`/api/issues?date=${d}`),
      fetch(`/api/report?date=${d}`),
    ]);
    const issuesData = await issuesRes.json();
    const reportData = await reportRes.json();
    setIssues(issuesData.issues ?? []);
    setReportText(reportData.text ?? "");
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data load on date change
    loadIssues(date);
    router.replace(`/?date=${date}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function handleCreate(values: IssueFormValues) {
    await fetch("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...values, reportDate: date }),
    });
    setAddingToGroup(null);
    setAddingNew(false);
    await Promise.all([loadIssues(date), loadGroups()]);
  }

  async function handleUpdate(id: string, values: IssueFormValues) {
    await fetch(`/api/issues/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    setEditingId(null);
    await loadIssues(date);
  }

  // Быстрая смена статуса прямо на карточке, без открытия формы. "Решено"
  // и "Передано" сначала спрашивают детали в модалке (кто решил / кому
  // передали) — то, что попадёт в заметку и текст репорта, а не просто
  // молча меняют статус.
  async function handleStatusChange(issue: IssueDTO, status: IssueStatus) {
    if (status === "RESOLVED") {
      setResolvingId(issue.id);
      return;
    }
    if (status === "ESCALATED") {
      setEscalatingId(issue.id);
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
    setResolvingId(null);
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
    setEscalatingId(null);
    await loadIssues(date);
  }

  // Отвязать приклеенное обращение (промахнулись при объединении).
  async function handleDetach(issue: IssueDTO, link: string) {
    await fetch(`/api/issues/${issue.id}/attach-message`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ link }),
    });
    await loadIssues(date);
  }

  function handleDelete(issue: IssueDTO) {
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

  async function handleMove(
    groupItems: IssueDTO[],
    index: number,
    direction: -1 | 1
  ) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= groupItems.length) return;
    const a = groupItems[index];
    const b = groupItems[targetIndex];
    await Promise.all([
      fetch(`/api/issues/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: b.position }),
      }),
      fetch(`/api/issues/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: a.position }),
      }),
    ]);
    await loadIssues(date);
  }

  async function handleCopy() {
    if (!reportText) return;
    await navigator.clipboard.writeText(reportText);
    setCopied(true);
    toast("Репорт скопирован");
    setTimeout(() => setCopied(false), 2000);
  }

  const grouped = groupIssues(issues, groups);
  const usedGroupNames = new Set(grouped.map((g) => g.name));
  const isToday = date === todayDateString();
  const totalCount = issues.length;
  const resolvedCount = issues.filter((i) => i.status === "RESOLVED").length;
  const progressPercent = totalCount
    ? Math.round((resolvedCount / totalCount) * 100)
    : 0;

  useHotkeys({
    ArrowLeft: () => setDate(shiftDateString(date, -1)),
    ArrowRight: () => setDate(shiftDateString(date, 1)),
    t: () => setDate(todayDateString()),
    n: () => setAddingNew(true),
    c: handleCopy,
    "?": () => setShowShortcuts(true),
  });

  const paletteActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "new",
        label: "Новый тикет",
        hint: "n",
        Icon: IconPlus,
        run: () => setAddingNew(true),
      },
      {
        id: "copy",
        label: "Скопировать текст репорта",
        hint: "c",
        Icon: IconCopy,
        run: handleCopy,
      },
      {
        id: "today",
        label: "Перейти к сегодняшнему дню",
        hint: "t",
        run: () => setDate(todayDateString()),
      },
      {
        id: "shortcuts",
        label: "Показать горячие клавиши",
        hint: "?",
        run: () => setShowShortcuts(true),
      },
    ],
    // handleCopy замыкает reportText — его и отслеживаем.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reportText]
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      {confirmElement}
      <CommandPalette
        issues={issues}
        actions={paletteActions}
        onPickIssue={(issue) => setEditingId(issue.id)}
      />
      {showShortcuts && (
        <ShortcutsHelp
          shortcuts={SHORTCUTS}
          onClose={() => setShowShortcuts(false)}
        />
      )}

      {resolvingId &&
        (() => {
          const resolvingIssue = issues.find((i) => i.id === resolvingId);
          if (!resolvingIssue) return null;
          return (
            <ResolveDialog
              issue={resolvingIssue}
              currentAgent={currentAgent ?? ""}
              onCancel={() => setResolvingId(null)}
              onConfirm={(note) => handleConfirmResolve(resolvingIssue, note)}
            />
          );
        })()}

      {escalatingId &&
        (() => {
          const escalatingIssue = issues.find((i) => i.id === escalatingId);
          if (!escalatingIssue) return null;
          return (
            <EscalateDialog
              issue={escalatingIssue}
              onCancel={() => setEscalatingId(null)}
              onConfirm={(values) =>
                handleConfirmEscalate(escalatingIssue, values)
              }
            />
          );
        })()}

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
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

        <div className="flex items-center gap-3">
          {!loading && totalCount > 0 && (
            // Прогресс дня строкой из цифр читался как справка; полоса
            // отвечает на главный вопрос "мы близко к концу?" одним взглядом,
            // не требуя считать в уме.
            <div
              className="flex items-center gap-2"
              title={`${resolvedCount} из ${totalCount} тикетов решено`}
            >
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
              <span className="text-xs font-medium tabular-nums text-slate-500">
                {resolvedCount}/{totalCount}
              </span>
            </div>
          )}
          <button
            onClick={() => setDate(todayDateString())}
            disabled={isToday}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-brand-600 transition hover:bg-brand-50 disabled:pointer-events-none disabled:opacity-0"
          >
            Сегодня
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-xl bg-slate-100"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
              За этот день пока нет тикетов — добавь первый ниже.
            </p>
          )}
          {grouped.map((group) => {
            const color = groupColor(group.name);
            return (
              <section key={group.name}>
                <h2 className="mb-2 flex items-center gap-2">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold ${color.bg} ${color.text}`}
                  >
                    {group.name}
                    <span>{group.emoji}</span>
                  </span>
                  <span className="text-xs text-slate-400">
                    {group.items.length}
                  </span>
                </h2>
                <div className="space-y-2">
                  {group.items.map((issue, index) => (
                    <div key={issue.id}>
                      {editingId === issue.id ? (
                        <IssueForm
                          groups={groups}
                          currentAgent={currentAgent ?? ""}
                          initial={issue}
                          showGroupPicker={false}
                          fixedGroupName={issue.groupName}
                          onCancel={() => setEditingId(null)}
                          onSubmit={(values) => handleUpdate(issue.id, values)}
                        />
                      ) : (
                        <div
                          // Лёгкая лесенка при появлении списка: карточки
                          // проявляются сверху вниз, и глаз успевает
                          // проследить порядок группы, а не получает всё
                          // разом. Задержка ограничена, чтобы длинная
                          // группа не «доезжала» полсекунды.
                          style={{
                            animationDelay: `${Math.min(index, 6) * 25}ms`,
                          }}
                          className={`j40-slide-up group/row rounded-xl border-l-4 border-y border-r border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300 hover:shadow-md ${STATUS_META[issue.status].bar}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1">
                              <p className="text-sm text-slate-900">
                                {index + 1}. {issue.description}
                              </p>
                              {issueLinks(issue).map((link) => (
                                <span
                                  key={link}
                                  className="mt-1 flex items-center gap-1.5"
                                >
                                  <a
                                    href={link}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="truncate text-xs text-accent-600 hover:underline"
                                  >
                                    {link}
                                  </a>
                                  {issue.extraLinks?.includes(link) && (
                                    <button
                                      onClick={() => handleDetach(issue, link)}
                                      title="Отвязать это обращение от тикета"
                                      className="shrink-0 text-xs text-slate-300 hover:text-red-500"
                                    >
                                      ✕
                                    </button>
                                  )}
                                </span>
                              ))}
                              {issue.escalatedTeam && (
                                <p className="mt-1 flex items-center gap-1 text-xs text-orange-600">
                                  <IconSend className="h-3.5 w-3.5 shrink-0" />
                                  Передано: {issue.escalatedTeam}
                                  {issue.escalatedAssignee
                                    ? ` (${issue.escalatedAssignee})`
                                    : ""}
                                </p>
                              )}
                              <p className="mt-1 text-sm text-slate-500">
                                {issue.note || (
                                  <span className="italic text-slate-300">
                                    без заметки
                                  </span>
                                )}
                              </p>
                              {issue.ticketLink && (
                                <a
                                  href={issue.ticketLink}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 flex items-center gap-1 truncate text-xs text-brand-600 hover:underline"
                                >
                                  <IconTicket className="h-3.5 w-3.5 shrink-0" />
                                  {issue.ticketLink}
                                </a>
                              )}
                              {/* Раньше статус менялся нативным <select>:
                                  два клика на каждую смену, чужая системная
                                  вёрстка списка и никакой связи с теми же
                                  статусами на доске. Кнопки в ряд — один
                                  клик и одинаковый вид с канбаном. Подпись
                                  несёт только текущий статус: пять полных
                                  подписей в каждой строке перебивали собой
                                  текст самих тикетов. */}
                              <div className="mt-2 flex flex-wrap items-center gap-2">
                                <div className="flex flex-wrap items-center gap-0.5 rounded-full bg-slate-50 p-0.5 ring-1 ring-slate-200">
                                  {ISSUE_STATUSES.map((s) => {
                                    const meta = STATUS_META[s];
                                    const selected = issue.status === s;
                                    return (
                                      <button
                                        key={s}
                                        onClick={() =>
                                          handleStatusChange(issue, s)
                                        }
                                        title={meta.label}
                                        aria-label={meta.label}
                                        aria-pressed={selected}
                                        className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium transition ${
                                          selected
                                            ? meta.badge
                                            : "text-slate-400 opacity-50 hover:bg-white hover:opacity-100"
                                        }`}
                                      >
                                        {meta.emoji}
                                        {selected && (
                                          <span className="ml-1">
                                            {meta.label}
                                          </span>
                                        )}
                                      </button>
                                    );
                                  })}
                                </div>
                                <span className="flex items-center gap-1 text-xs text-slate-400">
                                  <Avatar name={issue.createdBy} size="sm" />
                                  {issue.createdBy}
                                </span>
                              </div>
                            </div>
                            {/* Те же кнопки, что и на доске, ведут себя
                                одинаково: проявляются на наведении, чтобы
                                колонка «Изменить/Удалить» не тянула на себя
                                внимание в каждой строке. */}
                            <div className="flex shrink-0 flex-col items-end gap-1.5 transition-opacity sm:opacity-0 sm:group-hover/row:opacity-100 sm:focus-within:opacity-100">
                              <div className="flex gap-0.5">
                                <button
                                  onClick={() =>
                                    handleMove(group.items, index, -1)
                                  }
                                  disabled={index === 0}
                                  className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 disabled:opacity-20"
                                  aria-label="Вверх"
                                >
                                  ↑
                                </button>
                                <button
                                  onClick={() =>
                                    handleMove(group.items, index, 1)
                                  }
                                  disabled={index === group.items.length - 1}
                                  className="rounded px-1.5 py-0.5 text-xs text-slate-400 hover:bg-slate-100 disabled:opacity-20"
                                  aria-label="Вниз"
                                >
                                  ↓
                                </button>
                              </div>
                              <button
                                onClick={() => setEditingId(issue.id)}
                                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900"
                              >
                                <IconEdit className="h-3.5 w-3.5" />
                                Изменить
                              </button>
                              <button
                                onClick={() => handleDelete(issue)}
                                className="flex items-center gap-1 text-xs text-red-400 transition hover:text-red-600"
                              >
                                <IconTrash className="h-3.5 w-3.5" />
                                Удалить
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {addingToGroup === group.name ? (
                  <div className="mt-2">
                    <IssueForm
                      groups={groups}
                      currentAgent={currentAgent ?? ""}
                      showGroupPicker={false}
                      fixedGroupName={group.name}
                      onCancel={() => setAddingToGroup(null)}
                      onSubmit={handleCreate}
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setAddingToGroup(group.name)}
                    className="mt-2 text-sm text-slate-500 hover:text-brand-700"
                  >
                    + Добавить тикет в «{group.name}»
                  </button>
                )}
              </section>
            );
          })}

          <section>
            {addingNew ? (
              <IssueForm
                groups={groups}
                currentAgent={currentAgent ?? ""}
                showGroupPicker
                onCancel={() => setAddingNew(false)}
                onSubmit={handleCreate}
              />
            ) : (
              <button
                onClick={() => setAddingNew(true)}
                className="rounded-lg border border-dashed border-slate-300 px-4 py-2 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-700"
              >
                + Добавить тикет{usedGroupNames.size ? " в новую группу" : ""}
              </button>
            )}
          </section>

          <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
            {/* Шапка липкая внутри секции: репорт за насыщенный день не
                помещается на экран, и кнопка "Скопировать" уезжала вверх
                ровно тогда, когда до неё дочитывали. */}
            <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
                Готовый репорт
                {!!reportText && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                    {reportText.split("\n").length} строк
                  </span>
                )}
              </h3>
              <button
                onClick={handleCopy}
                disabled={!reportText}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white shadow-sm transition disabled:opacity-40 ${
                  copied
                    ? "bg-emerald-600"
                    : "bg-brand-600 hover:bg-brand-700 active:scale-95"
                }`}
              >
                {copied ? (
                  <>
                    <IconCheck className="h-3.5 w-3.5" /> Скопировано
                  </>
                ) : (
                  <>
                    <IconCopy className="h-3.5 w-3.5" /> Скопировать
                  </>
                )}
              </button>
            </div>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words bg-slate-50/70 p-4 text-sm leading-relaxed text-slate-800">
              {reportText || "Нет тикетов за этот день."}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}
