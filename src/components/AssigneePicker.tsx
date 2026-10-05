"use client";

import type { Ref } from "react";
import type { EscalationTeam } from "@/lib/escalation";
import type { DevTeams } from "@/lib/useDevTeams";

// «Кто занимается» при передаче: люди выбранной команды кнопками (лид со
// звёздочкой и первым), а поле ниже — для тех, кого нет в списке. Пустой
// список (DEV_TEAM_MEMBERS не задан) — остаётся одно поле, как раньше.
export function AssigneePicker({
  teams,
  team,
  value,
  onChange,
  inputId,
  inputRef,
  inputClassName,
}: {
  teams: DevTeams;
  team: EscalationTeam | "";
  value: string;
  onChange: (next: string) => void;
  inputId?: string;
  inputRef?: Ref<HTMLInputElement>;
  inputClassName: string;
}) {
  const members = team ? teams[team] ?? [] : [];

  return (
    <div className="space-y-1.5">
      {members.length > 0 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Люди в команде">
          {members.map((m) => {
            const selected = value.trim() === m.name;
            return (
              <button
                key={m.name}
                type="button"
                aria-pressed={selected}
                // Повторное нажатие снимает выбор — «без конкретного человека».
                onClick={() => onChange(selected ? "" : m.name)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                  selected
                    ? "border-orange-500 bg-orange-100 text-orange-700 ring-1 ring-orange-200"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {m.lead && <span aria-label="тимлид">★ </span>}
                {m.name}
              </button>
            );
          })}
        </div>
      )}
      <input
        id={inputId}
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={members.length > 0 ? "Или другой человек" : "Например: Аян"}
        className={inputClassName}
      />
    </div>
  );
}
