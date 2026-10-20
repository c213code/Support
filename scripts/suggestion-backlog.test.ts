import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { suggestionBacklogTarget } from "../src/lib/suggestionBacklog";
import { buildSubmissionPost, postSubmissionToGroup } from "../src/lib/submissionGroupPost";
import { findLabel } from "../src/lib/submissionLabels";
import { prisma } from "../src/lib/prisma";
import { sendStoredPhotos } from "../src/lib/telegram";

const groupName = "IT + Сервис";
const label = findLabel(groupName, "suggestion")!;
const opts = { issueId: "ticketABC123", groupName, authorName: "Куратор <тест>", telegramUserId: BigInt(123), label,
  values: { description: "Сабаққа белгі қосу & сүзгі", urgency: "medium" }, photoFileIds: [] };
function env(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const before = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}

function mockDelegate(t: TestContext, delegate: object, name: string, implementation: unknown) {
  const methods = delegate as Record<string, unknown>;
  const before = methods[name];
  methods[name] = implementation;
  t.after(() => { methods[name] = before; });
}

test("only suggestions route automatically to the configured backlog topic", (t) => {
  env(t, { SUGGESTION_BACKLOG_ENABLED: undefined, SUGGESTION_BACKLOG_CHAT_ID: undefined, SUGGESTION_BACKLOG_THREAD_ID: undefined });
  assert.deepEqual(suggestionBacklogTarget("suggestion"), { chatId: "-1001759146038", threadId: 22735 });
  assert.equal(suggestionBacklogTarget("other"), null);
  process.env.SUGGESTION_BACKLOG_ENABLED = "false";
  assert.equal(suggestionBacklogTarget("suggestion"), null);
});

test("the suggestion card shows the source and spreadsheet links without claiming a write", (t) => {
  env(t, { PUBLIC_APP_URL: "https://example.com" });
  const post = buildSubmissionPost({ ...opts, sourceMessageUrl: "https://t.me/c/123/456", live: true, limit: 4096 });
  assert.match(post.html, /💡 Ұсыныс #ABC123/);
  assert.doesNotMatch(post.html, /Бағыты/);
  assert.match(post.html, /Хабарлама: <a href="https:\/\/t.me\/c\/123\/456">ашу<\/a>/);
  assert.match(post.html, /📊 Ұсыныстар кестесі: <a href="https:\/\/docs.google.com\/spreadsheets\/d\/1VCY43GIjOFA_FeFfIWo-k6G6_OortrNe53hfogkPWgQ\/edit">ашу<\/a>/);
  assert.doesNotMatch(post.plain, /Кестеге де енгізілді/);
  assert.match(post.html, /Сабаққа белгі қосу &amp; сүзгі/);
  assert.match(post.plain, /Қаншалықты шұғыл\?: Орташа/);
  assert.match(post.html, /Куратор &lt;тест&gt;/);
  assert.match(post.html, /href="https:\/\/example.com\/inbox\?issue=ticketABC123"/);
  assert.doesNotMatch(post.plain, /ТЕСТ|Ұсыныс #ABC123: Ұсыныс/);
});

test("a spreadsheet confirmation requires an explicit successful-write receipt", (t) => {
  env(t, { PUBLIC_APP_URL: "https://example.com" });
  const post = buildSubmissionPost({ ...opts, live: true, limit: 4096, spreadsheetReceipt: { url: "https://docs.google.com/spreadsheets/d/verified/edit#range=A20" } });
  assert.match(post.plain, /📊 Кестеге де енгізілді: https:\/\/docs.google.com\/spreadsheets\/d\/verified\/edit#range=A20/);
});

test("suggestions create a source post then a linked backlog copy, and retries reuse both", async (t) => {
  env(t, { TELEGRAM_BOT_TOKEN: "test-token", PUBLIC_APP_URL: "https://example.com", SUGGESTION_BACKLOG_ENABLED: undefined });
  const existing = new Map<string, { messageId: number }>();
  mockDelegate(t, prisma.appSetting, "findUnique", async () => { throw new Error("Must not enable/read the global switch for suggestions"); });
  mockDelegate(t, prisma.groupPreset, "findUnique", async () => ({ chatId: "-100222" }));
  mockDelegate(t, prisma.botReply, "findFirst", async ({ where }: { where: { chatId: string } }) => existing.get(where.chatId) ?? null);
  mockDelegate(t, prisma.botReply, "create", async ({ data }: { data: { chatId: string; messageId: number } }) => { existing.set(data.chatId, { messageId: data.messageId }); return data; });
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string));
    return Response.json({ ok: true, result: { message_id: requests.length + 98 } });
  });
  const link = await postSubmissionToGroup(opts);
  assert.equal(link, "https://t.me/c/222/99");
  assert.equal(await postSubmissionToGroup(opts), link);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].chat_id, "-100222");
  assert.equal(requests[0].message_thread_id, undefined);
  assert.equal(requests[1].chat_id, "-1001759146038");
  assert.equal(requests[1].message_thread_id, 22735);
  assert.match(requests[1].text as string, /Хабарлама: <a href="https:\/\/t.me\/c\/222\/99">ашу<\/a>/);
});

