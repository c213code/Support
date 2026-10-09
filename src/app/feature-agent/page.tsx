import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/AppShell";
import { SupportPageHeader } from "@/components/SupportPageHeader";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { AutoRefresh } from "./AutoRefresh";
import { AgentControl } from "./AgentControl";
import { featureAgentState, LOCAL_FEATURE_AGENT_ID } from "@/lib/featureAgentState";
import { todayDateString } from "@/lib/date";

export const dynamic = "force-dynamic";

type Query = { id: string; sql: string };

export default async function FeatureAgentPage() {
  if (!await getCurrentIdentity()) redirect("/login");
  const drafts = await prisma.featureAgentDraft.findMany({
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { issue: { select: { id: true, reportDate: true, groupName: true,
      description: true, status: true, updatedAt: true } } },
  });
  const control = await prisma.localFeatureAgentControl.findUnique({ where: { id: LOCAL_FEATURE_AGENT_ID } });
  return (
    <AppShell>
      <div className="support-page max-w-6xl">
        <AutoRefresh />
        <SupportPageHeader title="Локальный агент по фичам"
          description="Черновики по тикетам Support. Агент работает, только пока включён ноутбук; ответ и SQL проверяет дежурный." />
        <AgentControl initial={featureAgentState(control, todayDateString())} />
        {drafts.length === 0 ? (
          <div className="support-panel p-6 text-sm text-slate-600">Пока нет черновиков. Запустите локального агента и дождитесь нового обращения.</div>
        ) : <div className="space-y-4">
          {drafts.map((item) => {
            const stale = item.issueUpdatedAt.getTime() !== item.issue.updatedAt.getTime();
            const queries = Array.isArray(item.queries) ? item.queries as Query[] : [];
            return <article key={item.id} className="support-panel space-y-4 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs text-slate-500">{item.issue.reportDate} · {item.issue.groupName} · {item.feature || "Фича не определена"}</p>
                  <h2 className="font-semibold text-slate-800">{item.issue.description}</h2>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {stale && <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-800">Тикет изменился после разбора</span>}
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-700">{item.status}</span>
                  <Link href={`/?date=${item.issue.reportDate}`} className="text-brand-700 hover:underline">Открыть день</Link>
                </div>
              </div>
              <p className="text-sm text-slate-600">{item.summary}</p>
              {item.draft && <div className="rounded-xl border border-brand-100 bg-brand-50/50 p-4">
                <h3 className="mb-2 text-sm font-semibold text-slate-800">Черновик ответа</h3>
                <p className="whitespace-pre-wrap text-sm text-slate-800">{item.draft}</p>
              </div>}
              {item.evidence.length > 0 && <div><h3 className="text-sm font-semibold">Основание</h3><ul className="list-disc pl-5 text-sm text-slate-600">{item.evidence.map((entry, index) => <li key={index}>{entry}</li>)}</ul></div>}
              {item.missingData.length > 0 && <div><h3 className="text-sm font-semibold">Что проверить</h3><ul className="list-disc pl-5 text-sm text-slate-600">{item.missingData.map((entry, index) => <li key={index}>{entry}</li>)}</ul></div>}
              {queries.length > 0 && <div className="space-y-2"><h3 className="text-sm font-semibold">SELECT для дежурного · здесь не выполняются</h3>
                {queries.map((query) => <details key={query.id} className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer text-sm font-medium">{query.id}</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs">{query.sql}</pre></details>)}
              </div>}
              {(item.ruleIds.length > 0 || item.sourcePaths.length > 0) && <p className="text-xs text-slate-500">Правила: {item.ruleIds.join(", ") || "—"} · Код: {item.sourcePaths.join(", ") || "—"}</p>}
              {item.error && <p className="text-sm text-red-700">Ошибка агента: {item.error}</p>}
            </article>;
          })}
        </div>}
      </div>
    </AppShell>
  );
}
