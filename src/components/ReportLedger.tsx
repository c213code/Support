"use client";

import { useState } from "react";
import type { GroupPresetDTO, IssueDTO } from "@/lib/types";
import { generateReportText, groupIssues } from "@/lib/report";
import { STATUS_META } from "@/lib/status";
import { formatDateHuman } from "@/lib/date";
import { useToast } from "@/components/Toast";
import { IconCopy, IconCheck } from "@/components/Icons";

// Репорт использует те же данные и формат, что и Дашборд.
export function ReportLedger({
  issues,
  groups,
  date,
}: {
  issues: IssueDTO[];
  groups: GroupPresetDTO[];
  date: string;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const reportable = issues.filter((i) => i.status !== "SENT");
  const grouped = groupIssues(reportable, groups);
  const resolved = issues.filter((i) => i.status === "RESOLVED").length;
  const active = issues.filter(
    (i) =>
      i.status === "IN_PROGRESS" ||
      i.status === "PENDING" ||
      i.status === "NEXT_DAY" ||
      i.status === "ESCALATED"
  ).length;

  async function handleCopy() {
    const text = generateReportText(issues, groups);
    if (!text.trim()) {
      toast("Пока нечего копировать", "info");
      return;
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    toast("Репорт скопирован");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="sticky top-6 flex max-h-[calc(100vh-3rem)] flex-col rounded-[22px] border border-slate-100 bg-white p-5 text-slate-700">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-600">
          Репорт боссам
        </span>
        <span className="text-xs tabular-nums text-slate-400">
          {formatDateHuman(date)}
        </span>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto pr-1 text-[13px] leading-relaxed">
        {grouped.length === 0 ? (
          <p className="text-sm text-slate-400">
            Пока нечего отправлять — как только тикеты уйдут в работу или
            «Решено», они появятся здесь.
          </p>
        ) : (
          <div className="space-y-4">
            {grouped.map((group) => (
              <div key={group.name}>
                <p className="font-semibold text-brand-600">
                  {group.name}
                  {group.emoji ?? ""}
                </p>
                <ul className="mt-1 space-y-1">
                  {group.items.map((issue) => (
                    <li key={issue.id} className="text-slate-700">
                      • {issue.description}{" "}
                      <span className="text-slate-500">
                        — {STATUS_META[issue.status].label.toLowerCase()}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <div className="text-xl font-extrabold tabular-nums text-emerald-600">
            {resolved}
          </div>
          <div className="mt-0.5 text-[10.5px] font-medium text-slate-400">
            решено
          </div>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <div className="text-xl font-extrabold tabular-nums text-amber-600">
            {active}
          </div>
          <div className="mt-0.5 text-[10.5px] font-medium text-slate-400">
            в работе
          </div>
        </div>
        <div className="rounded-xl bg-slate-50 px-3 py-2">
          <div className="text-xl font-extrabold tabular-nums text-brand-600">
            {issues.length}
          </div>
          <div className="mt-0.5 text-[10.5px] font-medium text-slate-400">
            всего
          </div>
        </div>
      </div>

      <button
        onClick={handleCopy}
        className="mt-4 flex items-center justify-center gap-2 rounded-xl bg-brand-600 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-500"
      >
        {copied ? (
          <>
            <IconCheck className="h-4 w-4" /> Скопировано
          </>
        ) : (
          <>
            <IconCopy className="h-4 w-4" /> Скопировать репорт
          </>
        )}
      </button>
    </div>
  );
}
