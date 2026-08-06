"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AGENTS, SHARED_AGENT } from "@/lib/agents";
import { Avatar } from "@/components/Avatar";

export default function LoginPage() {
  const router = useRouter();
  const [agent, setAgent] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isShared = agent === SHARED_AGENT;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setLoading(true);
    setError(null);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, password, displayName }),
    });

    setLoading(false);

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error ?? "Не удалось войти");
      return;
    }

    router.replace("/");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-slate-50 to-accent-400/10 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl shadow-brand-900/5 ring-1 ring-slate-200/70">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-sm font-bold text-white">
            J40
          </span>
          <div>
            <h1 className="text-lg font-semibold leading-tight text-slate-900">
              JUZ40 Support
            </h1>
            <p className="text-xs text-slate-500">
              {agent ? `Вход — ${agent}` : "Кто ты?"}
            </p>
          </div>
        </div>

        {!agent ? (
          <div className="flex flex-wrap justify-center gap-3">
            {AGENTS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  setAgent(name);
                  setError(null);
                }}
                className="flex w-24 flex-col items-center gap-2 rounded-xl border border-slate-200 px-3 py-5 transition hover:border-brand-300 hover:bg-brand-50/60"
              >
                <Avatar name={name} size="lg" />
                <span className="text-sm font-medium text-slate-700">
                  {name}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <button
              type="button"
              onClick={() => {
                setAgent(null);
                setPassword("");
                setDisplayName("");
                setError(null);
              }}
              className="mb-1 flex items-center gap-2 rounded-lg px-1 py-1 text-xs text-slate-400 hover:text-slate-700"
            >
              ← сменить профиль
            </button>

            <div className="mb-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <Avatar name={displayName || agent} size="md" />
              <span className="text-sm font-medium text-slate-700">
                {displayName || agent}
              </span>
            </div>

            {isShared && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-500">
                  Твоё имя (будет в репорте: «Имя шешті»)
                </label>
                <input
                  type="text"
                  autoFocus
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Например: Тикош"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
                />
              </div>
            )}

            <input
              type="password"
              autoFocus={!isShared}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Пароль"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-100"
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading || !password || (isShared && !displayName.trim())}
              className="w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? "Входим..." : "Войти"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
