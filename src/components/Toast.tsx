"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { IconCheck } from "@/components/Icons";

type ToastTone = "success" | "info" | "error";
type Toast = { id: number; text: string; tone: ToastTone };

const ToastContext = createContext<(text: string, tone?: ToastTone) => void>(
  () => {}
);

// Подтверждение действия должно быть заметным, но не требовать клика,
// чтобы его убрать: window.alert останавливал всю работу ради строчки
// "почистил 3 тикета" — на доске, где действия идут одно за другим, это
// сбивало ритм сильнее, чем помогало.
export function useToast() {
  return useContext(ToastContext);
}

const TONE_STYLE: Record<ToastTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  info: "border-slate-200 bg-white text-slate-700",
  error: "border-red-200 bg-red-50 text-red-700",
};

const TOAST_MS = 3200;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((text: string, tone: ToastTone = "success") => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, text, tone }]);
    setTimeout(
      () => setToasts((prev) => prev.filter((t) => t.id !== id)),
      TOAST_MS
    );
  }, []);

  // show стабилен (useCallback без зависимостей), но провайдер оборачивает
  // всё дерево — мемо, чтобы смена списка тостов не перерисовывала его.
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`j40-slide-up pointer-events-auto flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-medium shadow-lg shadow-slate-900/5 ${TONE_STYLE[t.tone]}`}
          >
            {t.tone === "success" && (
              <IconCheck className="h-4 w-4 shrink-0 text-emerald-600" />
            )}
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
