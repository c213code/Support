import assert from "node:assert/strict";
import test from "node:test";
import { generateReportMessages, generateReportText, reportMessageLength, type ReportIssue } from "../src/lib/report";

const options = { reportDate: "2026-10-19", ticketCode: (id: string) => id, ticketUrl: (id: string) => `https://example.com/issue/${id}`, footer: ["Footer"] };
function issue(id: string, groupName: string, length = 100): ReportIssue {
  return { id, groupName, groupEmoji: "🎲", position: Number(id), description: `START-${id} ${"Текст & <ошибка> 🛠 ".repeat(length)} END-${id}`,
    telegramLink: `https://t.me/test/${id}`, status: "PENDING", note: `NOTE-${id}`, ticketLink: null };
}
function checkParts(parts: string[]) {
  for (const part of parts) {
    assert.ok(reportMessageLength(part) <= 3900);
    const stack: string[] = [];
    for (const tag of part.matchAll(/<(\/?)([\w-]+)[^>]*>/g)) {
      if (tag[1]) assert.equal(stack.pop(), tag[2]);
      else stack.push(tag[2]);
    }
    assert.deepEqual(stack, []);
    assert.doesNotMatch(part.replace(/<[^>]*>/g, ""), /&(?!amp;|lt;|gt;|quot;)/);
  }
}

test("small groups share one expandable block with summary first and footer last", () => {
  const parts = generateReportMessages([issue("1", "First", 2), issue("2", "Second", 2)], [], options);
  assert.equal(parts.length, 1);
  assert.match(parts[0], /Всего в репорте: 2/);
  assert.match(parts[0], /<blockquote expandable>First🎲/);
  assert.match(parts[0], /Second🎲/);
  assert.equal(parts[0].match(/<blockquote/g)?.length, 1);
  assert.ok(parts[0].endsWith("Footer"));
  checkParts(parts);
});

// Both following groups must be packed after the continuation, not sent alone.
test("a large group starts fresh and its continuation shares space with later small groups", () => {
  const issues = [issue("1", "Before", 2), ...Array.from({ length: 5 }, (_, i) => issue(String(i + 2), "Service", 55)), issue("7", "After", 2), issue("8", "Last", 2)];
  const parts = generateReportMessages(issues, [], options);
  const firstService = parts.findIndex(p => p.includes("Service🎲"));
  assert.ok(firstService > 0);
  assert.doesNotMatch(parts[firstService], /Before/);
  const continuation = parts.find(p => p.includes("Service🎲 (продолжение)") && p.includes("After🎲"));
  assert.ok(continuation);
  assert.match(continuation, /Last🎲/);
  assert.equal(continuation.match(/<blockquote/g)?.length, 1);
  for (const ticket of issues) {
    const containing = parts.filter(p => p.includes(`START-${ticket.id} `));
    assert.equal(containing.length, 1);
    assert.ok(containing[0].includes(`END-${ticket.id}`));
    assert.ok(containing[0].includes(`NOTE-${ticket.id}`));
  }
  checkParts(parts);
});

test("link markup does not waste Telegram's visible-text budget", () => {
  const tickets = [issue("1", "First", 2), issue("2", "Second", 2)];
  const parts = generateReportMessages(tickets, [], { ...options, ticketUrl: id => `https://example.com/${"long-path/".repeat(250)}${id}` });
  assert.equal(parts.length, 1);
  assert.ok(parts[0].length > 4096);
  checkParts(parts);
});

test("large groups split only between complete tickets and repeat the heading", () => {
  const issues = Array.from({ length: 7 }, (_, i) => issue(String(i + 1), "Large", 55));
  const parts = generateReportMessages(issues, [], options);
  assert.ok(parts.length > 2);
  const detailParts = parts.filter(p => p.includes("<blockquote"));
  assert.match(detailParts[0], /<blockquote expandable>Large🎲\n/);
  for (const part of detailParts.slice(1)) assert.match(part, /<blockquote expandable>Large🎲 \(продолжение\)/);
  for (const ticket of issues) {
    const containing = parts.filter(part => part.includes(`START-${ticket.id}`));
    assert.equal(containing.length, 1);
    const expected = generateReportText([ticket], [], { ...options, format: "html", footer: [] })
      .slice("Large🎲\n\n".length).replace(/^1\./, `${ticket.position}.`);
    assert.ok(containing[0].includes(expected), `Ticket ${ticket.id} must be intact, including links and status`);
  }
  checkParts(parts);
});

test("a group that fits alone moves intact when it cannot fit beside the summary", () => {
  let ticket = issue("1", "Whole", 1);
  while (generateReportMessages([ticket], [], options).length === 1) {
    ticket = { ...ticket, description: `${ticket.description} ${"текст ".repeat(10)}` };
  }
  const parts = generateReportMessages([ticket], [], options);
  assert.equal(parts.length, 2);
  assert.doesNotMatch(parts[0], /blockquote/);
  assert.match(parts[1], /<blockquote expandable>Whole🎲/);
  assert.doesNotMatch(parts[1], /продолжение/);
  checkParts(parts);
});

test("an oversized single ticket becomes a complete card linking to its full text", () => {
  const parts = generateReportMessages([issue("1", "Huge", 2000)], [], options);
  const text = parts.join("\n");
  assert.match(text, /href="https:\/\/example.com\/issue\/1"/);
  assert.match(text, /Полный текст — по ссылке выше/);
  assert.match(text, /Статус: Пендинг/);
  checkParts(parts);
});

test("excluded and empty reports produce no messages", () => {
  assert.deepEqual(generateReportMessages([], [], options), []);
  assert.deepEqual(generateReportMessages([issue("1", "IELTS"), { ...issue("2", "Support"), status: "SENT" }], [], options), []);
});
