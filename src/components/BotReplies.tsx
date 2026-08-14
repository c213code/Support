"use client";

import { useState } from "react";
import type { BotReplyDTO } from "@/lib/types";

// Что бот сказал в рабочей группе по этому тикету — прямо на карточке,
// чтобы было видно, что уже прозвучало коллегам, и не написать им то же
// самое второй раз руками.
//
// Правка — действие по умолчанию, удаление спрятано вторым: удаление
// ничего не исправляет для того, кто уже прочитал, а правку человек хотя
// бы увидит (Telegram помечает "изменено") и тред с реплаем не порвётся.
// Оба возможны только 48 часов — дальше Telegram отказывает, и сервер
// возвращает это текстом, который показываем как есть.
export function BotReplies({
  issueId,
  replies,
  onChanged,
  onError,
}: {
  issueId: string;
  replies: BotReplyDTO[];
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  if (replies.length === 0) return null;

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    const res = await fetch(`/api/issues/${issueId}/bot-replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      onError(data?.error ?? "Не получилось");
      return false;
    }
    setEditingId(null);
    onChanged();
    return true;
  }

  return (
    <div className="mt-2 flex flex-col gap-1 rounded-lg bg-slate-50 p-2">
      {replies.map((reply) => (
        <div key={reply.id} className="group/reply text-[11px] leading-snug">
          {editingId === reply.id ? (
            <div className="flex flex-col gap-1">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={2}
                autoFocus
                className="w-full rounded border border-slate-300 px-1.5 py-1 text-[11px] focus:border-brand-500 focus:outline-none"
              />
              <div className="flex gap-1">
                <button
                  disabled={busy || !draft.trim()}
                  onClick={() => send({ replyId: reply.id, text: draft })}
                  className="rounded bg-brand-600 px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  Сохранить
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="rounded px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200"
                >
                  Отмена
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-1">
              <span className="shrink-0 text-slate-400">🤖</span>
              <span className="flex-1 text-slate-600">{reply.text}</span>
              <span className="flex shrink-0 gap-1 opacity-0 transition group-hover/reply:opacity-100">
                <button
                  onClick={() => {
                    setEditingId(reply.id);
                    setDraft(reply.text);
                  }}
                  title="Исправить сообщение в группе"
                  className="text-slate-400 hover:text-brand-600"
                >
                  ✎
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("Удалить это сообщение бота из группы?")) {
                      send({ replyId: reply.id, action: "delete" });
                    }
                  }}
                  title="Удалить сообщение из группы"
                  className="text-slate-400 hover:text-red-500"
                >
                  ✕
                </button>
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
