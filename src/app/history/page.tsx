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
    <div className="min-h-screen bg-slate-50">
      <AppHeader />
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        <h1 className="mb-4 text-lg font-semibold text-slate-900">
          История репортов
        </h1>

        {rows.length === 0 ? (
          <p className="text-sm text-slate-400">Пока нет ни одного репорта.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.reportDate}>
                <Link
                  href={`/?date=${row.reportDate}`}
                  className="flex items-center justify-between rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm hover:border-slate-400"
                >
                  <span className="font-medium text-slate-900">
                    {formatDateHuman(row.reportDate)}
                  </span>
                  <span className="text-slate-400">
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
