import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "../src/lib/prisma";
import { requestParentAccessApproval, handleParentAccessCallback } from "../src/lib/parentAccessBot";

test("incoming case → one private approval → verified reset → reply in original group", async () => {
  const savedEnv = { ...process.env }; const originalFetch = globalThis.fetch;
  Object.assign(process.env, { GROQ_API_KEY: "fixture", TELEGRAM_BOT_TOKEN: "fixture",
    AGENT_TELEGRAM_IDS: "Ерош:123", OWN_AGENT_TELEGRAM_IDS: "123",
    PLATFORM_API_URL: "https://platform.example.test", PLATFORM_SERVICE_USERNAME: "fixture", PLATFORM_SERVICE_PASSWORD: "fixture" });
  const parentId = "00000000-0000-4000-8000-000000000001";
  const studentId = "00000000-0000-4000-8000-000000000002";
  const issueId = "fixture-issue";
  const phone = "+77000000001";
  const source = "АА аккаунтына кіре алмай отыр, логин қате " + phone;
  const password = "fixture-password";
  const messages: Record<string, unknown>[] = [];
  const rows = new Map<string, Record<string, unknown>>(); const audit: Record<string, unknown>[] = [];
  let resets = 0; let counter = 100;
  let enabled = true;
  const restores: Array<() => void> = [];
  const stub = (model: object, method: string, fn: (args: Record<string, unknown>) => Promise<unknown>) => {
    const target = model as Record<string, unknown>; const before = target[method]; target[method] = fn;
    restores.push(() => { target[method] = before; });
  };
  stub(prisma.appSetting, "findUnique", async () => ({ autoReplyEnabled: false, parentAccessBotEnabled: enabled }));
  stub(prisma.groupPreset, "findMany", async () => []);
  stub(prisma.issue, "findUnique", async () => ({ description: source, groupName: "Service", status: "SENT", telegramLink: "fixture-source" }));
  stub(prisma.telegramMessage, "findMany", async () => [{ text: source, messageId: 42, messageLink: "fixture-source" }]);
  stub(prisma.telegramMessage, "findFirst", async () => ({ text: source, messageId: 42 }));
  stub(prisma.pendingParentAccess, "upsert", async (args) => {
    const created = args.create as Record<string, unknown>;
    const existing = [...rows.values()].find((row) => row.parentId === created.parentId && row.issueId === created.issueId);
    if (existing) return { ...existing };
    const row: Record<string, unknown> = { ...created, dmMessageId: null, status: "PENDING", createdAt: new Date() };
    rows.set(String(row.id), row); return { ...row };
  });
  stub(prisma.pendingParentAccess, "findUnique", async (args) => rows.get(String((args.where as Record<string, unknown>).id)));
  stub(prisma.pendingParentAccess, "updateMany", async (args) => {
    const where = args.where as Record<string, unknown>; const row = rows.get(String(where.id));
    if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
    Object.assign(row, args.data); return { count: 1 };
  });
  stub(prisma.pendingParentAccess, "update", async (args) => {
    const row = rows.get(String((args.where as Record<string, unknown>).id))!;
    Object.assign(row, args.data); return { ...row };
  });
  stub(prisma.parentAccessReset, "create", async (args) => { audit.push(args.data as Record<string, unknown>); return args.data; });
  stub(prisma.parentAccessReset, "update", async (args) => { audit.push(args.data as Record<string, unknown>); return args.data; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (url.hostname === "api.groq.com") return Response.json({ choices: [{ message: { content: '{"parent_credentials":true}' } }] });
    if (url.hostname === "api.telegram.org") {
      messages.push({ method: url.pathname.split("/").at(-1), ...body });
      return Response.json({ ok: true, result: { message_id: ++counter } });
    }
    if (url.hostname !== "platform.example.test") throw Error("Unexpected network request");
    const parent = { id: parentId, roles: ["PARENT"], firstname: "Parent", lastname: "Fixture", username: "parent@example.test", phoneNumber: phone,
      children: [{ id: studentId, username: "student@example.test", firstname: "Student", lastname: "Fixture" }] };
    if (url.pathname === "/v1/auth/signin") return Response.json({ token: "fixture-token" });
    if (url.pathname === "/v1/users") return Response.json({ content: [parent], totalElements: 1 });
    if (url.pathname === `/v1/users/${parentId}`) return Response.json(parent);
    if (url.pathname === `/v2/users/${parentId}/reset-password`) {
      resets++; return Response.json({ login: parent.username, phoneNumber: phone, password, message: "ok" });
    }
    throw Error("Unexpected endpoint");
  };
  try {
    const params = { issueId, chatId: "-100123", messageId: 50, incomingText: source };
    assert.equal(await requestParentAccessApproval(params), true);
    assert.equal(await requestParentAccessApproval(params), true);
    assert.equal(resets, 0);
    const prompts = messages.filter((m) => m.method === "sendMessage");
    assert.equal(prompts.length, 1); assert.equal(prompts[0].chat_id, 123);
    assert.ok(String(prompts[0].text).includes("Student Fixture"));
    assert.ok(!String(prompts[0].text).includes(password));
    const row = [...rows.values()][0];
    const query = { id: "fixture-callback", data: `parent_access:${row.id}:send`, from: { id: 123 },
      message: { message_id: Number(row.dmMessageId), chat: { id: 123, type: "private" } } };
    await handleParentAccessCallback({ ...query, from: { id: 999 } });
    assert.equal(resets, 0);
    enabled = false;
    await handleParentAccessCallback(query);
    assert.equal(resets, 0);
    enabled = true;
    await handleParentAccessCallback(query);
    await handleParentAccessCallback(query);
    assert.equal(resets, 1);
    const delivery = messages.filter((m) => m.method === "sendMessage" && m.chat_id === "-100123");
    assert.equal(delivery.length, 1); assert.ok(String(delivery[0].text).includes(password));
    assert.equal(delivery[0].reply_to_message_id, 42, "reply goes to original case, not the later contact follow-up");
    assert.equal(delivery[0].allow_sending_without_reply, false);
    assert.equal(row.status, "SENT");
    assert.ok(!JSON.stringify(audit).includes(password)); assert.ok(!JSON.stringify([...rows.values()]).includes(password));
    await requestParentAccessApproval({ ...params, issueId: "fixture-declined" });
    const decline = [...rows.values()][1];
    const declineQuery = { ...query, data: `parent_access:${decline.id}:skip`,
      message: { ...query.message, message_id: Number(decline.dmMessageId) } };
    await handleParentAccessCallback(declineQuery);
    await handleParentAccessCallback({ ...declineQuery, data: `parent_access:${decline.id}:send` });
    assert.equal(decline.status, "DECLINED"); assert.equal(resets, 1);
  } finally {
    restores.reverse().forEach((restore) => restore()); globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
});
