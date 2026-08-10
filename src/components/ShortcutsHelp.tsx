"use client";

import { Modal } from "@/components/Modal";

export type Shortcut = { keys: string[]; description: string };

// Горячие клавиши, о которых никто не знает, — это не фича. Список
// открывается по "?" и живёт рядом с самими клавишами: каждая страница
// передаёт свой набор, общая часть добавляется здесь.
const GLOBAL_SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], description: "Поиск по тикетам и командам" },
  { keys: ["?"], description: "Этот список" },
  { keys: ["Esc"], description: "Закрыть окно" },
];

export function ShortcutsHelp({
  shortcuts,
  onClose,
}: {
  shortcuts: Shortcut[];
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} labelledBy="shortcuts-title">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
        <h2
          id="shortcuts-title"
          className="mb-3 text-sm font-semibold text-slate-900"
        >
          Горячие клавиши
        </h2>
        <ul className="space-y-1.5">
          {[...shortcuts, ...GLOBAL_SHORTCUTS].map((s) => (
            <li
              key={s.description}
              className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 text-sm text-slate-600 odd:bg-slate-50"
            >
              <span>{s.description}</span>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    className="min-w-[22px] rounded border border-slate-300 bg-white px-1.5 py-0.5 text-center text-[11px] font-medium text-slate-500 shadow-sm"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
