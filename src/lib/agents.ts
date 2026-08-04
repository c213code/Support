export const AGENTS = ["Ерош", "Алпа"] as const;
export type Agent = (typeof AGENTS)[number];

export const AGENT_STORAGE_KEY = "support_default_agent";
