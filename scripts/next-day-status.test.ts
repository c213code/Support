import assert from "node:assert/strict";
import { test } from "node:test";
import { generateReportText, type ReportIssue } from "../src/lib/report";
import { isIssueStatus, STATUS_META } from "../src/lib/status";

const issue: ReportIssue = {
  groupName: "Әдістеме & IT",
  groupEmoji: null,
  position: 0,
  description: "Мини-тест ашылмай тұр",
  telegramLink: null,
  status: "NEXT_DAY",
  note: null,
  ticketLink: null,
};

test("next-day status is selectable and report uses today's follow-up wording", () => {
  assert.equal(isIssueStatus("NEXT_DAY"), true);
  assert.equal(STATUS_META.NEXT_DAY.label, "На завтра");
  const report = generateReportText([issue], []);
  assert.match(report, /Статус: Бүгін тағы да қарап көреміз⚠️/);
});

test("old note cannot replace the next-day report wording", () => {
  const report = generateReportText([{ ...issue, note: "Ескі статус туралы жазба" }], []);
  assert.match(report, /Статус: Бүгін тағы да қарап көреміз⚠️/);
  assert.doesNotMatch(report, /Ескі статус туралы жазба/);
});

test("other statuses continue to use their ticket note", () => {
  const report = generateReportText([{ ...issue, status: "IN_PROGRESS", note: "Тексеріп жатырмыз" }], []);
  assert.match(report, /Статус: Тексеріп жатырмыз⚠️/);
});
