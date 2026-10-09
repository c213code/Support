export const LOCAL_FEATURE_AGENT_ID = "local";
export const FEATURE_AGENT_ONLINE_MS = 120_000;

export type FeatureAgentState = {
  enabled: boolean;
  online: boolean;
  currentIssueId: string | null;
  lastSeenAt: string | null;
  model: string | null;
  reasoning: string | null;
  runsCount: number;
  dailyLimit: number;
};

type Control = {
  enabled: boolean;
  lastSeenAt: Date | null;
  currentIssueId: string | null;
  model: string | null;
  reasoning: string | null;
  runsDate: string | null;
  runsCount: number;
  dailyLimit: number;
};

export function featureAgentState(control: Control | null, day: string, now = Date.now()): FeatureAgentState {
  const seen = control?.lastSeenAt?.getTime();
  const online = seen !== undefined && seen <= now && now - seen < FEATURE_AGENT_ONLINE_MS;
  return {
    enabled: control?.enabled ?? false,
    online,
    currentIssueId: online ? control?.currentIssueId ?? null : null,
    lastSeenAt: control?.lastSeenAt?.toISOString() ?? null,
    model: control?.model ?? null,
    reasoning: control?.reasoning ?? null,
    runsCount: control?.runsDate === day ? control.runsCount : 0,
    dailyLimit: control?.dailyLimit ?? 20,
  };
}
