export const AGENTS = ["Ерош", "Алпа", "Дежурный"] as const;
export type Agent = (typeof AGENTS)[number];
