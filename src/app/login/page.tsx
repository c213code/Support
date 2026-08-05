"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AGENTS } from "@/lib/agents";
import { Avatar } from "@/components/Avatar";

export default function LoginPage() {
  const router = useRouter();
  const [agent, setAgent] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!agent) return;
    setLoading(true);
    setError(null);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, password }),
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
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-slate-50 to-indigo-50 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg ring-1 ring-slate-200/70">
        <h1 className="mb-1 text-xl font-semibold text-slate-900">
          Support Reports
        </h1>
        <p className="mb-6 text-sm text-slate-500">
          {agent ? `Пароль для ${agent}` : "Кто ты?"}
        </p>

        {!agent ? (
          <div className="grid grid-cols-2 gap-3">
            {AGENTS.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => {
                  setAgent(name);
                  setError(null);
                }}
                className="flex flex-col items-center gap-2 rounded-xl border border-slate-200 px-3 py-5 transition hover:border-indigo-300 hover:bg-indigo-50/50"
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
                setError(null);
              }}
              className="mb-1 flex items-center gap-2 rounded-lg px-1 py-1 text-xs text-slate-400 hover:text-slate-700"
            >
              ← сменить профиль
            </button>

            <div className="mb-3 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <Avatar name={agent} size="md" />
              <span className="text-sm font-medium text-slate-700">
                {agent}
              </span>
            </div>

            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Пароль"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            />

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading || !password}
              className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {loading ? "Входим..." : "Войти"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
