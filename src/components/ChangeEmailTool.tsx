"use client";

import { SupportPageHeader } from "@/components/SupportPageHeader";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { formatKzPhone, normalizeKzPhone } from "@/lib/phone";

type Student = {
  id: string;
  firstname: string | null;
  lastname: string | null;
  email: string | null;
  phoneNumber: string | null;
  googleMail: string | null;
};

// Что меняем: почту (она же логин) или номер. Путь на платформе один —
// /change целым профилем, — поэтому и инструмент один.
type Field = "email" | "phone";

type ChangeResult = { field: Field; studentName: string; from: string | null; to: string };

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
  const [field, setField] = useState<Field>("email");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<ChangeResult | null>(null);

  // Предзаполнение с карточки тикета: /platform/change-email?old=A&new=B
  // (почта) или ?field=phone&old=…&new=… (номер).
  // Читаем из window.location, а не useSearchParams — чтобы не тянуть Suspense
  // ради двух параметров. Старую почту кладём в поиск (ученик найдётся сам),
  // новую — в поле; ученика агент всё равно выбирает и подтверждает руками.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const o = p.get("old");
    const n = p.get("new");
    const phone = p.get("field") === "phone";
    if (!o && !n) return;
    // setState вне синхронного тела эффекта (как и другие эффекты здесь) —
    // синхронный setState линтер запрещает из-за каскадных рендеров.
    const t = setTimeout(() => {
      if (phone) setField("phone");
      if (n) {
        if (phone) setNewPhone(formatKzPhone(n, ""));
        else setNewEmail(n);
      }
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
    setNewPhone("");
    setConfirming(false);
    setDone(null);
    setQuery("");
    setResults([]);
  }

  const phoneTarget = normalizeKzPhone(newPhone);
  const target = field === "email" ? newEmail.trim() : phoneTarget ?? "";
  const targetValid = field === "email" ? EMAIL_RE.test(target) : Boolean(phoneTarget);
  const current = field === "email" ? selected?.email : selected?.phoneNumber;

  function chooseField(next: Field) {
    setField(next);
    setConfirming(false);
  }

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        field === "email"
          ? "/api/platform/students/change-email"
          : "/api/platform/students/change-phone",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            field === "email"
              ? { id: selected.id, newEmail: target }
              : { id: selected.id, newPhone: target }
          ),
        }
      );
      const data = await res.json().catch(() => null);
      const what = field === "email" ? "почту" : "номер";
      if (!res.ok) {
        toast(data?.error ?? `Не удалось сменить ${what} (HTTP ${res.status})`, "error");
        return;
      }
      if (!data?.result) {
        toast("Пустой ответ сервера — проверь вручную", "error");
        return;
      }
      const r = data.result;
      setDone(
        field === "email"
          ? { field, studentName: r.studentName, from: r.oldEmail, to: r.newEmail }
          : { field, studentName: r.studentName, from: r.oldPhone, to: r.newPhone }
      );
      setConfirming(false);
      toast(field === "email" ? "Почта изменена" : "Номер изменён", "success");
    } catch {
      toast("Сеть недоступна", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="support-page max-w-3xl">
      <SupportPageHeader title="Смена почты или номера ученику" description="Найдите ученика и обновите его контактные данные." />

      {/* Успех */}
      {done && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
          <p className="text-sm font-medium text-emerald-800">
            {done.field === "email" ? "Почта изменена" : "Номер изменён"} у{" "}
            {done.studentName || "ученика"}
          </p>
          <p className="mt-1 font-mono text-sm text-emerald-700">
            {done.from || "—"} → {done.to}
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
        <div className="support-surface">
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
        <div className="support-panel p-5 sm:p-6">
          <div className="mb-4">
            <p className="text-sm font-medium text-slate-900">
              {fullName(selected)}
            </p>
            <p className="font-mono text-xs text-slate-500">
              {selected.email ?? "без почты"} · {selected.phoneNumber ?? "без номера"}
            </p>
          </div>

          <div role="radiogroup" aria-label="Что меняем" className="mb-4 inline-flex rounded-lg bg-slate-100 p-0.5 text-sm">
            {(["email", "phone"] as const).map((f) => (
              <button
                key={f}
                role="radio"
                aria-checked={field === f}
                onClick={() => chooseField(f)}
                className={`rounded-md px-3 py-1 transition ${
                  field === f ? "bg-white font-medium text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {f === "email" ? "Почта" : "Номер"}
              </button>
            ))}
          </div>

          <label htmlFor="change-target" className="mb-1 block text-sm text-slate-600">
            {field === "email" ? "Новая почта" : "Новый номер"}
          </label>
          {field === "email" ? (
            <input
              id="change-target"
              value={newEmail}
              onChange={(e) => {
                setNewEmail(e.target.value);
                setConfirming(false);
              }}
              placeholder="student@juz40.kz"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
            />
          ) : (
            <input
              id="change-target"
              inputMode="tel"
              value={newPhone}
              onChange={(e) => {
                setNewPhone(formatKzPhone(e.target.value, newPhone));
                setConfirming(false);
              }}
              placeholder="+7 (775) 666 55 33"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm outline-none focus:border-brand-500"
            />
          )}

          {/* Предпросмотр A → B перед подтверждением */}
          {confirming && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm text-amber-800">Подтверди смену:</p>
              <p className="mt-1 font-mono text-sm text-amber-900">
                {current || "—"} → {target}
              </p>
            </div>
          )}

          <div className="mt-4 flex items-center gap-2">
            {!confirming ? (
              <button
                disabled={!targetValid || target === current}
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
