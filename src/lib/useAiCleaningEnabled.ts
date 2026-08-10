"use client";

import { useEffect, useState } from "react";

// Тогл "ИИ-описания" читается уже не только в /inbox (см. Inbox.tsx) — тут
// он нужен ещё и IssueForm, чтобы решить, показывать ли кнопку "вернуть
// без ИИ". Настройка общая на всё приложение, не по агенту, поэтому просто
// читаем её один раз при монтировании — без опроса, она меняется вручную
// и редко.
export function useAiCleaningEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/ai-cleaning")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setEnabled(Boolean(data.enabled));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
