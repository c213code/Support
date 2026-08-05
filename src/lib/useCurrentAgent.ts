"use client";

import { useEffect, useState } from "react";

export function useCurrentAgent(): string | null {
  const [agent, setAgent] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setAgent(data.agent ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return agent;
}
