import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type FeatureRule = {
  id: string;
  title: string;
  rule: string;
  search_terms: string[];
  query_ids: string[];
  sources: Array<{ source: string; path?: string; line?: number }>;
};

export type FeaturePack = {
  feature: string;
  scope: string;
  directory: string;
  rules: FeatureRule[];
  sql: string;
  routing?: { enabled: boolean; any: string[]; all: string[][] };
};

export type AgentAnswer = {
  status: "draft" | "need_details" | "escalate" | "no_match";
  feature: string;
  summary: string;
  draft: string;
  evidence: string[];
  missingData: string[];
  ruleIds: string[];
  queryIds: string[];
  sourcePaths: string[];
};

export async function loadFeaturePacks(root: string): Promise<FeaturePack[]> {
  const base = join(root, "docs/knowledge");
  const entries = await readdir(base, { withFileTypes: true });
  const packs: FeaturePack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(base, entry.name);
    try {
      const raw = JSON.parse(await readFile(join(directory, "knowledge.json"), "utf8"));
      if (typeof raw.feature !== "string" || !/^[a-z0-9-]+$/.test(raw.feature) || !Array.isArray(raw.rules)) continue;
      const sql = await readFile(join(directory, "diagnostics.sql"), "utf8").catch(() => "");
      const routing = raw.routing;
      packs.push({ feature: raw.feature, scope: String(raw.scope ?? ""), directory,
        rules: raw.rules, sql,
        routing: routing && typeof routing.enabled === "boolean" &&
          Array.isArray(routing.any) && routing.any.every((term: unknown) => typeof term === "string") &&
          Array.isArray(routing.all) && routing.all.every((group: unknown) =>
            Array.isArray(group) && group.length > 0 && group.every((term: unknown) => typeof term === "string"))
          ? routing : undefined });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return packs;
}

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().replaceAll("ё", "е").match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Exact words/phrases by default; an explicit * allows word endings in RU/KZ.
function hasTerm(tokens: string[], term: string): boolean {
  const parts = term.normalize("NFKC").toLowerCase().replaceAll("ё", "е").match(/[\p{L}\p{N}]+\*?/gu) ?? [];
  if (!parts.length) return false;
  return tokens.some((_, start) => parts.every((part, offset) => part.endsWith("*")
    ? tokens[start + offset]?.startsWith(part.slice(0, -1))
    : tokens[start + offset] === part));
}

export function activeFeaturePacks(packs: FeaturePack[]): FeaturePack[] {
  return packs.filter((pack) => pack.routing?.enabled === true);
}

export function matchFeaturePacks(text: string, packs: FeaturePack[]): FeaturePack[] {
  const tokens = words(text);
  return activeFeaturePacks(packs).filter((pack) => {
    const routing = pack.routing!;
    return routing.any.some((term) => hasTerm(tokens, term)) ||
      routing.all.some((group) => group.every((term) => hasTerm(tokens, term)));
  });
}

export function sqlSections(sql: string): Map<string, string> {
  const sections = [...sql.matchAll(/^-- (Q\d{2}[a-z]?):[^\n]*\n([\s\S]*?)(?=^-- Q\d{2}[a-z]?:|$(?![\s\S]))/gm)];
  return new Map(sections.flatMap((match) => {
    const body = match[2].replace(/^--[^\n]*$/gm, "").trim();
    if (!/^(SELECT|WITH)\b/i.test(body) || /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE)\b/i.test(body)) return [];
    return [[match[1], match[0].trim()]];
  }));
}

function boundedStrings(value: unknown, limit: number): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").slice(0, limit).map((item) => item.slice(0, 1000))
    : [];
}

export function validateAgentAnswer(raw: unknown, packs: FeaturePack[]): {
  answer: AgentAnswer;
  queries: Array<{ id: string; sql: string }>;
} {
  if (!raw || typeof raw !== "object") throw new Error("Пустой ответ агента");
  const data = raw as Record<string, unknown>;
  const status = data.status;
  if (status !== "draft" && status !== "need_details" && status !== "escalate" && status !== "no_match") {
    throw new Error("Некорректный статус агента");
  }
  if (typeof data.feature !== "string" || typeof data.summary !== "string" || typeof data.draft !== "string") {
    throw new Error("Неполный ответ агента");
  }
  const pack = status === "no_match" ? undefined : packs.find((item) => item.feature === data.feature);
  if (status !== "no_match" && !pack) throw new Error("Агент указал неизвестную фичу");
  const knownRules = new Set(pack?.rules.map((rule) => rule.id) ?? []);
  const ruleIds = boundedStrings(data.ruleIds, 20).filter((id) => knownRules.has(id));
  // Без подтверждённого правила — только запрос уточнений, без уверенного ответа.
  const safeStatus = status !== "no_match" && ruleIds.length === 0 ? "need_details" : status;
  const validQueries = new Set(pack?.rules.filter((rule) => ruleIds.includes(rule.id)).flatMap((rule) => rule.query_ids) ?? []);
  const selectedQueries = boundedStrings(data.queryIds, 12).filter((id) => validQueries.has(id));
  const sections = sqlSections(pack?.sql ?? "");
  const ids = selectedQueries.length ? ["Q00", "Q00b", ...selectedQueries.flatMap((id) => id === "Q06" ? ["Q00c", id] : [id])] : [];
  const queries = [...new Set(ids)].flatMap((id) => sections.has(id) ? [{ id, sql: sections.get(id)! }] : []);
  const sourcePaths = new Set(pack?.rules.filter((rule) => ruleIds.includes(rule.id))
    .flatMap((rule) => rule.sources.map((source) => source.path).filter((path): path is string => Boolean(path))) ?? []);
  return {
    answer: {
      status: safeStatus,
      feature: pack?.feature ?? "",
      summary: data.summary.slice(0, 1500),
      draft: safeStatus === "no_match"
        ? "Для этого случая пока нет проверенного пакета знаний. Передайте кейс разработчику для разбора."
        : safeStatus === "need_details" && !ruleIds.length
        ? "Пока не нашёл подтверждённое правило для этого случая. Уточните действие, полный текст ошибки и контекст."
        : data.draft.slice(0, 5000),
      evidence: boundedStrings(data.evidence, 10),
      missingData: boundedStrings(data.missingData, 10),
      ruleIds,
      queryIds: selectedQueries,
      sourcePaths: boundedStrings(data.sourcePaths, 20).filter((path) => sourcePaths.has(path)),
    },
    queries,
  };
}
