"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import {
  IconReport,
  IconInbox,
  IconHistory,
  IconLogout,
  IconMail,
} from "@/components/Icons";

// Тёмная бренд-панель слева — «спина» приложения (раньше была светлая шапка
// сверху, AppHeader). Держит ту же навигацию, счётчик «Входящих», текущего
// агента и выход, просто вертикально. Оборачивает контент любой страницы:
// <AppShell><Страница/></AppShell>.
const NAV = [
  { href: "/", label: "Сегодня", Icon: IconReport },
  { href: "/inbox", label: "Входящие", Icon: IconInbox },
  { href: "/history", label: "История", Icon: IconHistory },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const [platformTool, setPlatformTool] = useState(false);
  const currentAgent = useCurrentAgent();

  useEffect(() => {
    let cancelled = false;

    async function loadCount() {
      const res = await fetch("/api/telegram/messages?archived=false&count=true");
      if (cancelled) return;
      const data = await res.json();
      setInboxCount(data.count ?? 0);
    }
    // В фоновой вкладке не опрашиваем; при возврате обновляемся сразу.
    function refreshIfVisible() {
      if (document.hidden) return;
      loadCount();
    }

    loadCount();
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setPlatformTool(Boolean(data.platformToolEnabled));
      })
      .catch(() => {});

    const interval = setInterval(refreshIfVisible, 20000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const linkClass = (active: boolean) =>
    `relative flex h-11 w-11 items-center justify-center rounded-xl transition ${
      active
        ? "bg-white/12 text-white"
        : "text-slate-400 hover:bg-white/8 hover:text-slate-100"
    }`;

  return (
    <div className="flex min-h-screen">
      <nav
        aria-label="Разделы"
        className="sticky top-0 z-20 flex h-screen w-[64px] shrink-0 flex-col items-center gap-1 bg-[#0b1f45] py-3.5"
      >
        <Link
          href="/"
          className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-[11px] font-extrabold tracking-tight text-white shadow-lg shadow-brand-600/40"
          title="JUZ40 Support"
        >
          J40
        </Link>

        {NAV.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              title={label}
              aria-label={label}
              className={linkClass(active)}
            >
              {active && (
                <span className="absolute -left-3.5 top-2.5 bottom-2.5 w-[3px] rounded-r bg-brand-500" />
              )}
              <Icon className="h-[19px] w-[19px]" />
              {href === "/inbox" && !!inboxCount && (
                <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full border-2 border-[#0b1f45] bg-amber-400 px-1 text-[10px] font-bold text-amber-950">
                  {inboxCount}
                </span>
              )}
            </Link>
          );
        })}

        {platformTool && (
          <Link
            href="/platform/change-email"
            title="Смена почты ученику"
            aria-label="Смена почты ученику"
            className={linkClass(pathname === "/platform/change-email")}
          >
            {pathname === "/platform/change-email" && (
              <span className="absolute -left-3.5 top-2.5 bottom-2.5 w-[3px] rounded-r bg-brand-500" />
            )}
            <IconMail className="h-[19px] w-[19px]" />
          </Link>
        )}

        <div className="flex-1" />

        {currentAgent && (
          <span
            title={currentAgent}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/10 text-sm font-semibold text-slate-100"
          >
            {currentAgent.slice(0, 1).toUpperCase()}
          </span>
        )}
        <button
          onClick={handleLogout}
          title="Выйти"
          aria-label="Выйти"
          className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-400 transition hover:bg-white/8 hover:text-slate-100"
        >
          <IconLogout className="h-[18px] w-[18px]" />
        </button>
      </nav>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
