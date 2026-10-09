"use client";

import { useEffect, useRef, useState } from "react";
import type { FeatureAgentState } from "@/lib/featureAgentState";

export function AgentControl({ initial }: { initial: FeatureAgentState }) {
  const [state, setState] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      if (document.hidden || busy.current) return;
      const requestedRevision = revision.current;
      try {
        const response = await fetch("/api/settings/local-feature-agent", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Не удалось обновить состояние агента");
        const next = await response.json() as FeatureAgentState;
        if (!busy.current && requestedRevision === revision.current) { setState(next); setError(null); }
      } catch (err) {
        if (!controller.signal.aborted && !busy.current) setError(err instanceof Error ? err.message : "Нет связи с сайтом");
      }
    }
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  async function toggle() {
    if (busy.current) return;
    busy.current = true;
    revision.current++;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/settings/local-feature-agent", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !state.enabled }),
      });
      if (!response.ok) throw new Error("Не удалось сохранить переключатель");
      setState(await response.json() as FeatureAgentState);
    } catch (err) { setError(err instanceof Error ? err.message : "Ошибка сохранения"); }
    finally { busy.current = false; setSaving(false); }
  }

  const status = !state.online ? "Ноутбук не на связи"
    : state.currentIssueId ? state.enabled ? "Разбирает обращение" : "Завершает текущий разбор"
    : !state.enabled ? "Обработка выключена"
    : state.runsCount >= state.dailyLimit ? "Лимит на сегодня достигнут" : "Ожидает новые обращения";

  return <section className="support-panel mb-5 space-y-3 p-5" aria-label="Управление локальным агентом">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 className="font-semibold text-slate-800">Локальный агент</h2>
        <p className="mt-1 text-sm text-slate-500">Готовит черновики на вашем ноутбуке по новым обращениям.</p>
      </div>
      <button type="button" role="switch" aria-checked={state.enabled} aria-label="Включить локального агента"
        aria-busy={saving} disabled={saving} onClick={toggle}
        className="flex items-center gap-3 rounded-xl px-2 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:opacity-60">
        {saving ? "Сохраняю…" : state.enabled ? "Включён" : "Выключен"}
        <span className={`relative h-7 w-12 rounded-full transition-colors duration-200 ${state.enabled ? "bg-blue-600" : "bg-slate-300"}`}>
          <span className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 motion-reduce:transition-none ${state.enabled ? "translate-x-5" : "translate-x-0"}`} />
        </span>
      </button>
    </div>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500" aria-live="polite">
      <span className="flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${state.online ? "bg-emerald-500" : "bg-slate-300"}`} />{status}</span>
      {state.model && <span>{state.model} · {state.reasoning}</span>}
      <span>Сегодня: {state.runsCount} / {state.dailyLimit}</span>
    </div>
    <p className="text-xs leading-relaxed text-slate-500">Выключение останавливает новые разборы; текущий завершится. Если ноутбук не на связи, включённый агент начнёт работу после подключения.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>;
}
