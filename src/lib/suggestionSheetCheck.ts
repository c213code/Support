import { SUGGESTION_SPREADSHEET_URL } from "@/lib/suggestionBacklog";
import { ticketShortCode } from "@/lib/miniapp";

// Verified visible tabs, A:J headers: title D, description E. No write access needed.
export const SUGGESTION_SHEET_NAMES = ["САПА", "ӘДІСТЕМЕ", "СЕРВИС", "БІЛІМ", "САТУ"] as const;
export type SuggestionSheetCheck =
  | { status: "found"; url: string; sheet: string; row: number }
  | { status: "not-found" | "uncertain" | "unavailable" };

export function parseSuggestionCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ",") { row.push(cell); cell = ""; }
    else if (!quoted && (c === "\n" || c === "\r")) {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (quoted) throw new Error("Incomplete spreadsheet CSV");
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function shingles(text: string): Set<string> {
  const words = text.split(/\s+/);
  return new Set(words.slice(2).map((_, i) => words.slice(i, i + 3).join(" ")));
}

export function matchSuggestionRows(
  rows: string[][],
  input: { issueId: string; description: string; sourceMessageUrl?: string }
): { status: "found"; row: number } | { status: "not-found" | "uncertain" } {
  const header = rows[0]?.map(normalized) ?? [];
  const titleColumn = header.indexOf(normalized("Ұсыныс атауы"));
  const descriptionColumn = header.indexOf(normalized("Ұсыныс сипаттамасы"));
  if (titleColumn < 0 || descriptionColumn < 0) throw new Error("Unexpected spreadsheet headers");
  const query = normalized(input.description);
  if (query.length < 12) return { status: "uncertain" };
  const queryShingles = shingles(query);
  let uncertain = false;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const all = row.join(" ");
    const code = `#${ticketShortCode(input.issueId)}`;
    if ((input.issueId.length >= 10 && all.includes(input.issueId))
      || all.toUpperCase().includes(code.toUpperCase())
      || (input.sourceMessageUrl && all.includes(input.sourceMessageUrl))) return { status: "found", row: i + 1 };
    for (const value of [row[titleColumn] ?? "", row[descriptionColumn] ?? ""]) {
      const candidate = normalized(value);
      if (!candidate) continue;
      if (candidate === query || (query.length >= 60 && candidate.includes(query))
        || (candidate.length >= 80 && query.includes(candidate))) return { status: "found", row: i + 1 };
      const candidateShingles = shingles(candidate);
      const overlap = [...queryShingles].filter(s => candidateShingles.has(s)).length;
      const similarity = 2 * overlap / (queryShingles.size + candidateShingles.size || 1);
      if (overlap >= 8 && similarity >= 0.88) return { status: "found", row: i + 1 };
      if (overlap >= 4 && similarity >= 0.45) uncertain = true;
    }
  }
  return { status: uncertain ? "uncertain" : "not-found" };
}

export async function checkSuggestionSpreadsheet(input: {
  issueId: string; description: string; sourceMessageUrl?: string;
}): Promise<SuggestionSheetCheck> {
  const results = await Promise.allSettled(SUGGESTION_SHEET_NAMES.map(async (sheet) => {
    const url = new URL(SUGGESTION_SPREADSHEET_URL.replace(/\/edit$/, "/gviz/tq"));
    url.searchParams.set("tqx", "out:csv");
    url.searchParams.set("headers", "1");
    url.searchParams.set("sheet", sheet);
    // Bounded 20,000 cells per verified tab; refuse a negative result if full.
    url.searchParams.set("range", "A1:J2000");
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/csv")) throw new Error("Spreadsheet unreadable");
    const csv = await response.text();
    if (csv.length > 2_000_000) throw new Error("Spreadsheet response too large");
    const rows = parseSuggestionCsv(csv.replace(/^\uFEFF/, ""));
    const match = matchSuggestionRows(rows, input);
    if (match.status === "found") {
      return { status: "found" as const, sheet, row: match.row,
        url: `${SUGGESTION_SPREADSHEET_URL}#range=${encodeURIComponent(`'${sheet}'!D${match.row}:E${match.row}`)}` };
    }
    if (rows.length >= 2000 && rows[rows.length - 1].some(Boolean)) throw new Error("Spreadsheet read incomplete");
    return match;
  }));
  for (const result of results) if (result.status === "fulfilled" && result.value.status === "found") return result.value;
  if (results.some(r => r.status === "rejected")) return { status: "unavailable" };
  if (results.some(r => r.status === "fulfilled" && r.value.status === "uncertain")) return { status: "uncertain" };
  return { status: "not-found" };
}
