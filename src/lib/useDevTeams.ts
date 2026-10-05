"use client";

import { useEffect, useState } from "react";
import type { EscalationTeam } from "@/lib/escalation";

export type DevTeamMember = { name: string; lead: boolean };
export type DevTeams = Partial<Record<EscalationTeam, DevTeamMember[]>>;

// Состав команд разработки (DEV_TEAM_MEMBERS, см. lib/devTeams.ts) меняется
// руками и редко — читаем один раз при открытии окна, без опроса. Заодно —
// настроена ли Jira (кнопка «Баг в Jira»).
export function useDevTeams(): { teams: DevTeams; jiraEnabled: boolean } {
  const [state, setState] = useState<{ teams: DevTeams; jiraEnabled: boolean }>({
    teams: {},
    jiraEnabled: false,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dev-teams")
      .then((res) => (res.ok ? res.json() : { teams: {} }))
      .then((data) => {
        if (!cancelled) setState({ teams: data.teams ?? {}, jiraEnabled: Boolean(data.jira) });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
