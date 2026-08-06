"use client";

import { useEffect, useState } from "react";

// Возвращает отображаемое имя текущего пользователя (для именных аккаунтов —
// сам аккаунт, для "Дежурный" — введённое имя вроде "Тикош").
export function useCurrentAgent(): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setName(data.name ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return name;
}
