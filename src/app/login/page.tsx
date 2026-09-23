"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { resolveAgentLogin, SHARED_AGENT } from "@/lib/agents";
import { IconEye, IconEyeOff, IconLock, IconUser } from "@/components/Icons";

// Куда вернуться после входа (прокси кладёт сюда ?next=). Только путь на
// нашем же сайте: «//evil.com» и «https://…» браузер понял бы как чужой
// адрес, и страница входа стала бы открытым редиректом.
function safeNext(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/";
  }
  return next;
}

// Вход — обычная пара «логин и пароль», где логин — это имя агента.
//
// Раньше сначала выбирали аватар, потом вводили пароль. Это выглядело как
// витрина всех, у кого есть доступ, и ломало менеджеры паролей: поля логина
// не было, и сохранить пароль «к Ерошу» браузер не мог. Теперь логин
// набирается руками (регистр не важен, см. resolveAgentLogin), а имя общего
// аккаунта «Дежурный» открывает ещё одно поле — своё имя, которое уйдёт
// автором в репорт.
//
// «Забыли пароль?» намеренно нет: пароли живут в переменных окружения, и
// сбросить их со страницы нечем — ссылка вела бы в никуда.
export default function LoginPage() {
  const router = useRouter();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isShared = resolveAgentLogin(login) === SHARED_AGENT;
  const canSubmit =
    !loading && login.trim() !== "" && password !== "" && (!isShared || displayName.trim() !== "");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent: login,
        password,
        displayName: isShared ? displayName : undefined,
      }),
    });

    setLoading(false);

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "Не удалось войти");
      return;
    }

    router.replace(safeNext());
    router.refresh();
  }

  const inputClass =
    "w-full rounded-xl border border-slate-300 bg-white py-3 pl-11 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-brand-400 focus:ring-4 focus:ring-brand-100";

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-brand-50 via-slate-50 to-accent-400/10">
      <header className="flex items-center gap-2.5 px-6 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white">
          J40
        </span>
        <span className="text-sm font-semibold text-slate-800">JUZ40 Support</span>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-8">
        <form
          onSubmit={handleSubmit}
          className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl shadow-brand-900/5 ring-1 ring-slate-200/70"
        >
          <h1 className="text-2xl font-bold text-slate-900">Вход</h1>
          <p className="mt-1 text-sm text-slate-500">Введите логин и пароль</p>

          <div className="mt-6 space-y-4">
            <div>
              <label htmlFor="login" className="mb-1.5 block text-sm font-medium text-slate-700">
                Логин
              </label>
              <div className="relative">
                <IconUser className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="login"
                  name="username"
                  type="text"
                  autoComplete="username"
                  autoFocus
                  value={login}
                  onChange={(e) => {
                    setLogin(e.target.value);
                    setError(null);
                  }}
                  placeholder="Ваше имя, например Ерош"
                  className={inputClass}
                />
              </div>
            </div>

            {isShared && (
              <div>
                <label
                  htmlFor="display-name"
                  className="mb-1.5 block text-sm font-medium text-slate-700"
                >
                  Как вас зовут
                </label>
                <div className="relative">
                  <IconUser className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="display-name"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Например: Тикош"
                    className={inputClass}
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  Общий аккаунт: это имя будет автором в репорте («Тикош шешті»)
                </p>
              </div>
            )}

            <div>
              <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-slate-700">
                Пароль
              </label>
              <div className="relative">
                <IconLock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError(null);
                  }}
                  className={`${inputClass} pr-11`}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
                >
                  {showPassword ? <IconEyeOff /> : <IconEye />}
                </button>
              </div>
            </div>
          </div>

          {error && (
            <p role="alert" className="mt-4 text-sm text-red-600">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-6 w-full rounded-xl bg-brand-600 px-3 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Входим…" : "Войти"}
          </button>
        </form>
      </main>

      <footer className="border-t border-slate-200/70 px-6 py-4 text-center text-xs text-slate-400">
        JUZ40 Support · вход только для дежурных
      </footer>
    </div>
  );
}
