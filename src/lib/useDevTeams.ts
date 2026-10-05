"use client";

import { useEffect, useState } from "react";
import type { EscalationTeam } from "@/lib/escalation";

export type DevTeamMember = { name: string; lead: boolean };
export type DevTeams = Partial<Record<EscalationTeam, DevTeamMember[]>>;

// Состав команд разработки (DEV_TEAM_MEMBERS, см. lib/devTeams.ts) меняется
// руками и редко — читаем один раз при открытии окна, без опроса.
export function useDevTeams(): DevTeams {
  const [teams, setTeams] = useState<DevTeams>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dev-teams")
      .then((res) => (res.ok ? res.json() : { teams: {} }))
      .then((data) => {
        if (!cancelled) setTeams(data.teams ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return teams;
}
