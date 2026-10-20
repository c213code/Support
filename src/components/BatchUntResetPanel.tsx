"use client";

import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { formatDateTimeAlmaty } from "@/lib/date";
import { normalizeKzPhone } from "@/lib/phone";
import { parseUntBatch, resolveBatchStudent, type BatchAccount, type BatchCandidate, type BatchStudent } from "@/lib/untBatch";

type Result = { resultId: string; fullName: string; studentEmail: string | null; combination: string | null; score: number; status: string; finishTime: string | null };
type Entry = { student: BatchStudent; phase: "idle" | "queued" | "searching" | "choose" | "ready" | "not_found" | "error";
  candidates: BatchCandidate[]; selected?: BatchAccount; rows: Result[]; message?: string };
const inputClass = "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm outline-none focus:border-brand-500 disabled:bg-slate-50";

async function jsonResponse(response: Response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  if (!data) throw new Error("Сервер вернул пустой ответ");
  return data;
}

export function BatchUntResetPanel({ test, product, text, onTextChange }: {
  test: { id: string; name: string }; product: string; text: string; onTextChange: (value: string) => void;
}) {
  const toast = useToast();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const readController = useRef<AbortController | null>(null);
  const resetLock = useRef(false);
  useEffect(() => () => readController.current?.abort(), []);
  const busy = searching || entries.some(e => e.phase === "searching");

  const patch = (id: string, values: Partial<Entry>) => setEntries(prev => prev.map(e => e.student.id === id ? { ...e, ...values } : e));
  function parse() {
    try {
      const parsed = parseUntBatch(text);
      readController.current?.abort();
      setEntries(parsed.students.map(student => ({ student, phase: "idle", candidates: [], rows: [] })));
      setWarnings(parsed.warnings);
      setDone(new Set()); setReviewed(new Set()); setConfirming(null);
    } catch (error) { toast(error instanceof Error ? error.message : "Не удалось разобрать список", "error"); }
  }

  const lookup = async (query: string, signal: AbortSignal): Promise<BatchAccount[]> => {
    const response = await fetch("/api/platform/students/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }), signal });
    const data = await jsonResponse(response);
    if (!Array.isArray(data.students)) throw new Error("Неожиданный ответ поиска учеников");
    return data.students;
  };

  async function loadResults(id: string, account: BatchAccount, signal: AbortSignal) {
    patch(id, { phase: "searching", selected: account, rows: [], message: undefined });
    const student = account.email || normalizeKzPhone(account.phoneNumber ?? "") || [account.lastname, account.firstname].filter(Boolean).join(" ");
    if (!student) throw new Error("У аккаунта нет данных для поиска результата");
    const params = new URLSearchParams({ untId: test.id, product, student });
    const data = await jsonResponse(await fetch(`/api/platform/unts/search?${params}`, { signal }));
    if (signal.aborted) return;
    if (!Array.isArray(data.results)) throw new Error("Неожиданный ответ поиска результатов");
    patch(id, { phase: "ready", rows: data.results, message: data.results.length ? undefined : "По выбранным тесту и продукту результата нет" });
  }

  async function searchAll() {
    if (busy || !entries.length || !product.trim()) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const { signal } = controller;
    const snapshot = entries.map(e => e.student);
    setSearching(true); setConfirming(null); setDone(new Set()); setReviewed(new Set());
    setEntries(prev => prev.map(e => ({ ...e, phase: "queued", rows: [], selected: undefined, candidates: [], message: undefined })));
    let next = 0;
    async function worker() {
      while (!signal.aborted && next < snapshot.length) {
        const student = snapshot[next++];
        patch(student.id, { phase: "searching" });
        try {
          const resolved = await resolveBatchStudent(student, query => lookup(query, signal));
          if (signal.aborted) return;
          if (resolved.status === "matched") await loadResults(student.id, resolved.candidates[0].account, signal);
          else patch(student.id, { phase: resolved.status, candidates: resolved.candidates, message: resolved.reason });
        } catch (error) {
          if (!signal.aborted) patch(student.id, { phase: "error", message: error instanceof Error ? error.message : "Поиск не удался" });
        }
      }
    }
    try { await Promise.all([worker(), worker()]); }
    finally { if (!signal.aborted) setSearching(false); }
  }

  async function choose(id: string, account: BatchAccount) {
    const controller = readController.current ?? new AbortController();
    readController.current = controller;
    try { await loadResults(id, account, controller.signal); }
    catch (error) { if (!controller.signal.aborted) patch(id, { phase: "error", message: error instanceof Error ? error.message : "Поиск не удался" }); }
  }

  function edit(entry: Entry, field: "name" | "emails" | "phones", value: string) {
    const parsed = field === "name" ? value : value.split(field === "emails" ? /[\s,;]+/ : /[,;]+/).map(v => v.trim()).filter(Boolean);
    patch(entry.student.id, { student: { ...entry.student, [field]: parsed }, phase: "idle", rows: [], selected: undefined, candidates: [], message: undefined });
    setConfirming(null); setReviewed(new Set());
  }

  async function reset(row: Result) {
    if (resetLock.current || done.has(row.resultId) || row.status !== "FINISHED" || !row.finishTime) return;
    resetLock.current = true; setResetting(row.resultId);
    try {
      const data = await jsonResponse(await fetch("/api/platform/unts/reset", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resultId: row.resultId, untId: test.id, untName: test.name }),
      }));
      setDone(prev => new Set(prev).add(row.resultId)); setConfirming(null);
      toast(`Результат обнулён у ${data.studentName || row.fullName}`, "success");
    } catch (error) { toast(error instanceof Error ? error.message : "Не удалось обнулить", "error"); }
    finally { resetLock.current = false; setResetting(null); }
  }

  const completed = entries.filter(e => !["queued", "searching", "idle"].includes(e.phase)).length;
  const found = entries.filter(e => e.phase === "ready" && e.rows.length > 0).length;
  const choices = entries.filter(e => e.phase === "choose").length;
  return (
    <div className="mt-4 space-y-4">
      <div>
        <label htmlFor="unt-batch-text" className="mb-1 block text-sm font-medium text-slate-800">Сообщения с учениками</label>
        <textarea id="unt-batch-text" value={text} onChange={e => onTextChange(e.target.value)} disabled={busy || Boolean(resetting)} rows={7}
          placeholder={"Вставьте всю пачку сообщений из Telegram:\nАты жөні: Оқушының аты-жөні\nПочта: student@example.com\nНомер: +7 777 123 45 67"} className={inputClass} />
        <p className="mt-1 text-xs text-slate-500">До 50 учеников. Имена, почты и телефоны могут идти в разном порядке. ДТ и БТ — один тест.</p>
        <button onClick={parse} disabled={!text.trim() || searching || Boolean(resetting)} className="mt-2 rounded-lg border border-brand-200 px-3 py-2 text-sm font-medium text-brand-700 disabled:opacity-40">Разобрать список</button>
      </div>
      {warnings.map(w => <p key={w} role="status" className="text-sm text-amber-700">{w}</p>)}
      {entries.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600">Учеников: {entries.length}{searching ? ` · Проверено ${completed}/${entries.length}` : completed ? ` · С результатами: ${found}${choices ? ` · Нужна сверка: ${choices}` : ""}` : " · Проверьте распознанные данные"}</p>
        <button onClick={searchAll} disabled={busy || !product.trim() || Boolean(resetting)} className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40">{searching ? "Ищем учеников…" : "Найти результаты всей пачки"}</button>
      </div>}
      {entries.map((entry, index) => <div key={entry.student.id} className="rounded-xl border border-slate-200 p-3">
        <div className="mb-2 flex justify-between gap-2"><p className="text-sm font-semibold">Ученик {index + 1}</p><button disabled={busy || Boolean(resetting)} onClick={() => setEntries(prev => prev.filter(e => e.student.id !== entry.student.id))} className="text-xs text-slate-400 hover:text-red-600 disabled:opacity-40">Убрать</button></div>
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-slate-500">Имя и фамилия<input aria-label={`Имя ученика ${index + 1}`} value={entry.student.name} onChange={e => edit(entry, "name", e.target.value)} disabled={busy || Boolean(resetting)} className={inputClass} /></label>
          <label className="text-xs text-slate-500">Почта<input aria-label={`Почта ученика ${index + 1}`} value={entry.student.emails.join(", ")} onChange={e => edit(entry, "emails", e.target.value)} disabled={busy || Boolean(resetting)} className={inputClass} /></label>
          <label className="text-xs text-slate-500">Телефон<input aria-label={`Телефон ученика ${index + 1}`} value={entry.student.phones.join(", ")} onChange={e => edit(entry, "phones", e.target.value)} disabled={busy || Boolean(resetting)} className={inputClass} /></label>
        </div>
        {entry.student.warnings.map(w => <p key={w} className="mt-2 text-xs text-amber-700">{w}</p>)}
        {["queued", "searching"].includes(entry.phase) && <p role="status" className="mt-3 text-sm text-brand-600">{entry.phase === "queued" ? "В очереди…" : "Проверяем ученика и результат…"}</p>}
        {entry.message && <p className={`mt-3 text-sm ${entry.phase === "error" ? "text-red-600" : entry.phase === "choose" ? "text-amber-700" : "text-slate-500"}`}>{entry.message}</p>}
        {entry.phase === "choose" && <div className="mt-2 space-y-2">{entry.candidates.map(({ account, matchedBy }) => <div key={account.id} className="rounded-lg border border-amber-200 bg-amber-50 p-2.5">
          <p className="text-sm font-medium">{account.lastname} {account.firstname}</p><p className="text-xs text-slate-600">{account.email || "Почты нет"} · {account.phoneNumber || "Номера нет"}</p><p className="mt-1 text-xs text-amber-700">Совпало: {matchedBy.join(", ")}</p>
          <button disabled={busy || Boolean(resetting)} onClick={() => choose(entry.student.id, account)} className="mt-2 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium">Выбрать этот аккаунт</button>
        </div>)}</div>}
        {entry.rows.map(row => {
          const finished = row.status === "FINISHED" && Boolean(row.finishTime);
          const needsReview = !entry.selected?.email || !row.studentEmail || row.studentEmail.toLowerCase() !== entry.selected.email.toLowerCase();
          const isDone = done.has(row.resultId);
          const rowKey = `${entry.student.id}:${row.resultId}`;
          const isConfirmed = confirming === rowKey;
          return <div key={row.resultId} className={`mt-3 rounded-lg border p-3 ${isDone ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-slate-50"}`}>
            <p className="text-sm font-medium">{row.fullName}{row.combination ? ` · ${row.combination}` : ""}</p>
            <p className="text-xs text-slate-500">{row.studentEmail || "Почта не получена"} · балл {row.score} · {finished ? "завершён" : row.status === "STARTED" ? "решает сейчас" : "не завершён / статус не проверен"}</p>
            {row.finishTime && <p className="text-xs text-slate-500">Завершил {formatDateTimeAlmaty(new Date(row.finishTime))}</p>}
            {isDone ? <p className="mt-2 text-sm font-medium text-emerald-700">Обнулено</p> : <>
              {needsReview && <label className="mt-2 flex items-start gap-2 text-xs text-amber-700"><input type="checkbox" checked={reviewed.has(rowKey)} onChange={e => { setConfirming(null); setReviewed(prev => { const next = new Set(prev); if (e.target.checked) next.add(rowKey); else next.delete(rowKey); return next; }); }} />Почта результата отличается или не подтверждена. Я сверил данные — это нужный ученик.</label>}
              {isConfirmed ? <div className="mt-3 flex flex-wrap items-center gap-2"><p className="text-xs text-red-700">Удалить результат {row.fullName} в тесте «{test.name}»? Действие необратимо.</p><button onClick={() => reset(row)} disabled={Boolean(resetting)} className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">{resetting === row.resultId ? "Обнуляем…" : "Да, обнулить"}</button><button onClick={() => setConfirming(null)} disabled={Boolean(resetting)} className="text-xs text-slate-500">Отмена</button></div>
                : <button onClick={() => setConfirming(`${entry.student.id}:${row.resultId}`)} disabled={!finished || (needsReview && !reviewed.has(rowKey)) || Boolean(resetting)} className="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-40">Обнулить результат</button>}
            </>}
          </div>;
        })}
      </div>)}
    </div>
  );
}
