import assert from "node:assert/strict";
import test from "node:test";
import { checkSuggestionSpreadsheet, matchSuggestionRows, parseSuggestionCsv, SUGGESTION_SHEET_NAMES } from "../src/lib/suggestionSheetCheck";

const headers = ["№", "Ұсыныс берілген күні", "Ұсыныс иесі", "Ұсыныс атауы", "Ұсыныс сипаттамасы"];
const description = "Платформада қайта тапсыру тесттері автоматты түрде тек төмен балл алған оқушыларға ашылатындай ету керек";
const input = { issueId: "ticketABC123", description, sourceMessageUrl: "https://t.me/c/123/456" };
const row = (text: string) => ["1", "20.10", "Куратор", "Қайта тапсыру", text];
const csv = (rows: string[][]) => rows.map(r => r.map(c => `"${c.replace(/"/g, '""')}"`).join(",")).join("\r\n");

test("CSV parser preserves quoted commas, newlines and double quotes", () => {
  const rows = [headers, row('Екі жол, "тырнақша"\nекінші жол')];
  assert.deepEqual(parseSuggestionCsv(csv(rows)), rows);
  assert.throws(() => parseSuggestionCsv('"unfinished'), /Incomplete/);
});

test("manual entries match their normalized descriptions, issue IDs or Telegram links", () => {
  for (const text of [description, description.toUpperCase() + "!", "https://example.com/inbox?issue=ticketABC123", input.sourceMessageUrl, "Өтініш #ABC123"])
    assert.deepEqual(matchSuggestionRows([headers, row(text)], input), { status: "found", row: 2 });
});

test("unrelated proposals and the same author alone do not count as existing", () => {
  assert.deepEqual(matchSuggestionRows([headers, row("Поштаға хабарландыру жіберу функциясын қосу")], input), { status: "not-found" });
});

test("similar but unconfirmed descriptions suppress a definitive negative result", () => {
  const text = "Платформада қайта тапсыру тесттері автоматты түрде тек төмен балл алған оқушыларға қолмен ашылсын немесе куратор арнайы батырмамен өзі рұқсат берсін";
  assert.deepEqual(matchSuggestionRows([headers, row(text)], input), { status: "uncertain" });
});

test("all five verified tabs are read without caching and only then can absence be confirmed", async (t) => {
  const tabs: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    assert.equal(init.cache, "no-store");
    assert.equal(url.searchParams.get("range"), "A1:J2000");
    tabs.push(url.searchParams.get("sheet")!);
    return new Response(csv([headers, row("Басқа бөлек ұсыныс")]), { headers: { "content-type": "text/csv" } });
  });
  assert.deepEqual(await checkSuggestionSpreadsheet(input), { status: "not-found" });
  assert.deepEqual(tabs.sort(), [...SUGGESTION_SHEET_NAMES].sort());
});

test("a confirmed entry on any tab returns its location, even if another tab is unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: URL) => url.searchParams.get("sheet") === "БІЛІМ"
    ? new Response(csv([headers, row(description)]), { headers: { "content-type": "text/csv" } })
    : new Response("Not authorized", { status: 403 }));
  const result = await checkSuggestionSpreadsheet(input);
  assert.equal(result.status, "found");
  if (result.status === "found") {
    assert.equal(result.sheet, "БІЛІМ");
    assert.equal(result.row, 2);
  }
});

test("a failed or incomplete read is never treated as a missing entry", async (t) => {
  for (const response of [
    () => new Response("Sign in", { headers: { "content-type": "text/html" } }),
    () => new Response(csv([["Changed header"]]), { headers: { "content-type": "text/csv" } }),
    () => new Response(csv([headers, ...Array.from({ length: 1999 }, () => row("Другое предложение"))]), { headers: { "content-type": "text/csv" } }),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response());
    assert.deepEqual(await checkSuggestionSpreadsheet(input), { status: "unavailable" });
    mock.mock.restore();
  }
});
