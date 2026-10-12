import assert from "node:assert/strict";
import { test } from "node:test";
import { ParentAccessError, parentContacts, parentPhone, parentContactMatches, isParentAccessRequest, type ParentAccount } from "../src/lib/parentAccess";
import { runParentAccessReset } from "../src/lib/parentAccessReset";
import { findParentAccounts, getParentAccount } from "../src/lib/platform";

const parentId = "10000000-0000-4000-8000-000000000001";
const studentId = "10000000-0000-4000-8000-000000000002";
const otherId = "10000000-0000-4000-8000-000000000003";
const parent: ParentAccount = { id: parentId, name: "Test Parent", login: "parent@example.test",
  phoneNumber: "+77000000001", students: [{ id: studentId, name: "Test Student", login: "student@example.test", phoneNumber: "+77000000002" }] };
const selection = { parentId, expectedLogin: parent.login, expectedPhone: parent.phoneNumber, studentIds: [studentId] };

test("batch parses formatted parent/student contacts, apostrophes and duplicates", () => {
  assert.deepEqual(parentContacts("Ата-ана кабинетіне тіркелу\nTest A — +7 700 000 00 01\nTest B — 8 (700) 000-00-02\nTest C — +7 7'00 000 00 03\nstudent@example.test\n+77000000001"),
    ["student@example.test", "+77000000001", "+77000000002", "+77000000003"]);
  assert.equal(parentPhone("+7 7'00 000 00 03"), "+77000000003");
  assert.deepEqual(parentContacts("12345677700000000099"), []);
  assert.deepEqual(parentContacts("7000000001@example.test"), ["7000000001@example.test"]);
  assert.deepEqual(parentContacts("АА аккаунтына кіре алмай отыр", false), []);
});

test("parent request recognition does not classify a student's ordinary login error", () => {
  assert.equal(isParentAccessRequest("АА аккаунтына кіре алмай отыр, логин қате"), true);
  assert.equal(isParentAccessRequest("AA аккаунтына кіре алмай отыр"), true);
  assert.equal(isParentAccessRequest("Ата-ана кабинетіне тіркелу. Пароль қате"), true);
  assert.equal(isParentAccessRequest("Пароль родителя неверный"), true);
  assert.equal(isParentAccessRequest("Оқушының логині қате"), false);
  assert.equal(parentContactMatches("+77000000001", { login: "x", phoneNumber: "+77000000002" }), false);
});

test("changed contact or stale student-parent relation prevents any reset", async () => {
  let calls = 0;
  const deps = { read: async () => parent, begin: async () => { calls++; }, reset: async () => { calls++; throw Error("must not reset"); }, finish: async () => {} };
  await assert.rejects(runParentAccessReset({ ...selection, expectedPhone: "+77000000009" }, deps), ParentAccessError);
  await assert.rejects(runParentAccessReset({ ...selection, studentIds: [otherId] }, deps), ParentAccessError);
  await assert.rejects(runParentAccessReset({ ...selection, parentId: otherId }, deps), ParentAccessError);
  assert.equal(calls, 0);
});

test("duplicate operation or unavailable journal prevents upstream mutation", async () => {
  let resets = 0;
  await assert.rejects(runParentAccessReset(selection, { read: async () => parent,
    begin: async () => { throw new ParentAccessError("already claimed"); },
    reset: async () => { resets++; throw Error("must not reset"); }, finish: async () => {} }));
  assert.equal(resets, 0);
});

test("upstream timeout is recorded uncertain and is never automatically retried", async () => {
  const actions: string[] = [];
  await assert.rejects(runParentAccessReset(selection, { read: async () => parent,
    begin: async () => { actions.push("begin"); }, reset: async () => { actions.push("reset"); throw Error("timeout"); },
    finish: async (status) => { actions.push(status); } }));
  assert.deepEqual(actions, ["begin", "reset", "UNCERTAIN"]);
});

test("credentials are returned transiently while audit receives only status", async () => {
  const statuses: string[] = [];
  const result = await runParentAccessReset(selection, { read: async () => parent, begin: async () => {},
    reset: async () => ({ login: parent.login, password: "test-password", phoneNumber: parent.phoneNumber, message: "ok" }),
    finish: async (status) => { statuses.push(status); } });
  assert.equal(result.password, "test-password");
  assert.deepEqual(statuses, ["SUCCESS"]);
});

async function withPlatformMock(action: (calls: string[]) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const calls: string[] = [];
  process.env.PLATFORM_API_URL = "https://platform.example.test";
  process.env.PLATFORM_SERVICE_USERNAME = "fixture";
  process.env.PLATFORM_SERVICE_PASSWORD = "fixture";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/auth/signin") return Response.json({ token: "test-token" });
    assert.notEqual(init?.method, "POST", "lookup must never reset or send messages");
    if (url.pathname === "/v1/users") {
      const q = url.searchParams.get("search");
      const p = { id: parentId, roles: ["PARENT"], username: parent.login, phoneNumber: parent.phoneNumber };
      const s = { id: studentId, roles: ["STUDENT"], username: "student@example.test", phoneNumber: "+77000000002",
        parentEmail: parent.login, parentPhoneNumber: parent.phoneNumber };
      return Response.json({ content: q === "student@example.test" || q === "+77000000002" || q === "7000000002" ? [s] : [p], totalElements: 1 });
    }
    if (url.pathname === `/v1/users/${studentId}`) return Response.json({ id: studentId, roles: ["STUDENT"], username: "student@example.test",
      parentEmail: parent.login, parentPhoneNumber: parent.phoneNumber });
    if (url.pathname === `/v1/users/${parentId}`) return Response.json({ id: parentId, roles: ["PARENT"], username: parent.login,
      phoneNumber: parent.phoneNumber, children: [{ id: studentId, username: "student@example.test", firstname: "Test", lastname: "Student" }] });
    throw Error("unexpected URL");
  };
  try { await action(calls); }
  finally { globalThis.fetch = originalFetch; for (const key of ["PLATFORM_API_URL", "PLATFORM_SERVICE_USERNAME", "PLATFORM_SERVICE_PASSWORD"])
    if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
}

test("parent phone and student email resolve the same verified parent without any reset", async () => {
  await withPlatformMock(async (calls) => {
    const [direct, viaStudent] = await Promise.all([findParentAccounts("+77000000001"), findParentAccounts("student@example.test")]);
    assert.deepEqual(direct.parents.map((p) => p.id), [parentId]);
    assert.deepEqual(viaStudent.parents.map((p) => p.id), [parentId]);
    assert.deepEqual(viaStudent.parents[0].matchedStudentIds, [studentId]);
    assert.ok(!calls.some((call) => call.includes("reset-password")));
    assert.ok(!calls.some((call) => call === `GET /v1/users/${studentId}`), "search DTO supplies parent contacts without course expansion");
    assert.equal(calls.filter((call) => call === "POST /v1/auth/signin").length, 1, "batch shares one service login");
    await assert.rejects(getParentAccount(studentId), ParentAccessError);
  });
});
