"use client";

import { useEffect, useState } from "react";
import { fetchApiJson } from "@/lib/fetchApiJson";

// Возвращает отображаемое имя текущего пользователя (для именных аккаунтов —
// сам аккаунт, для "Дежурный" — введённое имя вроде "Тикош").
export function useCurrentAgent(): string | null {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchApiJson<{ name?: string }>("/api/auth/me").then((result) => {
      if (!cancelled && result.ok) setName(result.data.name ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return name;
}
