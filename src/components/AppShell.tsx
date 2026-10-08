"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentAgent } from "@/lib/useCurrentAgent";
import { fetchApiJson } from "@/lib/fetchApiJson";
import { SUPPORT_UI_TOOLS } from "@/lib/supportUiTools";
import {
  IconReport,
  IconInbox,
  IconHistory,
  IconLogout,
  IconMail,
  IconSearch,
  IconDatabase,
  IconRefresh,
} from "@/components/Icons";

// Страницы, где смонтирована командная палитра (⌘K) — только там кнопка
// «Поиск» имеет смысл (ей нужны тикеты дня).
const PALETTE_ROUTES = new Set(["/", "/inbox"]);

// Общая навигация рабочего пространства.
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
  const [logsTool, setLogsTool] = useState(false);
  const currentAgent = useCurrentAgent();

  useEffect(() => {
    let cancelled = false;

    async function loadCount() {
      const result = await fetchApiJson<{ count?: number }>(
        "/api/telegram/messages?archived=false&count=true"
      );
      // Не загрузилось — оставляем прежний счётчик, следующий опрос повторит.
      if (cancelled || !result.ok) return;
      setInboxCount(result.data.count ?? 0);
    }
    // В фоновой вкладке не опрашиваем; при возврате обновляемся сразу.
    function refreshIfVisible() {
      if (document.hidden) return;
      loadCount();
    }

    loadCount();
    fetchApiJson<{ platformToolEnabled?: boolean; logsToolEnabled?: boolean }>(
      "/api/auth/me"
    ).then((result) => {
      if (cancelled || !result.ok) return;
      setPlatformTool(Boolean(result.data.platformToolEnabled));
      setLogsTool(Boolean(result.data.logsToolEnabled));
    });

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

  const navigation = [
    ...NAV,
    ...(SUPPORT_UI_TOOLS.changeContact && platformTool
      ? [{ href: "/platform/change-email", label: "Контакты ученика", Icon: IconMail }]
      : []),
    ...(platformTool
      ? [{ href: "/platform/reset-unt", label: "Обнуление ДТ", Icon: IconRefresh }]
      : []),
    ...(SUPPORT_UI_TOOLS.logs && logsTool
      ? [{ href: "/logs", label: "Логи", Icon: IconDatabase }]
      : []),
  ];

  return (
    <div className="support-shell min-h-screen">
      <a href="#main-content" className="support-skip-link">Перейти к содержимому</a>
      <header className="support-header">
        <Link href="/" aria-label="JUZ40 Support — главная" className="support-wordmark">
          JUZ40
          <span>SUPPORT</span>
        </Link>
        <span className="hidden text-sm text-slate-400 sm:block">Рабочее пространство поддержки</span>
        <div className="ml-auto flex min-w-0 items-center gap-3">
          <Link href="/inbox" className="support-inbox-link" aria-label={`Входящие${inboxCount ? `: ${inboxCount}` : ""}`} title="Входящие">
            <IconInbox className="h-5 w-5" />
            {!!inboxCount && <span className="support-notification-dot" />}
          </Link>
          {currentAgent && (
            <>
              <span className="hidden max-w-40 truncate text-sm font-medium text-slate-600 sm:block">{currentAgent}</span>
              <span title={currentAgent} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                {currentAgent.slice(0, 1).toUpperCase()}
              </span>
            </>
          )}
        </div>
      </header>

      <div className="support-workspace">
        <nav aria-label="Разделы" className="support-sidebar">
          <p className="support-nav-caption">Рабочее пространство</p>
          {navigation.map(({ href, label, Icon }) => (
            <Link key={href} href={href} title={label} aria-label={label}
              aria-current={pathname === href ? "page" : undefined}
              className="support-nav-link">
              <Icon className="h-5 w-5 shrink-0" />
              <span className="support-nav-label">{label}</span>
              {href === "/inbox" && !!inboxCount && (
                <span className="support-nav-count">{inboxCount > 99 ? "99+" : inboxCount}</span>
              )}
            </Link>
          ))}

          {SUPPORT_UI_TOOLS.sidebarSearch && PALETTE_ROUTES.has(pathname) && (
            <button
              onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
              title="Поиск по тикетам и командам (⌘K)" aria-label="Поиск по тикетам и командам"
              className="support-nav-link">
              <IconSearch className="h-5 w-5 shrink-0" />
              <span className="support-nav-label">Поиск</span>
            </button>
          )}
          <div className="support-sidebar-footer">
            <button onClick={handleLogout} title="Выйти" aria-label="Выйти" className="support-nav-link">
              <IconLogout className="h-5 w-5 shrink-0" />
              <span className="support-nav-label">Выйти</span>
            </button>
          </div>
        </nav>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
