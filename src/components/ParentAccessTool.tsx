"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SupportPageHeader } from "./SupportPageHeader";
import { useToast } from "./Toast";
import { parentReply, type ParentCredentials, type ParentLookup } from "@/lib/parentAccess";

export function ParentAccessTool({ initialBotEnabled = false, botReady = false }: { initialBotEnabled?: boolean; botReady?: boolean }) {
  const toast = useToast();
  const [botEnabled, setBotEnabled] = useState(initialBotEnabled);
  const [botSaving, setBotSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [lookups, setLookups] = useState<ParentLookup[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ParentCredentials>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const searchBusy = useRef(false);
  const actionBusy = useRef(false);
  const attempted = useRef(new Set<string>());
  const operationIds = useRef(new Map<string, string>());

  const search = useCallback(async (input: { query?: string; issueId?: string }) => {
    if (searchBusy.current || actionBusy.current) return;
    searchBusy.current = true;
    setSearching(true); setError(null); setLookups([]); setResults({}); setFailures({});
    attempted.current.clear(); operationIds.current.clear();
    try {
      const response = await fetch("/api/platform/parents/search", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), cache: "no-store",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.lookups)) throw new Error(body?.error || "Не удалось найти аккаунты");
      setLookups(body.lookups);
    } catch (err) { setError(err instanceof Error ? err.message : "Нет связи с сервером"); }
    finally { searchBusy.current = false; setSearching(false); }
  }, []);

  useEffect(() => {
    const issueId = new URLSearchParams(window.location.search).get("issue");
    if (!issueId) return;
    const timer = setTimeout(() => { void search({ issueId }); }, 0);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const forgetCredentials = () => { setResults({}); };
    window.addEventListener("pagehide", forgetCredentials);
    return () => window.removeEventListener("pagehide", forgetCredentials);
  }, []);

  const parents = useMemo(() => {
    const all = new Map<string, ParentLookup["parents"][number] & { queries: string[] }>();
    for (const lookup of lookups) for (const parent of lookup.parents) {
      const previous = all.get(parent.id);
      all.set(parent.id, { ...parent,
        matchedStudentIds: [...new Set([...(previous?.matchedStudentIds ?? []), ...parent.matchedStudentIds])],
        queries: [...new Set([...(previous?.queries ?? []), lookup.query])] });
    }
    return [...all.values()];
  }, [lookups]);

  async function reset(parent: (typeof parents)[number]) {
    if (actionBusy.current || searchBusy.current || attempted.current.has(parent.id)) return;
    actionBusy.current = true; attempted.current.add(parent.id); setBusyId(parent.id);
    const requestId = operationIds.current.get(parent.id) ?? crypto.randomUUID();
    operationIds.current.set(parent.id, requestId);
    try {
      const response = await fetch("/api/platform/parents/reset", { method: "POST", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({
          parentId: parent.id, expectedLogin: parent.login, expectedPhone: parent.phoneNumber,
          studentIds: parent.matchedStudentIds, requestId,
        }) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.result) throw new Error(body?.error || "Результат операции неизвестен. Проверьте платформу перед повтором.");
      setResults((previous) => ({ ...previous, [parent.id]: body.result }));
    } catch (err) {
      setFailures((previous) => ({ ...previous, [parent.id]: err instanceof Error ? err.message :
        "Связь прервалась. Операция могла выполниться — проверьте платформу перед повтором." }));
    } finally { actionBusy.current = false; setBusyId(null); }
  }

  async function copy(result: ParentCredentials) {
    try { await navigator.clipboard.writeText(parentReply(result)); toast("Ответ скопирован", "success"); }
    catch { toast("Не удалось скопировать. Выделите текст ответа вручную.", "error"); }
  }

  async function toggleBot() {
    if (botSaving) return;
    setBotSaving(true);
    try {
      const response = await fetch("/api/platform/parents/bot", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !botEnabled }) });
      const body = await response.json();
      if (!response.ok) throw Error(body?.error || "Не удалось изменить настройку");
      setBotEnabled(body.enabled);
      toast(body.enabled ? "Бот будет предлагать помощь в личке дежурного" : "Новые предложения выключены", "success");
    } catch (error) { toast(error instanceof Error ? error.message : "Нет связи с сервером", "error"); }
    finally { setBotSaving(false); }
  }

  return <div className="support-page max-w-4xl">
    <SupportPageHeader title="Доступ родителя"
      description="Поиск по номеру или почте родителя и ученика. Логин и пароль — после выбора нужного аккаунта." />
    <section className="support-panel mb-5 flex items-center justify-between gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Помощь родителям через Telegram</h2>
        <p className="mt-1 text-sm text-slate-500">Бот распознаёт запрос, находит аккаунты и спрашивает дежурного в личке.
          После подтверждения отправляет логин и пароль ответом в рабочем чате.</p>
        <p className="mt-2 text-xs text-slate-500">{botReady ? "Работает через Groq, независимо от ноутбука и обычных автоответов." : "Нужно настроить Groq, Telegram и сервис-аккаунт платформы."}</p>
      </div>
      <button type="button" role="switch" aria-checked={botEnabled} aria-label="Помощь родителям через Telegram"
        disabled={botSaving || !botReady && !botEnabled} onClick={() => void toggleBot()}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${botEnabled ? "bg-brand-600" : "bg-slate-300"}`}>
        <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${botEnabled ? "left-1 translate-x-5" : "left-1"}`} />
      </button>
    </section>
    <form onSubmit={(event) => { event.preventDefault(); void search({ query }); }} className="support-panel mb-5 space-y-3 p-5">
      <label htmlFor="parent-access-query" className="block text-sm font-semibold text-slate-800">Контакт или список из обращения</label>
      <textarea id="parent-access-query" value={query} onChange={(event) => setQuery(event.target.value)}
        disabled={searching || busyId !== null} maxLength={6000} rows={4}
        placeholder="Номер/почта родителя или ученика. Можно вставить сразу несколько строк с именами и номерами."
        className="w-full rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100 disabled:opacity-60" />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">До 10 контактов. По одному ФИО аккаунт нужно выбрать из результатов.</p>
        <button disabled={searching || busyId !== null || query.trim().length < 3} type="submit"
          className="rounded-xl bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-50">
          {searching ? "Ищу аккаунты…" : "Найти родителя"}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </form>
    <p className="mb-4 text-sm leading-relaxed text-slate-500">Кнопка создаёт новый пароль и отправляет его родителю через платформу.
      Повторный вызов может вернуть пароль из кэша. Данные для входа доступны в этом окне до нового поиска или закрытия страницы.</p>
    {lookups.map((lookup) => lookup.notes.length > 0 && <div key={lookup.query} className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
      <p className="mb-1 font-medium">{lookup.query}</p>
      {lookup.notes.map((note) => <p key={note}>{note}</p>)}
    </div>)}
    <div className="space-y-4" aria-live="polite">
      {parents.map((parent) => {
        const result = results[parent.id];
        return <section key={parent.id} className="support-panel space-y-4 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-brand-600">Родитель · совпадения: {parent.queries.join(", ")}</p>
              <h2 className="mt-1 font-semibold text-slate-800">{parent.name}</h2>
              <p className="mt-1 break-all text-sm text-slate-600">{parent.login}{parent.phoneNumber && ` · ${parent.phoneNumber}`}</p>
            </div>
            {!result && <button type="button" onClick={() => void reset(parent)}
              disabled={busyId !== null || searching || Boolean(failures[parent.id])}
              className="rounded-xl border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-700 transition hover:bg-brand-100 disabled:opacity-50">
              {busyId === parent.id ? "Запрашиваю…" : "Сбросить пароль и отправить родителю"}
            </button>}
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <h3 className="mb-2 text-xs font-semibold text-slate-500">Связанные ученики</h3>
            {parent.students.length ? parent.students.map((student) => <p key={student.id} className="mb-1 text-sm text-slate-700">
              <span className="font-medium">{student.name}</span> · {student.login || "без почты"}{student.phoneNumber && ` · ${student.phoneNumber}`}
              {parent.matchedStudentIds.includes(student.id) && <span className="ml-2 text-xs text-brand-600">найден по обращению</span>}
            </p>) : <p className="text-sm text-slate-500">Связанных учеников нет. Проверьте, тот ли это аккаунт.</p>}
          </div>
          {failures[parent.id] && <p role="alert" className="text-sm text-red-700">{failures[parent.id]} Чтобы выбрать аккаунт заново, выполните новый поиск.</p>}
          {result && <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
            <p className="text-sm font-medium text-emerald-800">{result.message}</p>
            <label htmlFor={`parent-reply-${parent.id}`} className="block text-xs font-semibold text-slate-600">Ответ для родителя · қазақша</label>
            <textarea id={`parent-reply-${parent.id}`} readOnly rows={result.phoneNumber ? 4 : 3} value={parentReply(result)}
              className="w-full rounded-lg border border-emerald-200 bg-white p-3 font-mono text-sm text-slate-800" />
            <button type="button" onClick={() => void copy(result)} className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-800">Скопировать ответ</button>
          </div>}
        </section>;
      })}
    </div>
  </div>;
}
