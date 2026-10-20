import assert from "node:assert/strict";
import test from "node:test";
import { generateReportText, type ReportIssue } from "../src/lib/report";
import { splitReport } from "../src/lib/reportSplit";

const issue: ReportIssue = {
  id: "ticket", groupName: "Support <1>", groupEmoji: "🛠", position: 0,
  description: "Ошибка <входа> & пароль", telegramLink: "https://t.me/test/1",
  status: "PENDING", note: null, ticketLink: null,
};
const options = { compact: true, reportDate: "2026-10-20", dutyName: "Ерош & Алпа" };

test("compact report keeps summary visible and escapes collapsed details", () => {
  const issues: ReportIssue[] = [issue, { ...issue, status: "RESOLVED" }, { ...issue, status: "SENT" }];
  const html = generateReportText(issues, [], { ...options, format: "html", footer: ["Сделано с помощью Support Reports"] });
  const [summary, details] = html.split("<blockquote expandable>");
  assert.match(summary, /Репорт за 2026-10-20/);
  assert.match(summary, /Дежурные: Ерош, Алпа/);
  assert.match(summary, /Всего в репорте: 2/);
  assert.doesNotMatch(summary, /Support/);
  assert.match(details, /Support &lt;1&gt;🛠/);
  assert.match(summary, /Решено: 1 · Пендинг: 1 · В работе: 0 · На завтра: 0 · Передано: 0/);
  assert.doesNotMatch(summary, /Ошибка/);
  assert.match(details, /Ошибка &lt;входа&gt; &amp; пароль/);
  assert.match(details, /<\/blockquote>[\s\S]*Сделано с помощью/);
  const plain = generateReportText(issues, [], options);
  assert.match(plain, /Всего в репорте: 2/);
  assert.match(plain, /Ошибка <входа> & пароль/);
});

test("weekends retain the inferred duty agent", () => {
  const html = generateReportText([issue], [], { ...options, reportDate: "2026-10-18", format: "html" });
  assert.match(html, /Дежурный \(по активности\): Ерош &amp; Алпа/);
});

test("IELTS is excluded from details and totals in both formats", () => {
  for (const format of ["html", "plain"] as const) {
    const excluded = ["IELTS", " ielts ", "IELTS🎓"].map((groupName) => ({ ...issue, groupName, description: "IELTS-only issue", status: "RESOLVED" as const }));
    const text = generateReportText([issue, ...excluded], [], { ...options, format });
    assert.match(text, /Всего в репорте: 1/);
    assert.match(text, /Решено: 0 · Пендинг: 1/);
    assert.doesNotMatch(text, /IELTS/i);
    assert.equal(generateReportText(excluded, [], { ...options, format, footer: ["Footer"] }), "");
  }
});

test("empty and SENT-only reports stay empty even with summary and footer", () => {
  for (const issues of [[], [{ ...issue, status: "SENT" as const }]]) {
    assert.equal(generateReportText(issues, [], { ...options, format: "html", footer: ["Footer"] }), "");
  }
});

test("long reports preserve all text, links, entities and balanced tags in each part", () => {
  const html = generateReportText(Array.from({ length: 30 }, (_, position) => ({
    ...issue, position, description: "Описание & <ошибка> 🛠 ".repeat(35),
  })), [], {
    ...options, format: "html", ticketCode: () => "ABC123", ticketUrl: () => "https://example.com/ticket?a=1&b=2",
  });
  const parts = splitReport(html, "html");
  assert.ok(parts.length > 2);
  const stripTags = (text: string) => text.replace(/<[^>]*>/g, "");
  assert.equal(parts.map(stripTags).join(""), stripTags(html));
  for (const part of parts) {
    assert.ok(part.length <= 3900);
    const stack: string[] = [];
    for (const match of part.matchAll(/<(\/?)([\w-]+)[^>]*>/g)) {
      if (match[1]) assert.equal(stack.pop(), match[2]);
      else stack.push(match[2]);
    }
    assert.deepEqual(stack, []);
    assert.doesNotMatch(stripTags(part), /&(?!amp;|lt;|gt;|quot;)/);
  }
});

test("a single oversized line loses no text or emoji", () => {
  const text = "🛠длинная строка".repeat(900);
  const parts = splitReport(text);
  assert.equal(parts.join(""), text);
  assert.ok(parts.every((part) => part.length <= 3900 && !/[\uD800-\uDBFF]$/.test(part)));
});
