"use client";

import { useEffect, useState } from "react";
import { fetchApiJson } from "@/lib/fetchApiJson";
import type { ChatThreadDTO } from "@/lib/submissionChat";

// Переписка с куратором в окне тикета. Дежурный пишет здесь, куратор получает
// сообщение от бота в личку и отвечает там же — своего чата в мини-аппе нет
// (см. lib/submissionChat.ts).
//
// Тредов бывает несколько: тикет мог быть склеен из заявок разных кураторов.
// Тогда сверху появляется выбор, кому пишем, — иначе дежурный отвечал бы
// одному, думая, что говорит с другим.
export function SubmissionChat({ issueId }: { issueId: string }) {
  const [threads, setThreads] = useState<ChatThreadDTO[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const res = await fetchApiJson<{ threads: ChatThreadDTO[] }>(
        `/api/issues/${issueId}/chat`
      );
      if (cancelled) return;
      if (!res.ok) {
        setError(
          res.reason === "session"
            ? "Сессия истекла — обновите страницу"
            : "Переписка не загрузилась"
        );
        setThreads([]);
        return;
      }
      setThreads(res.data.threads);
      setActiveId((current) => current ?? res.data.threads[0]?.submissionId ?? null);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  if (threads === null) {
    return <p className="text-xs text-slate-400">Загружаем переписку…</p>;
  }
  if (threads.length === 0) {
    return error ? <p className="text-xs text-rose-600">{error}</p> : null;
  }

  const active = threads.find((t) => t.submissionId === activeId) ?? threads[0];

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    const res = await fetchApiJson<{ threads: ChatThreadDTO[] }>(
      `/api/issues/${issueId}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submissionId: active.submissionId, text }),
      }
    );
    setSending(false);

    if (!res.ok) {
      setError(
        res.reason === "session"
          ? "Сессия истекла — обновите страницу"
          : (res.error ?? "Сообщение не ушло")
      );
      return;
    }
    setThreads(res.data.threads);
    setDraft("");
  }

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-slate-500">💬 Переписка с куратором</p>
        {threads.length > 1 &&
          threads.map((thread) => (
            <button
              key={thread.submissionId}
              type="button"
              onClick={() => setActiveId(thread.submissionId)}
              className={`rounded-full px-2 py-0.5 text-xs ${
                thread.submissionId === active.submissionId
                  ? "bg-brand-600 text-white"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {thread.curatorName}
            </button>
          ))}
      </div>

      {active.messages.length === 0 ? (
        <p className="text-xs text-slate-400">
          Ещё не писали. Куратор получит сообщение от бота в личку и ответит туда же.
        </p>
      ) : (
        <div className="max-h-56 space-y-1.5 overflow-y-auto">
          {active.messages.map((message) => (
            <div
              key={message.id}
              className={`rounded-lg px-2.5 py-1.5 text-xs ${
                message.fromAgent
                  ? "ml-6 bg-brand-50 text-slate-700"
                  : "mr-6 bg-slate-100 text-slate-700"
              }`}
            >
              <p className="mb-0.5 text-[11px] text-slate-500">
                {message.authorName}
                {!message.delivered && " · не доставлено"}
              </p>
              <p className="whitespace-pre-wrap break-words">{message.text}</p>
              {message.photoCount > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {Array.from({ length: message.photoCount }, (_, i) => (
                    // Не next/image: фото отдаёт маршрут за сессией агента, а
                    // оптимизатор Next ходит без куки и получил бы /login.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={`/api/issues/${issueId}/chat/photo?m=${message.id}&i=${i}`}
                      alt={`Фото ${i + 1} от куратора`}
                      loading="lazy"
                      className="max-h-24 rounded border border-slate-200"
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={2}
        placeholder="Что уточнить у куратора?"
        className="w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
      />
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-400">Куратор увидит сообщение от бота</p>
        <button
          type="button"
          onClick={send}
          disabled={!draft.trim() || sending}
          className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {sending ? "Отправляем…" : "Отправить"}
        </button>
      </div>
    </div>
  );
}
