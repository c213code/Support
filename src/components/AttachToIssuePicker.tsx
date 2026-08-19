"use client";

import { useMemo, useState } from "react";
import type { IssueDTO } from "@/lib/types";
import { STATUS_META } from "@/lib/status";
import { groupColor } from "@/lib/groups";
import { similarity, SIMILARITY_HINT_THRESHOLD } from "@/lib/similarity";
import { issueLinks } from "@/lib/report";
import { extractTicketHints } from "@/lib/ticketHints";

// Выбор тикета, к которому приклеить это сообщение. Тикеты отсортированы
// по похожести на текст сообщения, а не по времени: когда один и тот же
// запрос прилетает третий раз, нужный тикет оказывается первым, и это
// один клик вместо чтения всего списка.
export function AttachToIssuePicker({
  messageText,
  issues,
  title = "К какому тикету приклеить?",
  emptyText = "За этот день ещё нет тикетов — сначала заведи первый.",
  pendingText = "Приклеиваем…",
  onCancel,
  onPick,
}: {
  // Текст, с которым сравниваем тикеты, чтобы поднять похожие наверх: это
  // либо сообщение из "Входящих", либо описание объединяемого тикета.
  messageText: string;
  issues: IssueDTO[];
  title?: string;
  emptyText?: string;
  pendingText?: string;
  onCancel: () => void;
  onPick: (issue: IssueDTO) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Похожесть текста ловит "тот же тип проблемы", а не "тот же ученик" —
  // куратор, ведущий нескольких учеников, часто присылает про второго
  // ученика точно такими же словами ("+тағы бір оқушы"). Если у обоих
  // — у сообщения и у кандидата — известна почта и они разные, это,
  // вероятнее всего, ДРУГОЙ случай с той же типовой проблемой, а не
  // повтор — предупреждаем явно, а не просто показываем "похоже".
  const messageEmails = useMemo(
    () => extractTicketHints([messageText]).emails,
    [messageText]
  );

  const ranked = useMemo(() => {
    const scored = issues.map((issue) => ({
      issue,
      score: similarity(messageText, issue.description),
    }));

    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? scored.filter(
          ({ issue }) =>
            issue.description.toLowerCase().includes(needle) ||
            issue.groupName.toLowerCase().includes(needle)
        )
      : scored;

    return filtered.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // При равной похожести — свежие сверху: обычно доклеивают к тому,
      // что завели только что.
      return b.issue.createdAt.localeCompare(a.issue.createdAt);
    });
  }, [issues, messageText, query]);

  async function handlePick(issue: IssueDTO) {
    if (pendingId) return;
    setPendingId(issue.id);
    try {
      await onPick(issue);
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-600">{title}</span>
        <button
          onClick={onCancel}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Отмена
        </button>
      </div>

      {issues.length > 4 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по описанию или группе"
          className="mb-2 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
        />
      )}

      {ranked.length === 0 ? (
        <p className="px-1 py-3 text-center text-xs text-slate-400">
          {issues.length === 0 ? emptyText : "Ничего не нашлось."}
        </p>
      ) : (
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {ranked.map(({ issue, score }) => {
            const color = groupColor(issue.groupName);
            const meta = STATUS_META[issue.status];
            const looksSimilar = score >= SIMILARITY_HINT_THRESHOLD;
            const attachedCount = issueLinks(issue).length;
            const issueEmails = issue.hints?.emails ?? [];
            const differentStudent =
              messageEmails.length > 0 &&
              issueEmails.length > 0 &&
              !messageEmails.some((email) => issueEmails.includes(email));
            return (
              <li key={issue.id}>
                <button
                  onClick={() => handlePick(issue)}
                  disabled={pendingId !== null}
                  className={`w-full rounded-lg border px-2.5 py-2 text-left transition disabled:opacity-50 ${
                    looksSimilar
                      ? "border-accent-400 bg-accent-500/5 hover:border-accent-500"
                      : "border-slate-200 bg-white hover:border-slate-300"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${color.bg} ${color.text}`}
                    >
                      {issue.groupName}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.badge}`}
                    >
                      {meta.emoji} {meta.label}
                    </span>
                    {attachedCount > 1 && (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                        обращений: {attachedCount}
                      </span>
                    )}
                    {looksSimilar && (
                      <span className="rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                        похоже
                      </span>
                    )}
                    {differentStudent && (
                      <span
                        title={`Почта в сообщении: ${messageEmails.join(", ")} — у тикета: ${issueEmails.join(", ")}`}
                        className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                      >
                        ⚠️ другая почта
                      </span>
                    )}
                  </span>
                  <span className="mt-1 line-clamp-2 block text-xs text-slate-800">
                    {pendingId === issue.id ? pendingText : issue.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
