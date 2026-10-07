import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { prisma } from "../src/lib/prisma";
import { stepRun } from "../src/lib/reconcileRun";

function stub(t: TestContext, target: object, key: string, replacement: unknown) {
  const record = target as Record<string, unknown>;
  const original = record[key];
  record[key] = replacement;
  t.after(() => { record[key] = original; });
}
const resolved = JSON.stringify({ status: "RESOLVED", note: "Жеңілдік өшірілді", evidence: "скидку удалили", reason: "Удаление подтверждено" });
const unclear = JSON.stringify({ status: "UNCLEAR", note: "", evidence: "", reason: "Недостаточно данных о нужной скидке" });

for (const scenario of [
  { name: "reasoning limit", content: "", finish: "length", fallbackFails: false, genuine: false },
  { name: "blank response", content: "  \n", finish: "stop", fallbackFails: false, genuine: false },
  { name: "valid-looking but truncated response", content: resolved, finish: "length", fallbackFails: false, genuine: false },
  { name: "both providers fail", content: "", finish: "length", fallbackFails: true, genuine: false },
  { name: "genuine UNCLEAR verdict", content: unclear, finish: "stop", fallbackFails: false, genuine: true },
]) {
  test(scenario.name, async (t) => {
    for (const [key, value] of Object.entries({
      OPENROUTER_API_KEY: "test-only", RECONCILE_MODEL: "openrouter:test-primary",
      RECONCILE_FALLBACK: "openrouter:test-fallback", OWN_AGENT_TELEGRAM_IDS: "", AGENT_TELEGRAM_IDS: "",
    })) {
      const original = process.env[key];
      process.env[key] = value;
      t.after(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    }
    stub(t, prisma.glossaryTerm, "findMany", async () => []);
    stub(t, prisma.reconcileRun, "findUnique", async () => ({ id: "run", instructions: ["скидку удалили"] }));
    stub(t, prisma.reconcileRun, "updateMany", async () => ({ count: 1 }));
    stub(t, prisma.reconcileVerdict, "findMany", async () => [{ id: "verdict", issueId: "issue", issue: { description: "Удалить скидку", groupName: "Test", reportDate: "2026-10-07" } }]);
    stub(t, prisma.reconcileVerdict, "count", async () => 0);
    const writes: Record<string, unknown>[] = [];
    stub(t, prisma.reconcileVerdict, "updateMany", async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return { count: 1 }; });
    // These checks exercise the real run/fallback/persistence path, without a DB or API.
    stub(t, prisma.issue, "updateMany", () => { throw new Error("Must not change ticket status"); });
    const models: string[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      models.push(request.model);
      assert.match(request.messages[1].content, /скидку удалили/);
      return Response.json({ choices: [{ message: { content: models.length === 1 ? scenario.content : scenario.fallbackFails ? "" : resolved }, finish_reason: models.length === 1 ? scenario.finish : "stop" }] });
    });
    await stepRun("run");
    const saved = writes.find((data) => data.state);
    assert.ok(saved);
    assert.deepEqual(models, scenario.genuine ? ["test-primary"] : ["test-primary", "test-fallback"]);
    if (scenario.fallbackFails) {
      assert.equal(saved.state, "error");
      assert.equal(saved.proposed, undefined);
      assert.match(String(saved.error), /пустой ответ/);
    } else {
      assert.equal(saved.state, "done");
      assert.equal(saved.proposed, scenario.genuine ? "UNCLEAR" : "RESOLVED");
      if (!scenario.genuine) assert.match(String(saved.reason), /запасная модель: openrouter:test-fallback/);
    }
  });
}
