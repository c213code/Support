"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { fetchApiJson, isSessionLost } from "@/lib/fetchApiJson";

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
  const [submitterNotify, setSubmitterNotify] = useState<boolean | null>(null);
  const [submissionToGroup, setSubmissionToGroup] = useState<boolean | null>(null);

  useEffect(() => {
    // Не загрузилось (например, сессия истекла) — тумблер остаётся в
    // состоянии «неизвестно» (null), а не показывает выдуманное значение.
    const load = (url: string, set: (value: boolean) => void) =>
      fetchApiJson<{ enabled?: boolean }>(url).then((result) => {
        if (result.ok) set(Boolean(result.data.enabled));
      });
    load("/api/settings/ai-cleaning", setAiCleaningEnabled);
    load("/api/settings/auto-reply", setAutoReplyEnabled);
    load("/api/settings/chat-intent", setChatIntentEnabled);
    load("/api/settings/ai-ask", setAiAskEnabled);
    load("/api/settings/auto-reply-confirm", setAutoReplyConfirm);
    load("/api/settings/status-reply", setStatusReplyEnabled);
    load("/api/settings/submitter-notify", setSubmitterNotify);
    load("/api/settings/submission-to-group", setSubmissionToGroup);
  }, []);

  async function toggleAiCleaning() {
    const next = !aiCleaningEnabled;
    setAiCleaningEnabled(next);
    const res = await fetch("/api/settings/ai-cleaning", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok || isSessionLost(res)) {
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
    if (!res.ok || isSessionLost(res)) {
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
    if (!res.ok || isSessionLost(res)) {
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
    if (!res.ok || isSessionLost(res)) {
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
    if (!res.ok || isSessionLost(res)) {
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

  async function toggleSubmitterNotify() {
    const next = !submitterNotify;
    setSubmitterNotify(next);
    const res = await fetch("/api/settings/submitter-notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok || isSessionLost(res)) {
      setSubmitterNotify(!next);
      toast("Не удалось переключить ответы автору обращения", "error");
      return;
    }
    toast(
      next
        ? "Автор обращения из формы узнает о смене статуса"
        : "Автору обращения из формы бот больше не пишет",
      next ? "success" : "info"
    );
  }

  async function toggleSubmissionToGroup() {
    const next = !submissionToGroup;
    // Включение заставляет бота публиковать обращения там, где сидят
    // коллеги, — как и у автоответов, спрашиваем прямо.
    if (next && !window.confirm("Обращения из формы будут уходить в рабочую группу, которую выбрал куратор. Включить?")) {
      return;
    }
    setSubmissionToGroup(next);
    const res = await fetch("/api/settings/submission-to-group", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok || isSessionLost(res)) {
      setSubmissionToGroup(!next);
      toast("Не удалось переключить отправку обращений в группу", "error");
      return;
    }
    toast(
      next
        ? "Обращения из формы уходят в выбранную группу"
        : "Обращения из формы остаются только на доске",
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
    if (!res.ok || isSessionLost(res)) {
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
    submitterNotify,
    submissionToGroup,
    toggleAiCleaning,
    toggleAutoReply,
    toggleChatIntent,
    toggleAiAsk,
    toggleAutoReplyConfirm,
    toggleStatusReply,
    toggleSubmitterNotify,
    toggleSubmissionToGroup,
  };
}
