"use client";

import { useEffect, useRef, useState } from "react";

export type ToggleSpec = {
  key: string;
  label: string;
  hint: string;
  enabled: boolean | null;
  onToggle: () => void;
  // Цвет включённого состояния — совпадает с тем, чем эта фича отмечена в
  // остальном интерфейсе, чтобы связь читалась без подписи.
  color: string;
  // Настройка включена, но не работает, потому что выключена та, поверх
  // которой она надстроена. Без этой строки список читается как четыре
  // равноправные фичи, и включённый тумблер, который ничего не делает,
  // выглядит поломкой.
  note?: string | null;
};

// Настройки-переключатели одним меню, а не россыпью тумблеров в шапке.
// Их стало три (ИИ-описания, автоответы, чтение реплик), и в строку они
// уже не помещаются на ноутбуке, а главное — это редкие настройки "включил
// и забыл", которым не место на одном уровне с ежедневными действиями.
export function BotSettingsMenu({ toggles }: { toggles: ToggleSpec[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const activeCount = toggles.filter((t) => t.enabled).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Настройки бота и ИИ"
        className="flex items-center gap-1.5 rounded-full border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-50"
      >
        ⚙️ Бот
        {activeCount > 0 && (
          <span className="rounded-full bg-emerald-100 px-1.5 text-[10px] font-semibold text-emerald-700">
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          {toggles.map((t) => (
            <button
              key={t.key}
              type="button"
              role="switch"
              aria-checked={t.enabled ?? false}
              onClick={t.onToggle}
              disabled={t.enabled === null}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-slate-50 disabled:opacity-50"
            >
              <span
                className={`relative mt-0.5 h-4 w-7 shrink-0 rounded-full transition ${
                  t.enabled ? t.color : "bg-slate-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition ${
                    t.enabled ? "left-3.5" : "left-0.5"
                  }`}
                />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-slate-700">
                  {t.label}
                </span>
                <span className="block text-[11px] leading-snug text-slate-400">
                  {t.hint}
                </span>
                {t.note && (
                  <span className="mt-0.5 block text-[11px] font-medium leading-snug text-amber-600">
                    {t.note}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
