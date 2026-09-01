"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";

// Шесть командных тумблеров бота (общие на всё приложение, не по агенту):
// загрузка при монтировании + переключение с оптимистичным обновлением и
// откатом при ошибке. Вынесено из Inbox.tsx — логика самодостаточная, а в
// компоненте занимала ~200 строк и мешала читать сам разбор.
//
// Поведение сохранено 1:1, включая window.confirm там, где включение
// (или, наоборот, выключение) заставляет бота писать коллегам в группы:
// autoReply подтверждаем при ВКЛючении, autoReplyConfirm — при ВЫКЛючении.
export type BotSettings = ReturnType<typeof useBotSettings>;

export function useBotSettings() {
  const toast = useToast();
  const [aiCleaningEnabled, setAiCleaningEnabled] = useState<boolean | null>(
    null
  );
  const [autoReplyEnabled, setAutoReplyEnabled] = useState<boolean | null>(null);
  const [chatIntentEnabled, setChatIntentEnabled] = useState<boolean | null>(
    null
  );
  const [aiAskEnabled, setAiAskEnabled] = useState<boolean | null>(null);
  const [autoReplyConfirm, setAutoReplyConfirm] = useState<boolean | null>(null);
  const [statusReplyEnabled, setStatusReplyEnabled] = useState<boolean | null>(
    null
  );

  useEffect(() => {
    fetch("/api/settings/ai-cleaning")
      .then((res) => res.json())
      .then((data) => setAiCleaningEnabled(Boolean(data.enabled)));
    fetch("/api/settings/auto-reply")
      .then((res) => res.json())
      .then((data) => setAutoReplyEnabled(Boolean(data.enabled)));
    fetch("/api/settings/chat-intent")
      .then((res) => res.json())
      .then((data) => setChatIntentEnabled(Boolean(data.enabled)));
    fetch("/api/settings/ai-ask")
      .then((res) => res.json())
      .then((data) => setAiAskEnabled(Boolean(data.enabled)));
    fetch("/api/settings/auto-reply-confirm")
      .then((res) => res.json())
      .then((data) => setAutoReplyConfirm(Boolean(data.enabled)));
    fetch("/api/settings/status-reply")
      .then((res) => res.json())
      .then((data) => setStatusReplyEnabled(Boolean(data.enabled)));
  }, []);

  async function toggleAiCleaning() {
    const next = !aiCleaningEnabled;
    setAiCleaningEnabled(next);
    const res = await fetch("/api/settings/ai-cleaning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setAiCleaningEnabled(!next);
      toast("Не удалось переключить ИИ-описания", "error");
      return;
    }
    toast(next ? "ИИ-описания включены" : "ИИ-описания выключены", "info");
  }

  async function toggleAutoReply() {
    const next = !autoReplyEnabled;
    if (
      next &&
      !window.confirm(
        "Бот начнёт сам отвечать в рабочих группах: подтверждать приём обращений и сообщать о смене статуса. Включить?"
      )
    ) {
      return;
    }
    setAutoReplyEnabled(next);
    const res = await fetch("/api/settings/auto-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setAutoReplyEnabled(!next);
      toast("Не удалось переключить автоответы", "error");
      return;
    }
    toast(
      next ? "Автоответы включены" : "Автоответы выключены",
      next ? "success" : "info"
    );
  }

  async function toggleChatIntent() {
    const next = !chatIntentEnabled;
    setChatIntentEnabled(next);
    const res = await fetch("/api/settings/chat-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setChatIntentEnabled(!next);
      toast("Не удалось переключить чтение реплик", "error");
      return;
    }
    toast(
      next
        ? "Статусы будут ставиться по твоим ответам"
        : "Чтение реплик выключено",
      "info"
    );
  }

  async function toggleAutoReplyConfirm() {
    const next = !autoReplyConfirm;
    if (
      !next &&
      !window.confirm(
        "Выключить подтверждение? Бот начнёт отвечать в рабочих группах сразу, не спрашивая."
      )
    ) {
      return;
    }
    setAutoReplyConfirm(next);
    const res = await fetch("/api/settings/auto-reply-confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setAutoReplyConfirm(!next);
      toast("Не удалось переключить подтверждение", "error");
      return;
    }
    toast(
      next
        ? "Бот будет спрашивать в личке перед ответом"
        : "Бот отвечает в группах сразу",
      next ? "success" : "info"
    );
  }

  async function toggleStatusReply() {
    const next = !statusReplyEnabled;
    setStatusReplyEnabled(next);
    const res = await fetch("/api/settings/status-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setStatusReplyEnabled(!next);
      toast("Не удалось переключить ответы о статусе", "error");
      return;
    }
    toast(
      next
        ? "Бот пишет в чат при смене статуса"
        : "Бот молчит при смене статуса — остаётся только эмодзи-реакция",
      next ? "success" : "info"
    );
  }

  async function toggleAiAsk() {
    const next = !aiAskEnabled;
    setAiAskEnabled(next);
    const res = await fetch("/api/settings/ai-ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setAiAskEnabled(!next);
      toast("Не удалось переключить ИИ-запрос данных", "error");
      return;
    }
    toast(
      next ? "ИИ будет уточнять запрос почты/ссылки" : "ИИ-уточнение выключено",
      "info"
    );
  }

  return {
    aiCleaningEnabled,
    autoReplyEnabled,
    chatIntentEnabled,
    aiAskEnabled,
    autoReplyConfirm,
    statusReplyEnabled,
    toggleAiCleaning,
    toggleAutoReply,
    toggleChatIntent,
    toggleAiAsk,
    toggleAutoReplyConfirm,
    toggleStatusReply,
  };
}