test("a failed backlog copy preserves the source link and retry only sends the missing copy", async (t) => {
  env(t, { TELEGRAM_BOT_TOKEN: "test-token", PUBLIC_APP_URL: "https://example.com", SUGGESTION_BACKLOG_ENABLED: undefined });
  let sourceSaved = false;
  mockDelegate(t, prisma.groupPreset, "findUnique", async () => ({ chatId: "-100222" }));
  mockDelegate(t, prisma.botReply, "findFirst", async ({ where }: { where: { chatId: string } }) => where.chatId === "-100222" && sourceSaved ? { messageId: 99 } : null);
  mockDelegate(t, prisma.botReply, "create", async () => { sourceSaved = true; return {}; });
  const targets: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const data = JSON.parse(init.body as string);
    targets.push(data.chat_id);
    return data.chat_id === "-100222" ? Response.json({ ok: true, result: { message_id: 99 } })
      : Response.json({ ok: false, description: "Topic not found" }, { status: 400 });
  });
  t.mock.method(console, "warn", () => {});
  assert.equal(await postSubmissionToGroup(opts), "https://t.me/c/222/99");
  assert.equal(await postSubmissionToGroup(opts), "https://t.me/c/222/99");
  assert.deepEqual(targets, ["-100222", "-1001759146038", "-1001759146038"]);
});

test("both a single screenshot and an album keep the backlog topic", async (t) => {
  env(t, { TELEGRAM_BOT_TOKEN: "test-token" });
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(init.body as string) });
    return Response.json({ ok: true, result: { message_id: 88 } });
  });
  await sendStoredPhotos("-1001759146038", ["photo1"], "Suggestion", "HTML", 22735);
  await sendStoredPhotos("-1001759146038", ["photo1", "photo2"], "Suggestion", "HTML", 22735);
  assert.ok(requests[0].url.endsWith("/sendPhoto"));
  assert.ok(requests[1].url.endsWith("/sendMediaGroup"));
  for (const request of requests) assert.equal(request.body.message_thread_id, 22735);
  const html = `<a href="https://example.com/${"path/".repeat(240)}">Скриншот</a>`;
  await sendStoredPhotos("-1001759146038", ["photo1"], html, "HTML", 22735);
  assert.equal(requests[2].body.caption, html, "HTML must not be cut inside the link");
});

test("failed Telegram sends are not recorded as delivered", async (t) => {
  env(t, { TELEGRAM_BOT_TOKEN: "test-token", PUBLIC_APP_URL: "https://example.com", SUGGESTION_BACKLOG_ENABLED: undefined });
  mockDelegate(t, prisma.groupPreset, "findUnique", async () => ({ chatId: "-100222" }));
  mockDelegate(t, prisma.botReply, "findFirst", async () => null);
  mockDelegate(t, prisma.botReply, "create", async () => { throw new Error("Must not save a failed send"); });
  t.mock.method(globalThis, "fetch", async () => Response.json({ ok: false, description: "Topic not found" }, { status: 400 }));
  t.mock.method(console, "warn", () => {});
  assert.equal(await postSubmissionToGroup(opts), null);
});
