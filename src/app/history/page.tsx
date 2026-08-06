import Link from "next/link";
import { AppHeader } from "@/components/AppHeader";
import { prisma } from "@/lib/prisma";
import { formatDateHuman } from "@/lib/date";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const rows = await prisma.issue.groupBy({
    by: ["reportDate"],
    _count: { _all: true },
    orderBy: { reportDate: "desc" },
  });

  return (
    <div className="min-h-screen">
      <AppHeader />
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-lg font-semibold text-slate-900">
          История репортов
        </h1>

        {rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-400">
            Пока нет ни одного репорта.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.reportDate}>
                <Link
                  href={`/?date=${row.reportDate}`}
                  className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm transition hover:border-brand-300 hover:shadow-md"
                >
                  <span className="font-medium text-slate-900">
                    {formatDateHuman(row.reportDate)}
                  </span>
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                    {row._count._all} тикет(ов)
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
