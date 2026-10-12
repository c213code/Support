import assert from "node:assert/strict";
import { test } from "node:test";
import { approveParentAccess, parentApprovalAuthorized, type ParentBotStatus } from "../src/lib/parentAccessBotCore";
import { classifyParentAccessIntent, parseParentAccessIntent } from "../src/lib/parentAccessIntent";
import { extractReplyContextLine, extractText, sendTelegramMessage } from "../src/lib/telegram";
import type { ParentAccount } from "../src/lib/parentAccess";

const account: ParentAccount = { id: "00000000-0000-4000-8000-000000000001", name: "Parent Fixture",
  login: "parent@example.test", phoneNumber: "+77000000001", students: [{
    id: "00000000-0000-4000-8000-000000000002", name: "Student Fixture", login: "student@example.test", phoneNumber: null,
  }] };
const secret = "fixture-password";
const credentials = { login: account.login, phoneNumber: account.phoneNumber, password: secret, message: "ok" };

test("Groq classification is strict JSON, never a keyword fallback", async () => {
  for (const value of ['{"parent_credentials":"true"}', "true", "broken", undefined]) assert.equal(parseParentAccessIntent(value), null);
  assert.equal(parseParentAccessIntent('{"parent_credentials":true}'), true);
  assert.equal(parseParentAccessIntent('{"parent_credentials":false}'), false);
  const fetchBefore = globalThis.fetch; const keyBefore = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "fixture";
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, "json_object");
    assert.ok(!body.messages[1].content.includes("student@example.test"));
    assert.ok(!body.messages[1].content.includes(secret));
    return Response.json({ choices: [{ message: { content: '{"parent_credentials":true}' } }] });
  };
  try {
    assert.equal(await classifyParentAccessIntent(`АА аккаунтына кіре алмай отыр student@example.test\nПароль: ${secret}`), true);
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "invalid" } }] });
    assert.equal(await classifyParentAccessIntent("Ата-ана кабинеті"), null);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = fetchBefore;
    if (keyBefore === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = keyBefore;
  }
});

test("only the notified duty agent in the original private prompt can approve, for 24h", () => {
  const now = new Date(); const proposal = { recipientId: "123", dmMessageId: 8, createdAt: now };
  const callback = { fromId: 123, chatId: 123, messageId: 8, privateChat: true };
  assert.equal(parentApprovalAuthorized(proposal, callback, now), true);
  for (const change of [{ fromId: 456 }, { chatId: -100 }, { messageId: 9 }, { privateChat: false }])
    assert.equal(parentApprovalAuthorized(proposal, { ...callback, ...change }, now), false);
  assert.equal(parentApprovalAuthorized(proposal, callback, new Date(+now + 24 * 60 * 60 * 1000)), false);
});

function fixture() {
  let claimed = false; const events: string[] = []; const stored: string[] = []; const deliveries: string[] = [];
  const deps = {
    claim: async () => { if (claimed) return false; claimed = true; events.push("claim"); return true; },
    read: async () => { events.push("read"); return account; },
    begin: async () => { events.push("audit-start"); },
    reset: async () => { events.push("reset"); return credentials; },
    audit: async (status: "SUCCESS" | "UNCERTAIN") => { stored.push(status); events.push(status); },
    send: async (text: string) => { deliveries.push(text); events.push("send"); return true; },
    finish: async (status: ParentBotStatus) => { stored.push(status); },
  };
  return { deps, events, stored, deliveries };
}

test("approval resets once after fresh validation and stores only status", async () => {
  const f = fixture();
  assert.equal(await approveParentAccess(account, f.deps), "SENT");
  assert.deepEqual(f.events, ["claim", "read", "audit-start", "reset", "SUCCESS", "send"]);
  assert.ok(f.deliveries[0].includes(secret));
  assert.ok(f.stored.every((s) => !s.includes(secret)));
  assert.equal(await approveParentAccess(account, f.deps), "ALREADY_HANDLED");
  assert.equal(f.deliveries.length, 1);
});

test("concurrent confirmations cannot reset or send twice", async () => {
  const f = fixture();
  assert.deepEqual((await Promise.all([approveParentAccess(account, f.deps), approveParentAccess(account, f.deps)])).sort(), ["ALREADY_HANDLED", "SENT"]);
  assert.equal(f.events.filter((event) => event === "reset").length, 1);
});

test("changed parent/child relationship and missing durable audit stop before mutation", async () => {
  for (const mode of ["changed", "audit-failed"]) {
    const f = fixture();
    if (mode === "changed") f.deps.read = async () => ({ ...account, students: [] });
    else f.deps.begin = async () => { throw Error("DB unavailable"); };
    assert.equal(await approveParentAccess(account, f.deps), "FAILED");
    assert.ok(!f.events.includes("reset")); assert.equal(f.deliveries.length, 0);
  }
});

test("reset and Telegram timeouts are terminal and never automatically retried", async () => {
  for (const phase of ["reset", "send"]) {
    const f = fixture();
    if (phase === "reset") f.deps.reset = async () => { throw Error("timeout"); };
    else f.deps.send = async () => { throw Error("timeout"); };
    assert.equal(await approveParentAccess(account, f.deps), phase === "reset" ? "UNCERTAIN" : "DELIVERY_FAILED");
    assert.equal(await approveParentAccess(account, f.deps), "ALREADY_HANDLED");
    assert.equal(f.deliveries.length, 0);
  }
});

test("credential delivery requires the original message and its quotes are never saved", async () => {
  const fetchBefore = globalThis.fetch; const tokenBefore = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "fixture";
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.chat_id, "-100123"); assert.equal(body.reply_to_message_id, 8);
    assert.equal(body.allow_sending_without_reply, false);
    return Response.json({ result: { message_id: 9 } });
  };
  try { assert.deepEqual(await sendTelegramMessage("-100123", "fixture", undefined, undefined, undefined, 8, false), { message_id: 9 }); }
  finally { globalThis.fetch = fetchBefore; if (tokenBefore === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = tokenBefore; }
  const quote = extractReplyContextLine({ message_id: 10, date: 0, chat: { id: -100123, type: "supergroup" },
    reply_to_message: { message_id: 9, from: { id: 456, is_bot: true }, text: `Ата-ана кабинетіне кіру деректері:\nПароль: ${secret}` } });
  assert.equal(quote, "↩️ Бот: Данные для входа родителя отправлены");
  const forwarded = extractText({ message_id: 11, date: 0, chat: { id: 123, type: "private" },
    text: `Ата-ана кабинетіне кіру деректері:\nПароль: ${secret}` });
  assert.ok(!forwarded?.includes(secret));
});
