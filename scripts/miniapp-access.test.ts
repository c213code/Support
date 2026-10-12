import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { OFFICIAL_GROUP_NAMES } from "../src/lib/groups";
import { checkMiniAppAccess } from "../src/lib/miniappAccess";
import { POST as submit } from "../src/app/api/miniapp/submit/route";
import { POST as checkContact } from "../src/app/api/miniapp/check-contact/route";

test("mini-app membership and route authorization", async (t) => {
  const token = "123:test-token";
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldStorage = process.env.TELEGRAM_STORAGE_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = token;
  process.env.TELEGRAM_STORAGE_CHAT_ID = "-100999";
  t.after(() => {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldStorage === undefined) delete process.env.TELEGRAM_STORAGE_CHAT_ID;
    else process.env.TELEGRAM_STORAGE_CHAT_ID = oldStorage;
  });
  function mockMethod(target: object, name: string, replacement: (...args: never[]) => unknown) {
    const object = target as Record<string, unknown>;
    const original = object[name];
    object[name] = replacement;
    t.after(() => { object[name] = original; });
  }
  let groups = [{ chatId: "-1001" }, { chatId: "-1002" }];
  let statuses: unknown[] = [];
  let networkError = false;
  let calls = 0;
  mockMethod(prisma.groupPreset, "findMany", async (query: unknown) => {
    assert.deepEqual(query, {
      where: { name: { in: [...OFFICIAL_GROUP_NAMES] }, chatId: { not: null } },
      select: { chatId: true },
    });
    return groups;
  });
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++;
    assert.ok(url.endsWith("/getChatMember"));
    const body = JSON.parse(String(options.body));
    assert.equal(body.user_id, 42);
    if (networkError) throw new Error("offline");
    const index = body.chat_id === "-1001" ? 0 : 1;
    return Response.json({ ok: true, result: statuses[index] });
  });
  const member = (status: string, extra = {}) => ({ status, user: { id: 42 }, ...extra });
  for (const status of ["creator", "administrator", "member"]) {
    statuses = [member("left"), member(status)];
    assert.deepEqual(await checkMiniAppAccess(BigInt(42)), { ok: true });
  }
  statuses = [member("restricted", { is_member: true }), member("kicked")];
  assert.deepEqual(await checkMiniAppAccess(BigInt(42)), { ok: true });
  statuses = [member("restricted", { is_member: false }), member("left")];
  assert.equal((await checkMiniAppAccess(BigInt(42))).ok, false);
  statuses = [member("left"), member("kicked")];
  assert.equal((await checkMiniAppAccess(BigInt(42)) as { status: number }).status, 403);
  // Unknown/malformed replies and mismatched identities must not grant access.
  for (const bad of [null, {}, member("unknown"), member("member", { user: { id: 99 } })]) {
    statuses = [bad, member("left")];
    assert.equal((await checkMiniAppAccess(BigInt(42)) as { status: number }).status, 503);
  }
  networkError = true;
  assert.equal((await checkMiniAppAccess(BigInt(42)) as { status: number }).status, 503);
  networkError = false;
  groups = [{ chatId: "42" }];
  const before = calls;
  assert.equal((await checkMiniAppAccess(BigInt(42)) as { status: number }).status, 503);
  assert.equal(calls, before);
  groups = [];
  assert.equal((await checkMiniAppAccess(BigInt(42)) as { status: number }).status, 503);
  groups = [{ chatId: "-1001" }, { chatId: "-1002" }];
  statuses = [member("left"), member("kicked")];

  // Signed outsider requests are rejected before retries, writes or contact lookup.
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 42, first_name: "Test" }),
  });
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret)
    .update([...params.entries()].map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"));
  mockMethod(prisma.issueSubmission, "findUnique", () => assert.fail("retry lookup before access"));
  mockMethod(prisma.miniAppAttempt, "create", () => assert.fail("write before access"));
  const form = new FormData();
  form.set("initData", params.toString());
  form.set("submissionId", "existing-submission");
  const response = await submit(new NextRequest("https://example.test/api/miniapp/submit", {
    method: "POST", body: form,
  }));
  assert.equal(response.status, 403);
  assert.ok((await response.json()).error);
  networkError = true;
  assert.equal((await submit(new NextRequest("https://example.test/api/miniapp/submit", {
    method: "POST", body: form,
  }))).status, 503);
  networkError = false;
  const unsignedForm = new FormData();
  unsignedForm.set("initData", "user=42&hash=invalid");
  const beforeUnsigned = calls;
  assert.equal((await submit(new NextRequest("https://example.test/api/miniapp/submit", {
    method: "POST", body: unsignedForm,
  }))).status, 401);
  assert.equal(calls, beforeUnsigned);
  assert.equal((await checkContact(new NextRequest("https://example.test/api/miniapp/check-contact", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: params.toString(), contact: "test@example.test" }),
  }))).status, 403);
  // A current member gets past authorization and reaches normal form validation.
  statuses = [member("member"), member("left")];
  form.delete("submissionId");
  mockMethod(prisma.miniAppAttempt, "create", async () => ({}));
  mockMethod(prisma.miniAppAttempt, "count", async () => 1);
  mockMethod(prisma.miniAppAttempt, "deleteMany", async () => ({ count: 0 }));
  const validMember = await submit(new NextRequest("https://example.test/api/miniapp/submit", {
    method: "POST", body: form,
  }));
  assert.equal(validMember.status, 400);
  assert.equal((await validMember.json()).error, "Топты таңдаңыз");
});
