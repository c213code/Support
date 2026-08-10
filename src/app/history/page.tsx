import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { prisma } from "@/lib/prisma";
import { formatDateHuman } from "@/lib/date";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [rows, resolvedRows] = await Promise.all([
    prisma.issue.groupBy({
      by: ["reportDate"],
      _count: { _all: true },
      orderBy: { reportDate: "desc" },
    }),
    // Отдельным запросом — сколько из них решено: на самой странице
    // раньше было видно только "сколько всего", а по этому числу нельзя
    // отличить тяжёлый день от спокойного.
    prisma.issue.groupBy({
      by: ["reportDate"],
      where: { status: "RESOLVED" },
      _count: { _all: true },
    }),
  ]);

  const resolvedByDate = new Map(
    resolvedRows.map((r) => [r.reportDate, r._count._all])
  );
  const totalIssues = rows.reduce((sum, r) => sum + r._count._all, 0);

  return (
    <div className="min-h-screen">
      <AppHeader />
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-lg font-semibold text-slate-900">
            История репортов
          </h1>
          {rows.length > 0 && (
            <p className="text-xs text-slate-400">
              {rows.length} дн. · {totalIssues} тикет(ов) всего
            </p>
          )}
        </div>

        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-400">
            Пока нет ни одного репорта.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row, index) => {
              const total = row._count._all;
              const resolved = resolvedByDate.get(row.reportDate) ?? 0;
              const percent = total ? Math.round((resolved / total) * 100) : 0;
              return (
                <li key={row.reportDate}>
                  <Link
                    href={`/?date=${row.reportDate}`}
                    style={{ animationDelay: `${Math.min(index, 8) * 25}ms` }}
                    className="j40-slide-up flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm transition hover:-translate-y-px hover:border-brand-300 hover:shadow-md"
                  >
                    <span className="flex-1 font-medium text-slate-900">
                      {formatDateHuman(row.reportDate)}
                    </span>
                    <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-slate-200 sm:block">
                      <span
                        className="block h-full rounded-full bg-emerald-500"
                        style={{ width: `${percent}%` }}
                      />
                    </span>
                    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium tabular-nums text-slate-500">
                      {resolved}/{total}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
