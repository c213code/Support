"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";

type Student = {
  id: string;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
  phoneNumber: string | null;
  googleMail: string | null;
};

type ChangeResult = {
  studentName: string;
  oldEmail: string | null;
  newEmail: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fullName(s: Student): string {
  return [s.firstname, s.lastname].filter(Boolean).join(" ").trim() || "—";
}

export function ChangeEmailTool() {
  const toast = useToast();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Student[]>([]);
  const [searching, setSearching] = useState(false);

  const [selected, setSelected] = useState<Student | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<ChangeResult | null>(null);

  // Предзаполнение с карточки тикета: /platform/change-email?old=A&new=B.
  // Читаем из window.location, а не useSearchParams — чтобы не тянуть Suspense
  // ради двух параметров. Старую почту кладём в поиск (ученик найдётся сам),
  // новую — в поле; ученика агент всё равно выбирает и подтверждает руками.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const o = p.get("old");
    const n = p.get("new");
    if (!o && !n) return;
    // setState вне синхронного тела эффекта (как и другие эффекты здесь) —
    // синхронный setState линтер запрещает из-за каскадных рендеров.
    const t = setTimeout(() => {
      if (n) setNewEmail(n);
      if (o) setQuery(o);
    }, 0);
    return () => clearTimeout(t);
  }, []);

  // Дебаунс-поиск: пока ученик не выбран и запрос ≥3 символов. Все setState
  // — внутри отложенного колбэка (не синхронно в теле эффекта), иначе линтер
  // ругается на каскадные рендеры. Показ результатов и так огорожен теми же
  // условиями (см. рендер), поэтому чистить их синхронно тут не нужно.
  useEffect(() => {
    const q = query.trim();
    if (selected || q.length < 3) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch("/api/platform/students/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          toast(data?.error ?? `Ошибка поиска (HTTP ${res.status})`, "error");
          setResults([]);
        } else {
          setResults(data?.students ?? []);
        }
      } catch {
        if (!cancelled) toast("Сеть недоступна", "error");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, selected, toast]);

  function reset() {
    setSelected(null);
    setNewEmail("");
    setConfirming(false);
    setDone(null);
    setQuery("");
    setResults([]);
  }

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/platform/students/change-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, newEmail: newEmail.trim() }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast(data?.error ?? `Не удалось сменить почту (HTTP ${res.status})`, "error");
        return;
      }
      if (!data?.result) {
        toast("Пустой ответ сервера — проверь вручную", "error");
        return;
      }
      setDone(data.result);
      setConfirming(false);
      toast("Почта изменена", "success");
    } catch {
      toast("Сеть недоступна", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="mb-1 text-lg font-semibold text-slate-900">
        Смена почты ученику
      </h1>
      <p className="mb-6 text-sm text-slate-500">
        Основная платформа JUZ40. Меняются вместе почта и логин ученика.
      </p>

      {/* Успех */}
      {done && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="text-sm font-medium text-emerald-800">
            Почта изменена у {done.studentName || "ученика"}
          </p>
          <p className="mt-1 font-mono text-sm text-emerald-700">
            {done.oldEmail ?? "—"} → {done.newEmail}
          </p>
          <button
            onClick={reset}
            className="mt-4 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            Сменить ещё одному
          </button>
        </div>
      )}

      {/* Поиск + выбор */}
      {!done && !selected && (
        <div>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Почта, имя или телефон ученика…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          <div className="mt-3 space-y-2">
            {searching && (
              <p className="text-sm text-slate-400">Ищем…</p>
            )}
            {!searching && query.trim().length >= 3 && results.length === 0 && (
              <p className="text-sm text-slate-400">Никого не нашли</p>
            )}
            {results.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelected(s)}
                className="flex w-full flex-col items-start rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:border-brand-400 hover:bg-slate-50"
              >
                <span className="text-sm font-medium text-slate-900">
                  {fullName(s)}
                </span>
                <span className="font-mono text-xs text-slate-500">
                  {s.email ?? "без почты"}
                  {s.phoneNumber ? ` · ${s.phoneNumber}` : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Выбран ученик: ввод новой почты + подтверждение */}
      {!done && selected && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4">
            <p className="text-sm font-medium text-slate-900">
              {fullName(selected)}
            </p>
            <p className="font-mono text-xs text-slate-500">
              Текущая: {selected.email ?? "—"}
            </p>
          </div>

          <label className="mb-1 block text-sm text-slate-600">
            Новая почта
          </label>
          <input
            value={newEmail}
            onChange={(e) => {
              setNewEmail(e.target.value);
              setConfirming(false);
            }}
            placeholder="student@juz40.kz"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />

          {/* Предпросмотр A → B перед подтверждением */}
          {confirming && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-800">Подтверди смену:</p>
              <p className="mt-1 font-mono text-sm text-amber-900">
                {selected.email ?? "—"} → {newEmail.trim()}
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            {!confirming ? (
              <button
                disabled={!EMAIL_RE.test(newEmail.trim())}
                onClick={() => setConfirming(true)}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
              >
                Продолжить
              </button>
            ) : (
              <button
                disabled={submitting}
                onClick={submit}
                className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
              >
                {submitting ? "Меняем…" : "Подтвердить смену"}
              </button>
            )}
            <button
              onClick={reset}
              className="rounded-lg px-3 py-1.5 text-sm text-slate-500 hover:text-slate-800"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
