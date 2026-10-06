import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prisma } from "../src/lib/prisma";
import { startRun } from "../src/lib/reconcileRun";
import { reconcileIssue, buildUserText } from "../src/lib/dayReconcile";
import { changeIssueStatus } from "../src/lib/issueStatus";

// Prisma exposes delegate methods through a proxy; node.mock.method cannot
// inspect their descriptors. Replace and restore the proxy methods directly.
function stub(t: TestContext, target: object, key: string, replacement: unknown) {
  const record = target as Record<string, unknown>;
  const original = record[key];
  record[key] = replacement;
  t.after(() => { record[key] = original; });
}
type RunData = { instructions: string[]; scope: string; finishedAt: Date | null;
  verdicts: { create: { issueId: string; issueUpdatedAt: Date }[] } };

test("chat scans all open tickets in scope without a keyword prefilter and snapshots revisions", async (t) => {
  const updatedAt = new Date("2026-10-06T10:00:00Z");
  stub(t, prisma.issue, "findMany", async (query: { where: unknown }) => {
    assert.deepEqual(query.where, { reportDate: { lte: "2026-10-06" }, status: { not: "RESOLVED" } });
    return [{ id: "mini", status: "PENDING", updatedAt }, { id: "other", status: "SENT", updatedAt }];
  });
  stub(t, prisma.reconcileRun, "findFirst", () => { throw new Error("Must not reuse a normal run"); });
  stub(t, prisma.reconcileRun, "create", async ({ data }: { data: RunData }) => {
    assert.deepEqual(data.instructions, ["мини тест решен"]);
    assert.equal(data.scope, "all_open");
    assert.deepEqual(data.verdicts.create.map((v: { issueId: string }) => v.issueId), ["mini", "other"]);
    assert.equal(data.verdicts.create[0].issueUpdatedAt, updatedAt);
    return { id: "run" };
  });
  assert.equal((await startRun("2026-10-06", "Agent", { instruction: "мини тест решен", scope: "all_open" })).id, "run");
});

test("follow-up uses server history, keeps exceptions and restricts history to the same actor and date", async (t) => {
  stub(t, prisma.reconcileRun, "findFirst", async ({ where }: { where: { reportDate: string } }) => {
    assert.deepEqual(where, { id: "previous", reportDate: "2026-10-06", startedBy: "Agent" });
    return { instructions: ["Мини тест решён, кроме математики"] };
  });
  stub(t, prisma.issue, "findMany", async ({ where }: { where: { reportDate: string } }) => {
    assert.equal(where.reportDate, "2026-10-06");
    return [];
  });
  stub(t, prisma.reconcileRun, "create", async ({ data }: { data: RunData }) => {
    assert.deepEqual(data.instructions, ["Мини тест решён, кроме математики", "Только в группе А"]);
    assert.ok(data.finishedAt);
    return { id: "next" };
  });
  await startRun("2026-10-06", "Agent", { instruction: "Только в группе А", previousRunId: "previous" });
});

test("missing history is rejected instead of applying a context-free follow-up", async (t) => {
  stub(t, prisma.reconcileRun, "findFirst", async () => null);
  await assert.rejects(startRun("2026-10-06", "Agent", { instruction: "Их закрой", previousRunId: "missing" }), /Диалог не найден/);
});

test("history limit never silently drops original restrictions", async (t) => {
  stub(t, prisma.reconcileRun, "findFirst", async () => ({ instructions: Array(8).fill("кроме математики") }));
  await assert.rejects(startRun("2026-10-06", "Agent", { instruction: "Их закрой", previousRunId: "previous" }), /уже 8/);
});

test("provider receives chat context without replies; fabricated evidence cannot produce an applicable verdict", async (t) => {
  stub(t, prisma.glossaryTerm, "findMany", async () => []);
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    assert.match(request.messages[0].content, /Адресный разбор/);
    assert.match(request.messages[1].content, /мини тест решен/);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ status: "RESOLVED", note: "Исправили", evidence: "Агент всё исправил", reason: "Готово" }) } }] });
  });
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  t.after(() => { if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; });
  const result = await reconcileIssue({ kind: "openrouter", model: "test" }, "мини-тест ашылмай тұр", [], [], [], ["мини тест решен"]);
  assert.ok(result.ok);
  assert.equal(result.verdict.status, "UNCLEAR");
});

test("valid operator evidence can resolve a ticket with no Telegram replies", async (t) => {
  stub(t, prisma.glossaryTerm, "findMany", async () => []);
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: {
    content: JSON.stringify({ status: "RESOLVED", note: "Мини-тест исправлен", evidence: "мини тест решен", reason: "То же нарушение открытия мини-теста" }),
  } }] }));
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only";
  t.after(() => { if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; });
  const result = await reconcileIssue({ kind: "openrouter", model: "test" }, "мини-тест ашылмай тұр", [], [], [], ["мини тест решен"]);
  assert.ok(result.ok);
  assert.equal(result.verdict.status, "RESOLVED");
});

test("ticket and operator contacts are masked in persisted model input", () => {
  const input = buildUserText("mini test user@example.com", [], [], [], ["Мини тест решён user@example.com"]);
  assert.ok(!input.includes("user@example.com"));
  assert.match(input, /Указания дежурного/);
});

test("concurrent ticket edit prevents status write and event/notification creation", async (t) => {
  const revision = new Date("2026-10-06T10:00:00Z");
  stub(t, prisma.issue, "findUnique", async () => ({ status: "PENDING", createdBy: "Agent", telegramLink: null }));
  stub(t, prisma, "$transaction", async (callback: (tx: unknown) => Promise<unknown>) => callback({
    issue: { updateMany: async ({ where }: { where: unknown }) => {
      assert.deepEqual(where, { id: "issue", updatedAt: revision, status: "PENDING" });
      return { count: 0 };
    } },
    issueEvent: { create: () => { throw new Error("Must not create an event on conflict"); } },
  }));
  assert.deepEqual(await changeIssueStatus({ issueId: "issue", status: "RESOLVED", actor: "Agent", source: "chat",
    expectedUpdatedAt: revision, expectedStatus: "PENDING" }), { ok: false, reason: "conflict" });
});
