"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";

// Рубильник «сброс БТ/ДТ из Telegram» на странице обнуления. Сама логика —
// src/lib/untResetBot.ts; здесь только включить/выключить.
export function UntResetBotToggle() {
  const toast = useToast();
  const [state, setState] = useState<{ enabled: boolean; ready: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/unts/bot")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data) setState({ enabled: Boolean(data.enabled), ready: Boolean(data.ready) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle() {
    if (!state || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/platform/unts/bot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !state.enabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast(data?.error ?? `Не удалось переключить (HTTP ${res.status})`, "error");
        return;
      }
      setState({ ...state, enabled: Boolean(data.enabled) });
    } catch (err) {
      toast(`Сеть недоступна: ${String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  if (!state) return null;
  return (
    <section className="support-panel mb-5 flex items-center justify-between gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Сброс БТ/ДТ из Telegram</h2>
        <p className="mt-1 text-sm text-slate-500">
          Когда куратор пишет в рабочей группе про БТ/ДТ и указывает ученика, бот находит его
          завершённый результат в идущих сейчас тестах и присылает дежурному в личку карточку с
          кнопкой «Удалить результат». В группу бот ничего не пишет.
        </p>
        {!state.ready && (
          <p className="mt-2 text-xs text-slate-500">
            Нужно настроить Telegram-бота, AGENT_TELEGRAM_IDS и сервис-аккаунт платформы.
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={state.enabled}
        aria-label="Сброс БТ/ДТ из Telegram"
        disabled={saving || (!state.ready && !state.enabled)}
        onClick={() => void toggle()}
        className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${state.enabled ? "bg-brand-600" : "bg-slate-300"}`}
      >
        <span
          className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${state.enabled ? "translate-x-5" : ""}`}
        />
      </button>
    </section>
  );
}
