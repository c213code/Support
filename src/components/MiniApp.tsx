"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { SubmissionForm } from "@/components/SubmissionForm";
import { MySubmissions } from "@/components/MySubmissions";
import { haptic, type MiniAppEnv } from "@/lib/miniappClient";
import styles from "./SubmissionForm.module.css";

export type MiniAppTab = "new" | "mine";

// Сколько ждать скрипт Telegram, прежде чем признать, что он не загрузился.
const SCRIPT_TIMEOUT_MS = 10_000;

// Оболочка мини-аппа: скрипт Telegram и две вкладки — «Жаңа өтініш» (форма)
// и «Менің өтініштерім» (статус своих обращений).
//
// Обе вкладки остаются смонтированными, скрыта лишь неактивная: куратор
// посмотрел статус и вернулся — начатая форма с фото на месте (фото в
// черновик localStorage не попадают и при размонтировании пропали бы).
export function MiniApp({ initialTab }: { initialTab: MiniAppTab }) {
  const [env, setEnv] = useState<MiniAppEnv>("loading");
  const [tab, setTab] = useState<MiniAppTab>(initialTab);

  function onTelegramReady() {
    const app = window.Telegram?.WebApp;
    if (!app?.initData) {
      setEnv("browser");
      return;
    }
    app.ready();
    app.expand();
    if (app.isVersionAtLeast("6.1")) {
      // Шапка и фон вокруг страницы — того же цвета, что страница: без
      // полосы другого цвета над формой.
      app.setHeaderColor("secondary_bg_color");
      app.setBackgroundColor("secondary_bg_color");
    }
    // Иначе свайп вниз при прокрутке длинной формы закрывает мини-апп.
    if (app.isVersionAtLeast("7.7")) app.disableVerticalSwipes();
    setEnv("telegram");
  }

  // Скрипт может зависнуть так, что не сработает ни onReady, ни onError, —
  // тогда не было бы ни MainButton, ни кнопки на странице.
  useEffect(() => {
    const t = setTimeout(
      () => setEnv((current) => (current === "loading" ? "script-failed" : current)),
      SCRIPT_TIMEOUT_MS
    );
    return () => clearTimeout(t);
  }, []);

  function switchTab(next: MiniAppTab) {
    if (next === tab) return;
    haptic("select");
    setTab(next);
    window.scrollTo({ top: 0 });
  }

  return (
    <main className={styles.root} lang="kk">
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        onReady={onTelegramReady}
        onError={() => setEnv("script-failed")}
      />

      <div className={styles.tabs} role="tablist" aria-label="Бөлімдер">
        <button
          type="button"
          role="tab"
          id="tab-new"
          aria-controls="panel-new"
          aria-selected={tab === "new"}
          className={styles.tab}
          onClick={() => switchTab("new")}
        >
          Жаңа өтініш
        </button>
        <button
          type="button"
          role="tab"
          id="tab-mine"
          aria-controls="panel-mine"
          aria-selected={tab === "mine"}
          className={styles.tab}
          onClick={() => switchTab("mine")}
        >
          Менің өтініштерім
        </button>
      </div>

      <div role="tabpanel" id="panel-new" aria-labelledby="tab-new" hidden={tab !== "new"}>
        <SubmissionForm env={env} active={tab === "new"} onShowMine={() => switchTab("mine")} />
      </div>
      <div role="tabpanel" id="panel-mine" aria-labelledby="tab-mine" hidden={tab !== "mine"}>
        <MySubmissions env={env} active={tab === "mine"} onNew={() => switchTab("new")} />
      </div>
    </main>
  );
}
