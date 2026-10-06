"use client";

import { useRef, useState } from "react";
import { MAX_CHAT_MESSAGE, type ReconcileChatOptions } from "@/lib/reconcileChat";

type ChatRun = {
  id: string;
  instructions: string[];
  scope: string;
  finishedAt: string | null;
  verdicts: { state: string; proposed: string | null; appliedAt: string | null; reason: string | null }[];
};

function reply(run: ChatRun): string {
  const checked = run.verdicts.filter((v) => v.state !== "pending").length;
  const matched = run.verdicts.filter((v) => v.state === "done" && ["RESOLVED", "IN_PROGRESS", "PENDING"].includes(v.proposed ?? "")).length;
  const applied = run.verdicts.filter((v) => v.appliedAt).length;
  const errors = run.verdicts.filter((v) => v.state === "error").length;
  const questions = [...new Set(run.verdicts.map((v) => v.reason).filter((reason): reason is string => Boolean(reason?.includes("?"))))].slice(0, 2);
  if (!run.finishedAt) return `Проверено ${checked} из ${run.verdicts.length}. Ищу обращения по вашей теме…`;
  if (!run.verdicts.length) return "В выбранной области нет открытых тикетов.";
  return `Проверено ${checked} тикетов. Подходящих: ${matched}. Применено: ${applied}.` +
    (errors ? ` Не удалось проверить: ${errors}.` : "") +
    (matched ? " Решения и причины — ниже. Проверьте список и нажмите «Применить отмеченные»." :
      ` Уверенных изменений нет. ${questions.length ? questions.join(" ") : "Уточните проблему, группу и нужный статус; причины указаны у тикетов ниже."}`);
}

export function AutoReportChat({ date, activeRun, runs, disabled, onSend }: {
  date: string;
  activeRun: ChatRun | null;
  runs: ChatRun[];
  disabled: boolean;
  onSend: (options: ReconcileChatOptions) => Promise<string | null>;
}) {
  const [message, setMessage] = useState("");
  const [scope, setScope] = useState<"day" | "all_open">("day");
  const [newChat, setNewChat] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const conversation = !newChat && activeRun?.instructions.length ? activeRun : null;
  const effectiveScope = conversation?.scope === "all_open" ? "all_open" : conversation ? "day" : scope;

  async function send() {
    if (submitting.current || disabled || !message.trim()) return;
    submitting.current = true;
    setSending(true);
    setError(null);
    try {
      const failure = await onSend({ instruction: message.trim(), scope: effectiveScope,
        ...(conversation ? { previousRunId: conversation.id } : {}) });
      if (failure) setError(failure);
      else { setMessage(""); setNewChat(false); }
    } catch {
      setError("Не удалось отправить сообщение. Попробуйте ещё раз.");
    } finally {
      submitting.current = false;
      setSending(false);
    }
  }

  return (
    <section aria-label="Чат с ИИ по тикетам" className="mb-4 rounded-xl border border-brand-200 bg-brand-50/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Объясните ИИ, что изменилось</h3>
        {conversation && <button type="button" disabled={disabled || sending} onClick={() => { setNewChat(true); setError(null); }}
          className="text-xs text-brand-700 disabled:opacity-50">Новый диалог</button>}
      </div>
      <p className="mt-1 text-xs text-slate-500">Например: «Сбой мини-тестов исправили. Найди связанные обращения и поставь “Решено”, кроме математики».</p>
      {conversation && (
        <div role="log" aria-label="История диалога" className="my-3 max-h-64 space-y-2 overflow-y-auto text-sm">
          {conversation.instructions.map((text, index) => {
            const turn = index === conversation.instructions.length - 1 ? conversation : runs.find((r) =>
              r.instructions.length === index + 1 && r.instructions.every((t, i) => t === conversation.instructions[i]));
            return <div key={index} className="space-y-2">
              <p className="ml-6 whitespace-pre-wrap rounded-xl bg-brand-100 px-3 py-2 text-slate-800"><span className="block text-xs text-brand-700">Дежурный</span>{text}</p>
              {turn && <p className="mr-6 rounded-xl border border-slate-200 bg-white px-3 py-2 text-slate-700"><span className="block text-xs text-slate-400">ИИ · {turn.scope === "all_open" ? `все открытые до ${date} включительно` : date}</span>{reply(turn)}</p>}
            </div>;
          })}
        </div>
      )}
      <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label className="flex items-center gap-2 text-xs text-slate-600">Проверить
          <select aria-label="Область поиска тикетов" value={effectiveScope} disabled={disabled || sending || Boolean(conversation)}
            onChange={(event) => setScope(event.target.value as "day" | "all_open")} className="rounded-lg border border-slate-200 bg-white px-2 py-1">
            <option value="day">Открытые за {date}</option>
            <option value="all_open">Все открытые до {date} включительно</option>
          </select>
        </label>
        <textarea aria-label="Сообщение для ИИ" value={message} maxLength={MAX_CHAT_MESSAGE} rows={3}
          onChange={(event) => setMessage(event.target.value)} disabled={disabled || sending}
          placeholder={conversation ? "Уточните: например, только те, где мини-тест не открывался" : "Мини тест решён, найди все связанные тикеты"}
          className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm disabled:opacity-50" />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-400">{message.length}/{MAX_CHAT_MESSAGE} · Можно писать по-русски и по-казахски</span>
          <button type="submit" disabled={disabled || sending || !message.trim()}
            className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            {sending ? "Отправляю…" : "Найти связанные"}
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      </form>
    </section>
  );
}
