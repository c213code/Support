// Общее для экранов мини-аппа (форма обращения и «Менің өтініштерім»):
// доступ к Telegram WebApp API, подпись для сервера и вибрация.
//
import type { IssueStatus } from "@/lib/status";

// Обращение куратора в списке «Менің өтініштерім» — ответ POST /api/miniapp/mine.
export type MySubmission = {
  id: string;
  createdAt: string;
  text: string;
  groupName: string;
  groupEmoji: string | null;
  status: IssueStatus;
  // Заметка дежурного — только у решённых: там в ней ответ куратору, а на
  // промежуточных статусах лежит рабочая пометка для себя.
  note: string | null;
  history: Array<{ status: IssueStatus; at: string }>;
  photoCount: number;
};

// Минимум Telegram WebApp API, которым пользуется мини-апп
// (core.telegram.org/bots/webapps). Версии — в isVersionAtLeast: старые
// клиенты Telegram части методов не знают.

export type BottomButton = {
  setParams: (params: { text?: string; is_active?: boolean; is_visible?: boolean }) => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  hide: () => void;
  onClick: (callback: () => void) => void;
  offClick: (callback: () => void) => void;
};

export type TelegramWebApp = {
  initData: string;
  ready: () => void;
  expand: () => void;
  close: () => void;
  isVersionAtLeast: (version: string) => boolean;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  disableVerticalSwipes: () => void;
  HapticFeedback: {
    selectionChanged: () => void;
    impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
  };
  MainButton: BottomButton;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

// loading — скрипт Telegram ещё грузится; telegram — открыто из Telegram;
// browser — скрипт есть, а подписи нет: открыто не из Telegram;
// script-failed — скрипт не загрузился (бывает и внутри Telegram).
export type MiniAppEnv = "loading" | "telegram" | "browser" | "script-failed";

// Мини-апп открыт из Telegram, только если есть подписанная initData: сам
// скрипт telegram-web-app.js создаёт WebApp и в обычном браузере.
export function telegramApp(): TelegramWebApp | null {
  const app = window.Telegram?.WebApp;
  return app?.initData ? app : null;
}

// Подпись Telegram для сервера. Основной источник — скрипт Telegram; если он
// не загрузился, Telegram всё равно передаёт те же данные в адресе страницы
// (#tgWebAppData=…) — с ними запросы работают и без скрипта.
export function currentInitData(): string {
  const fromScript = window.Telegram?.WebApp?.initData;
  if (fromScript) return fromScript;
  return new URLSearchParams(window.location.hash.slice(1)).get("tgWebAppData") ?? "";
}

export function haptic(kind: "select" | "tap" | "success" | "warning" | "error") {
  const app = telegramApp();
  if (!app?.isVersionAtLeast("6.1")) return;
  if (kind === "select") app.HapticFeedback.selectionChanged();
  else if (kind === "tap") app.HapticFeedback.impactOccurred("light");
  else app.HapticFeedback.notificationOccurred(kind);
}
