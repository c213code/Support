"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";

type Term = {
  id: string;
  term: string;
  meaning: string;
  auto: boolean;
};

// Что ИИ знает о нашем проекте. Показывать это важно не ради красоты:
// словарь подмешивается во все запросы к модели, и когда ИИ вдруг начинает
// писать описания мимо смысла, первое место, куда стоит заглянуть, — сюда.
// Вписанное руками (auto = false) пересборка не перезаписывает.
export function GlossaryPanel({
  onClose,
  onError,
  onInfo,
}: {
  onClose: () => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
}) {
  const [terms, setTerms] = useState<Term[] | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [newTerm, setNewTerm] = useState("");
  const [newMeaning, setNewMeaning] = useState("");

  async function load() {
    const res = await fetch("/api/glossary");
    const data = await res.json();
    setTerms(data.terms ?? []);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial data load on mount
    load();
  }, []);

  async function post(body: Record<string, unknown>) {
    const res = await fetch("/api/glossary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      onError(data?.error ?? "Не получилось");
      return null;
    }
    return res.json();
  }

  async function handleRebuild() {
    setRebuilding(true);
    const data = await post({ action: "rebuild" });
    setRebuilding(false);
    if (data) {
      onInfo(`Словарь обновлён: ${data.added} терминов`);
      await load();
    }
  }

  async function handleAdd() {
    if (!newTerm.trim() || !newMeaning.trim()) return;
    if (await post({ term: newTerm, meaning: newMeaning })) {
      setNewTerm("");
      setNewMeaning("");
      await load();
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="glossary-title">
      <div className="max-h-[80vh] w-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h2 id="glossary-title" className="text-sm font-semibold text-slate-900">
            🧠 Что ИИ знает о проекте
          </h2>
          <button
            onClick={handleRebuild}
            disabled={rebuilding}
            className="shrink-0 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {rebuilding ? "Собираем…" : "Пересобрать из истории"}
          </button>
        </div>
        <p className="mb-3 text-xs leading-snug text-slate-500">
          Внутренние сокращения из нашей же переписки. Подмешиваются во все
          запросы к ИИ — без них он разбирает обращения вслепую. Обновляется
          само раз в сутки; вписанное руками не перезаписывается.
        </p>

        <div className="mb-3 flex flex-wrap gap-1.5 rounded-lg bg-slate-50 p-2">
          <input
            value={newTerm}
            onChange={(e) => setNewTerm(e.target.value)}
            placeholder="ДТ"
            className="w-20 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-brand-400"
          />
          <input
            value={newMeaning}
            onChange={(e) => setNewMeaning(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="что это значит"
            className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1 text-xs outline-none focus:border-brand-400"
          />
          <button
            onClick={handleAdd}
            disabled={!newTerm.trim() || !newMeaning.trim()}
            className="rounded bg-brand-600 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40"
          >
            Добавить
          </button>
        </div>

        {terms === null ? (
          <p className="py-6 text-center text-xs text-slate-400">Загружаем…</p>
        ) : terms.length === 0 ? (
          <p className="py-6 text-center text-xs text-slate-400">
            Пока пусто — нажми «Пересобрать из истории».
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-100">
            {terms.map((t) => (
              <li key={t.id} className="group flex items-baseline gap-2 py-1.5">
                <span className="shrink-0 font-mono text-xs font-semibold text-slate-800">
                  {t.term}
                </span>
                {!t.auto && (
                  <span
                    title="Вписано руками — пересборка это не тронет"
                    className="shrink-0 rounded bg-amber-100 px-1 text-[10px] font-medium text-amber-700"
                  >
                    ручной
                  </span>
                )}
                <span className="min-w-0 flex-1 text-xs text-slate-500">
                  {t.meaning}
                </span>
                <button
                  onClick={async () => {
                    if (await post({ action: "delete", id: t.id })) await load();
                  }}
                  title="Удалить термин"
                  className="shrink-0 text-xs text-slate-300 opacity-0 transition group-hover:opacity-100 hover:text-red-500"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
