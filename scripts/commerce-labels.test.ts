import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDetails, extractContact, findLabel, labelsForGroup, missingFields, requiredPhotos } from "../src/lib/submissionLabels";

const group = "IT + Сервис";
const label = () => {
  const found = findLabel(group, "new-payments");
  assert.ok(found, "Missing service label: new-payments");
  return found;
};
const base = { studentKind: "email", studentEmail: "student@example.test", formAttempt: "no" };

test("type is asked first and nothing else is required before it", () => {
  assert.equal(label().fields[0].id, "commerceType");
  assert.deepEqual(missingFields(label(), {}, 0), ["commerceType", "studentKind", "formAttempt"]);
});

test("credit grant needs only amount and basis; screenshot stays optional", () => {
  const values = { ...base, commerceType: "credit-add", creditAmount: "8000", creditBasis: "overpaid" };
  assert.deepEqual(missingFields(label(), values, 0), []);
  assert.equal(requiredPhotos(label(), values), 0);
  assert.deepEqual(missingFields(label(), { ...values, creditBasis: "" }, 0), ["creditBasis"]);
  assert.equal(extractContact(values), "student@example.test");
});

test("credit removal asks for the balance that must remain", () => {
  const values = { ...base, commerceType: "credit-remove", creditAmount: "25000" };
  assert.deepEqual(missingFields(label(), values, 0), ["creditLeft"]);
  assert.deepEqual(missingFields(label(), { ...values, creditLeft: "5000" }, 0), []);
});

test("transfer needs both ends, month, group, renewal, old months and money outcome", () => {
  const values = { ...base, commerceType: "transfer" };
  assert.deepEqual(missingFields(label(), values, 0), [
    "fromStreams", "toStreams", "billedMonth", "targetGroup", "nextRenewal", "oldMonthsOpen", "moneyOutcome",
  ]);
  const full = { ...values, fromStreams: "SMART PRO ГЕО-МАТ ТАМЫЗ", toStreams: "Гео шілде, Мат шілде, Тарих тамыз, Геом қазан",
    billedMonth: "қазан 2026", targetGroup: "кез келген", nextRenewal: "no", oldMonthsOpen: "yes", moneyOutcome: "same" };
  assert.deepEqual(missingFields(label(), full, 0), []);
  assert.match(buildDetails(label(), full), /Жоқ, продлениесіз/);
});

test("switching type hides the previous branch so stale answers do not leak", () => {
  const stale = { ...base, commerceType: "credit-add", creditAmount: "8000", creditBasis: "overpaid" };
  const switched = { ...stale, commerceType: "free", streams: "TOEFL ITP ҚАРАША", billedMonth: "қараша 2026",
    targetGroup: "fmPIQ", freeReason: "grant" };
  assert.deepEqual(missingFields(label(), switched, 0), []);
  const details = buildDetails(label(), switched);
  assert.doesNotMatch(details, /8000/);
  assert.doesNotMatch(details, /Артық төлеген/);
});

test("price and paid-but-closed require a screenshot, the rest do not", () => {
  const price = { ...base, commerceType: "price", streams: "SMART PRO ӘДЕБ-ТІЛ", billedMonth: "қараша 2026",
    shownAmount: "52000", expectedAmount: "44000", pricingReason: "55 000 − 20%" };
  assert.equal(requiredPhotos(label(), price), 1);
  assert.deepEqual(missingFields(label(), price, 0), ["photos"]);
  assert.deepEqual(missingFields(label(), price, 1), []);
  assert.equal(requiredPhotos(label(), { ...base, commerceType: "check", checkQuestion: "кредит қайда?" }), 0);
});

test("a failed form attempt requires a screenshot of the error, not typed text", () => {
  const values = { ...base, commerceType: "check", checkQuestion: "кредит қайда кетті?", formAttempt: "error" };
  assert.equal(requiredPhotos(label(), values), 1);
  assert.deepEqual(missingFields(label(), values, 0), ["photos"]);
  assert.deepEqual(missingFields(label(), values, 1), []);
});

test("refund keeps paid amount, date, refund amount and the exit date", () => {
  const values = { ...base, commerceType: "refund" };
  assert.deepEqual(missingFields(label(), values, 0), [
    "streams", "billedMonth", "paidAmount", "paidAt", "refundAmount", "refundReason",
  ]);
});

test("new label lives only in the service group, old fallbacks stay", () => {
  for (const other of ["Сату - Платформа", "Әдістеме & IT", "IT & Product"]) {
    assert.equal(findLabel(other, "new-payments"), null);
  }
  for (const id of ["payment", "catalog", "discount", "other"]) assert.ok(findLabel(group, id));
  const ids = labelsForGroup(group).map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
});
