export const AGENTS = ["Ерош", "Алпа"] as const;
export type Agent = (typeof AGENTS)[number];
