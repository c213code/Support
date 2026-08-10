"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";

export type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel?: string;
  tone?: "danger" | "normal";
  onConfirm: () => void | Promise<void>;
};

// Замена window.confirm. Нативный диалог рвёт визуальный контекст (своя
// системная рамка, чужой шрифт, нельзя показать текст тикета) и, что
// важнее, не даёт отличить опасное действие от рутинного — "Удалить
// тикет" и "Перевести пендинги" выглядели одинаково.
export function ConfirmDialog({
  request,
  onClose,
}: {
  request: ConfirmRequest;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const danger = request.tone === "danger";

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await request.onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="confirm-title">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <h2
          id="confirm-title"
          className="text-sm font-semibold text-slate-900"
        >
          {request.title}
        </h2>
        {request.body && (
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {request.body}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-1.5 text-sm text-slate-500 transition hover:bg-slate-100"
          >
            Отмена
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium text-white shadow-sm transition disabled:opacity-50 ${
              danger
                ? "bg-red-600 hover:bg-red-700"
                : "bg-brand-600 hover:bg-brand-700"
            }`}
          >
            {busy ? "Выполняем…" : (request.confirmLabel ?? "Подтвердить")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Небольшой хук, чтобы вызывающий код оставался таким же коротким, как
// был с window.confirm: const confirm = useConfirm(); confirm({...}).
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  return {
    confirm: setRequest,
    element: request ? (
      <ConfirmDialog request={request} onClose={() => setRequest(null)} />
    ) : null,
  };
}
