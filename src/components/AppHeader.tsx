"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Avatar } from "@/components/Avatar";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import {
  IconReport,
  IconInbox,
  IconHistory,
  IconLogout,
  IconMail,
} from "@/components/Icons";

const NAV = [
  { href: "/", label: "Сегодня", Icon: IconReport },
  { href: "/inbox", label: "Входящие", Icon: IconInbox },
  { href: "/history", label: "История", Icon: IconHistory },
] as const;

// Страницы, на которых смонтирована CommandPalette (ей нужен список
// тикетов за день, которого на "Истории" просто нет).
const PALETTE_ROUTES = new Set(["/", "/inbox"]);

export function AppHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  // Ссылка на инструмент смены почты появляется в меню, только когда он
  // настроен на сервере (заданы PLATFORM_* env) — иначе вела бы на страницу
  // «не настроено».
  const [platformTool, setPlatformTool] = useState(false);
  const currentAgent = useCurrentAgent();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setPlatformTool(Boolean(data.platformToolEnabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadCount() {
      const res = await fetch("/api/telegram/messages?archived=false&count=true");
      if (cancelled) return;
      const data = await res.json();
      setInboxCount(data.count ?? 0);
    }

    // Шапка висит на всех страницах, поэтому опрос тут дороже всего:
    // в фоновой вкладке его глушим, при возврате — обновляем сразу.
    function refreshIfVisible() {
      if (document.hidden) return;
      loadCount();
    }

    loadCount();
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

  return (
    <header className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white/85 px-4 py-2.5 backdrop-blur sm:px-6">
      <div className="flex items-center gap-3 sm:gap-5">
        <span className="flex items-center gap-2 font-semibold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-[11px] font-bold text-white">
            J40
          </span>
          <span className="hidden sm:inline">Support</span>
        </span>
        <nav className="flex gap-1 text-sm">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition sm:px-3 ${
                  active
                    ? "bg-brand-600 text-white"
                    : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{label}</span>
                {href === "/inbox" && !!inboxCount && (
                  <span className="ml-0.5 rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    {inboxCount}
                  </span>
                )}
              </Link>
            );
          })}
          {platformTool && (
            <Link
              href="/platform/change-email"
              className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition sm:px-3 ${
                pathname === "/platform/change-email"
                  ? "bg-brand-600 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <IconMail className="h-4 w-4" />
              <span className="hidden sm:inline">Почта</span>
            </Link>
          )}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        {/* Подсказка про ⌘K — единственное место, где о палитре вообще
            можно узнать, не зная о ней заранее. Кликабельна: мышкой
            дотянуться быстрее, чем вспоминать сочетание. Показываем только
            там, где палитра действительно смонтирована (ей нужны тикеты
            дня) — на "Истории" кнопка была бы мёртвой. */}
        {PALETTE_ROUTES.has(pathname) && (
          <button
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true })
              )
            }
            title="Поиск по тикетам и командам"
            className="hidden items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-400 transition hover:border-slate-300 hover:text-slate-600 md:flex"
          >
            Поиск
            <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-px text-[10px] font-medium">
              ⌘K
            </kbd>
          </button>
        )}
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
          title="Выйти"
          className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
        >
          <IconLogout className="h-4 w-4" />
          <span className="hidden sm:inline">Выйти</span>
        </button>
      </div>
    </header>
  );
}
