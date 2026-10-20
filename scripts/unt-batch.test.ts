import assert from "node:assert/strict";
import test from "node:test";
import { parseUntBatch, resolveBatchStudent, type BatchAccount, type BatchStudent } from "../src/lib/untBatch";
import { normalizeUntTestQuery } from "../src/lib/untResetRequest";

const account: BatchAccount = { id: "account-1", firstname: "Асан", lastname: "Тестов", email: "asan@example.com", phoneNumber: "+77771234567" };
const entry = (values: Partial<BatchStudent> = {}): BatchStudent => ({ id: "student-1", name: "Тестов Асан", emails: ["asan@example.com"], phones: ["+77771234567"], source: "", warnings: [], ...values });

test("four structured requests stay separate with exact email/name/phone associations", () => {
  const people = ["Тестов Асан", "Тестов Бек", "Тестов Данияр", "Тестов Ерасыл"];
  const { students } = parseUntBatch(people.map((name, i) => `Мәселе: дт шықпай тұр платформасында\nАты жөні: ${name}\nПочта: student_${i}@example.com\nНомер: +7 777 123 45 6${i}`).join("\n\n"));
  assert.equal(students.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.equal(students[i].name, people[i]);
    assert.deepEqual(students[i].emails, [`student_${i}@example.com`]);
    assert.deepEqual(students[i].phones, [`+7777123456${i}`]);
  }
});

test("a mixed labelled request and Telegram bold free-form records keep all three students", () => {
  const { students } = parseUntBatch(`Мәселе: пф да деңгейлік тест жоқ
Почта: dana@example.com
Аты: Тестова Дана
Номер: +7 776 725 2405

**Асан Тестов**
**+77055562470**
**asan@example.com**
**Дт жоқ**

**Айша Тестова**
**+77476198595**
**aisha@example.com**
**Бт жоқ**`);
  assert.deepEqual(students.map(s => s.emails[0]), ["dana@example.com", "asan@example.com", "aisha@example.com"]);
  assert.deepEqual(students.map(s => s.name), ["Тестова Дана", "Асан Тестов", "Айша Тестова"]);
  assert.equal(students[0].phones[0], "+77767252405");
});

test("blank lines within one request do not separate its contacts; repeated requests do not duplicate actions", () => {
  const request = "Аты-жөні: Тестов Асан\n\nПочта: asan@example.com\n\nНомер: 8 (777) 123-45-67";
  const { students, warnings } = parseUntBatch(`${request}\n\n${request}`);
  assert.equal(students.length, 1);
  assert.deepEqual(students[0].phones, ["+77771234567"]);
  assert.equal(warnings.length, 1);
});

test("standalone emails and name-only records are accepted without inventing contacts", () => {
  assert.equal(parseUntBatch("a@example.com\nb@example.com").students.length, 2);
  const students = parseUntBatch("Тестов Асан\nТестов Бек").students;
  assert.equal(students.length, 2);
  assert.deepEqual(students[0].emails, []);
  assert.equal(parseUntBatch("Дт жоқ\nМәселе: бт шықпай тұр").students.length, 0);
  assert.deepEqual(parseUntBatch("77771234567@example.com").students[0].phones, []);
});

test("oversized batches are rejected without silently dropping students", () => {
  assert.throws(() => parseUntBatch(Array.from({ length: 51 }, (_, i) => `a${i}@example.com`).join("\n")), /до 50/);
  assert.throws(() => parseUntBatch("x".repeat(30001)), /слишком длинный/);
});

test("matching contacts plus a reversed name resolve a single account", async () => {
  const result = await resolveBatchStudent(entry(), async () => [account]);
  assert.equal(result.status, "matched");
  assert.equal(result.candidates[0].account.id, "account-1");
  assert.deepEqual(result.candidates[0].matchedBy, ["почта", "телефон", "имя"]);
});

test("email and phone pointing to different accounts require an explicit choice", async () => {
  const other = { ...account, id: "account-2", email: "other@example.com" };
  const result = await resolveBatchStudent(entry(), async query => query.includes("@") ? [{ ...account, phoneNumber: "+77001234567" }] : [other]);
  assert.equal(result.status, "choose");
  assert.equal(result.candidates.length, 2);
});

test("matching contacts do not conflict merely because another person has the same name", async () => {
  const result = await resolveBatchStudent(entry(), async query => query.includes("Тестов") ? [account, { ...account, id: "namesake" }] : [account]);
  assert.equal(result.status, "matched");
  assert.equal(result.candidates.length, 1);
});

test("an unmatched supplied contact and name-only lookup both require review", async () => {
  const missingPhone = await resolveBatchStudent(entry(), async query => query.includes("@") || query.includes("Асан") ? [account] : []);
  assert.equal(missingPhone.status, "choose");
  const nameOnly = await resolveBatchStudent(entry({ emails: [], phones: [] }), async () => [account]);
  assert.equal(nameOnly.status, "choose");
});

test("a broad email match is not an identity match and a failed lookup must not look like success", async () => {
  assert.equal((await resolveBatchStudent(entry({ name: "", phones: [] }), async () => [{ ...account, email: "asan2@example.com" }])).status, "not_found");
  await assert.rejects(resolveBatchStudent(entry(), async query => { if (query.includes("@")) return [account]; throw new Error("Phone lookup unavailable"); }), /Phone lookup unavailable/);
});

test("ДТ and БТ are interchangeable in the test-name filter", () => {
  assert.equal(normalizeUntTestQuery("СМАРТ БТ қазан"), normalizeUntTestQuery("СМАРТ ДТ қазан"));
  assert.equal(normalizeUntTestQuery("ҰБТ"), "ұбт");
});
