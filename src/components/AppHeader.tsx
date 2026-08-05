"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { useCurrentAgent } from "@/lib/useCurrentAgent";

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const currentAgent = useCurrentAgent();

  useEffect(() => {
    let cancelled = false;

    async function loadCount() {
      const res = await fetch("/api/telegram/messages?archived=false");
      if (cancelled) return;
      const data = await res.json();
      setInboxCount(data.messages?.length ?? 0);
    }

    loadCount();
    const interval = setInterval(loadCount, 20000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur sm:px-6">
      <div className="flex items-center gap-4">
        <span className="font-semibold text-slate-900">
          Support Reports
        </span>
        <nav className="flex gap-1 text-sm">
          <Link
            href="/"
            className={`rounded-md px-3 py-1.5 transition ${
              pathname === "/"
                ? "bg-indigo-600 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Сегодня
          </Link>
          <Link
            href="/inbox"
            className={`relative rounded-md px-3 py-1.5 transition ${
              pathname === "/inbox"
                ? "bg-indigo-600 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            Входящие
            {!!inboxCount && (
              <span className="ml-1.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {inboxCount}
              </span>
            )}
          </Link>
          <Link
            href="/history"
            className={`rounded-md px-3 py-1.5 transition ${
              pathname === "/history"
                ? "bg-indigo-600 text-white"
                : "text-slate-600 hover:bg-slate-100"
            }`}
          >
            История
          </Link>
        </nav>
      </div>
      <div className="flex items-center gap-3">
        {currentAgent && (
          <div className="flex items-center gap-1.5">
            <Avatar name={currentAgent} size="sm" />
            <span className="hidden text-sm text-slate-600 sm:inline">
              {currentAgent}
            </span>
          </div>
        )}
        <button
          onClick={handleLogout}
          className="text-sm text-slate-500 hover:text-slate-800"
        >
          Выйти
        </button>
      </div>
    </header>
  );
}
