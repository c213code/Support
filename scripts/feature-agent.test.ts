import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activeFeaturePacks, loadFeaturePacks, matchFeaturePacks, sqlSections, validateAgentAnswer, type FeaturePack } from "../src/lib/featureAgentKnowledge";

const pack: FeaturePack = {
  feature: "example-v1", scope: "test", directory: "unused",
  sql: "-- Q00: environment\nSELECT version();\n-- Q00b: schema\nSELECT 1;\n-- Q00c: reserve\nSELECT 2;\n-- Q06: reserve state\nSELECT 3;\n-- Q99: unrelated\nSELECT 4;\n",
  rules: [{ id: "EX-1", title: "Example", rule: "Rule", search_terms: [],
    query_ids: ["Q06"], sources: [{ source: "backend", path: "src/main/java/Example.java" }] }],
};

test("SELECT templates remain linked to an allowed rule, with environment checks", () => {
  const result = validateAgentAnswer({
    status: "need_details", feature: "example-v1", summary: "Check reserve", draft: "Need data",
    evidence: ["Screenshot"], missingData: ["Student"], ruleIds: ["EX-1"],
    queryIds: ["Q06", "Q99"], sourcePaths: ["src/main/java/Example.java", "../../.env"],
  }, [pack]);
  assert.deepEqual(result.answer.queryIds, ["Q06"]);
  assert.deepEqual(result.answer.sourcePaths, ["src/main/java/Example.java"]);
  assert.deepEqual(result.queries.map((query) => query.id), ["Q00", "Q00b", "Q00c", "Q06"]);
  assert.ok(result.queries.every((query) => query.sql.includes("SELECT")));
});

test("unsupported claim cannot become a confident draft", () => {
  const result = validateAgentAnswer({
    status: "draft", feature: "example-v1", summary: "Done", draft: "Payment confirmed",
    evidence: [], missingData: [], ruleIds: ["UNKNOWN"], queryIds: ["Q06"], sourcePaths: [],
  }, [pack]);
  assert.equal(result.answer.status, "need_details");
  assert.deepEqual(result.queries, []);
  assert.ok(!result.answer.draft.includes("Payment confirmed"));
});

test("SQL parser keeps individual templates separate", () => {
  assert.equal(sqlSections(pack.sql).get("Q06"), "-- Q06: reserve state\nSELECT 3;");
  assert.equal(sqlSections("-- Q01: unsafe\nDELETE FROM users;").size, 0);
});

test("unrelated quiz, materials and IELTS tickets do not invoke Commerce", async () => {
  const packs = await loadFeaturePacks(fileURLToPath(new URL("../", import.meta.url)));
  assert.deepEqual(activeFeaturePacks(packs).map((item) => item.feature), ["commerce-v2"]);
  for (const text of [
    "Квиз орындалмайды, 8 оқушының тапсырмасы салынбай қалды. Материалдар ашылмайды.",
    "SMART: мини тест не работает, нет доступа к материалам IELTS",
    "403: не могу открыть видео",
    "Курс не виден",
    "Пришло сообщение success, created, 5000",
    "коммерциализация квиза",
  ]) assert.deepEqual(matchFeaturePacks(text, packs), [], text);
});

test("Commerce payment, replacement and group admission cases are selected in RU/KZ", async () => {
  const packs = await loadFeaturePacks(fileURLToPath(new URL("../", import.meta.url)));
  for (const text of [
    "Оқушының пәнін ауыстырайын деп өтініш берейін десем, ауыспай тұр",
    "Оқушы -ны мат тамыз ағымына қосу (поток ауыстыру)",
    "Оплачено, но нет курса",
    "Заявка одобрена, доступа нет",
    "Предоплата не вернулась",
    "Нет кнопки возврата",
    "Оқушыда пәні шықпай тұр. Ол оқушыны топқа қоспаған",
    "COMMERCE–V2: вопрос по покупке",
  ]) assert.deepEqual(matchFeaturePacks(text, packs).map((item) => item.feature), ["commerce-v2"], text);
});

test("only explicitly connected packs route; new packs use their own routing", () => {
  const enabled = { ...pack, routing: { enabled: true, any: ["новый квиз"], all: [] } };
  const disabled = { ...enabled, feature: "disabled-v1", routing: { ...enabled.routing, enabled: false } };
  assert.deepEqual(matchFeaturePacks("новый квиз", [pack, enabled, disabled]).map((item) => item.feature), ["example-v1"]);
  assert.deepEqual(matchFeaturePacks("старый квиз", [enabled]), []);
  assert.deepEqual(matchFeaturePacks("", [enabled]), []);
});
