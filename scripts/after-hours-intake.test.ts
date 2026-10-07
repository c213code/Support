import assert from "node:assert/strict";
import { test } from "node:test";
import { issueIntakeTiming } from "../src/lib/date";
import { prisma } from "../src/lib/prisma";
import { insertSentIssue } from "../src/lib/webhook/acknowledge";

for (const [utc, expectedDay, late] of [
  ["2026-10-07T15:59:59.999Z", "2026-10-07", false],
  ["2026-10-07T16:00:00.000Z", "2026-10-08", true],
  ["2026-10-07T18:59:59.999Z", "2026-10-08", true],
  ["2026-10-07T19:00:00.000Z", "2026-10-08", false],
  ["2026-12-31T16:00:00.000Z", "2027-01-01", true],
  ["2028-02-28T16:00:00.000Z", "2028-02-29", true],
  ["2026-10-09T16:00:00.000Z", "2026-10-10", true],
] as const) {
  test(`Almaty cutoff: ${utc}`, () => {
    const at = new Date(utc);
    assert.deepEqual(issueIntakeTiming(at), { reportDate: expectedDay, afterHoursSubmittedAt: late ? at : null });
  });
}

test("today's manual ticket moves to tomorrow, explicit historical date is preserved", () => {
  const at = new Date("2026-10-07T16:15:00Z");
  assert.equal(issueIntakeTiming(at, "2026-10-07").reportDate, "2026-10-08");
  assert.deepEqual(issueIntakeTiming(at, "2026-10-06"), { reportDate: "2026-10-06", afterHoursSubmittedAt: null });
  assert.deepEqual(issueIntakeTiming(at, "2026-10-08"), { reportDate: "2026-10-08", afterHoursSubmittedAt: at });
});

test("automated and mini-app intake persist the assigned day and marker using submission time", async (t) => {
  const originalFind = prisma.issue.findFirst;
  const originalCreate = prisma.issue.create;
  t.after(() => { prisma.issue.findFirst = originalFind; prisma.issue.create = originalCreate; });
  const queries: unknown[] = [];
  const writes: Record<string, unknown>[] = [];
  prisma.issue.findFirst = (async (query: unknown) => { queries.push(query); return { position: 4 }; }) as typeof prisma.issue.findFirst;
  prisma.issue.create = (async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return data; }) as unknown as typeof prisma.issue.create;
  const early = new Date("2026-10-07T15:59:59Z");
  const late = new Date("2026-10-07T16:00:00Z");
  await insertSentIssue("Test", null, "Request", null, undefined, early);
  const submission = { clientSubmissionId: "test", telegramUserId: BigInt(1), authorName: "Test", rawText: "Request", studentContact: "", lessonLink: "", photoFileId: "", photoFileIds: [] };
  await insertSentIssue("Test", null, "Request", null, submission, late);
  assert.deepEqual(queries, ["2026-10-07", "2026-10-08"].map((reportDate) => ({ where: { reportDate, groupName: "Test" }, orderBy: { position: "desc" } })));
  assert.equal(writes[0].afterHoursSubmittedAt, null);
  assert.equal(writes[1].afterHoursSubmittedAt, late);
  assert.equal(writes[1].reportDate, "2026-10-08");
  assert.equal(writes[1].status, "SENT");
  assert.equal(writes[1].position, 5);
  assert.deepEqual(writes[1].submissions, { create: submission });
});
