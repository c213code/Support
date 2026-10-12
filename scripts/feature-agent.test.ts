import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { activeFeaturePacks, loadFeaturePacks, matchFeaturePacks, sourceExcerpt, sqlSections, validateAgentAnswer, type FeaturePack } from "../src/lib/featureAgentKnowledge";

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
  assert.deepEqual(activeFeaturePacks(packs).map((item) => item.feature).sort(), ["commerce-v2", "daily-streak-v1", "weekly-theory-gate-v1"]);
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

test("Daily Streak routing recognizes RU/KZ names without capturing generic work", async () => {
  const packs = await loadFeaturePacks(fileURLToPath(new URL("../", import.meta.url)));
  for (const text of [
    "Daily Streak: воскресная цель требует 4 вместо всего долга",
    "Стрик обнулился, кнопка восстановления серая",
    "Менің Жұлдызым: Сынақ ҰБТ тапсырдым, күн жабылды ма?",
    "Бүгінгі мақсат орындалды, жұлдыз өспеді",
    "Моя звезда: выполнены просроченные, остальные нет",
  ]) assert.deepEqual(matchFeaturePacks(text, packs).map((item) => item.feature), ["daily-streak-v1"], text);
  for (const text of ["Сынақ ҰБТ не открывается", "Жексенбі материалы шықпай тұр", "Дедлайн урока прошёл", "Жұлдызайдың тапсырмасы жоқ"])
    assert.deepEqual(matchFeaturePacks(text, packs), [], text);
  assert.deepEqual(matchFeaturePacks("Стрик после замены предметов", packs).map((item) => item.feature).sort(), ["commerce-v2", "daily-streak-v1"]);
});

test("Daily Streak diagnostics remain isolated from Commerce and survive the SELECT gate", async () => {
  const packs = await loadFeaturePacks(fileURLToPath(new URL("../", import.meta.url)));
  const streak = packs.find((item) => item.feature === "daily-streak-v1")!;
  assert.deepEqual([...sqlSections(streak.sql).keys()], ["Q00", "Q00b", "Q01", "Q02", "Q03", "Q04", "Q05"]);
  const result = validateAgentAnswer({status: "need_details", feature: streak.feature,
    summary: "Проверить восстановление", draft: "Нужна дата конца разрыва", evidence: [], missingData: [],
    ruleIds: ["DST-010", "COM-004"], queryIds: ["Q03", "Q04", "Q06"], sourcePaths: []}, packs);
  assert.deepEqual(result.answer.ruleIds, ["DST-010"]);
  assert.deepEqual(result.answer.queryIds, ["Q03", "Q04"]);
  assert.deepEqual(result.queries.map((query) => query.id), ["Q00", "Q00b", "Q03", "Q04"]);
  assert.ok(result.queries.some((query) => query.sql.includes("student_streak_waivers")));
  assert.ok(result.queries.every((query) => !query.sql.includes("commerce_requests")));
});

test("source excerpts include only requested ranges, merge overlap and reject stale ranges", () => {
  const content = "unrelated before\nfirst method\nshared line\nsecond method\nunrelated after";
  const excerpt = sourceExcerpt(content, [{ line: 2, end_line: 3 }, { line: 3, end_line: 4 }]);
  assert.match(excerpt, /original source lines 2-4/);
  assert.match(excerpt, /first method\nshared line\nsecond method/);
  assert.ok(!excerpt.includes("unrelated"));
  assert.throws(() => sourceExcerpt(content, [{ line: 0, end_line: 3 }]));
  assert.throws(() => sourceExcerpt(content, [{ line: 3, end_line: 6 }]));
});
