import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { loadFeaturePacks, matchFeaturePacks, sqlSections, sourceExcerpt, validateAgentAnswer } from "../src/lib/featureAgentKnowledge";

const root = fileURLToPath(new URL("../", import.meta.url));
const backend = process.env.FEATURE_AGENT_CODE_ROOT ?? "/Users/yerasyltoleubek/IdeaProjects/juz40";

test("DV-7952 routes RU/KZ symptoms and exact errors, without taking generic failures", async () => {
  const packs = await loadFeaturePacks(root);
  for (const text of [
    "DV-7952: тест закрыт", "weeklyTheoryLocked=true", "400 weekly_theory_gate_locked",
    "Теория недели пройдена, ОСТ не открывается", "Лекции прошёл, замок остался",
    "Лекцияны қарадым, ОСТ ашылмай тұр", "Теорияны бітірдім, ОСТ ашылмайды",
    "Лекция: дедлайн исчез", "Лекция withDeadline=true, deadline_is_null",
    "Чтобы открыть этот урок, пройдите все уроки «Теориялық сабақ» этой недели",
    "Осы аптадағы барлық «Теориялық сабақтарды» орындаңыз",
  ]) assert.deepEqual(matchFeaturePacks(text, packs).map((pack) => pack.feature), ["weekly-theory-gate-v1"], text);
  for (const text of ["Квиз не открывается", "Дедлайн урока прошёл", "403: не могу открыть видео", "Лекция зависла", "АА пароль қате"])
    assert.deepEqual(matchFeaturePacks(text, packs), [], text);
  assert.deepEqual(matchFeaturePacks("Стрик: weeklyTheoryLocked у задания", packs).map((pack) => pack.feature).sort(),
    ["daily-streak-v1", "weekly-theory-gate-v1"]);
});

test("only selected DV-7952 rules can emit its bounded SELECT templates", async () => {
  const packs = await loadFeaturePacks(root); const pack = packs.find((p) => p.feature === "weekly-theory-gate-v1")!;
  const sections = sqlSections(pack.sql);
  assert.deepEqual([...sections.keys()], ["Q00", "Q00b", "Q01", "Q02", "Q03", "Q04", "Q05", "Q07"]);
  for (const rule of pack.rules) for (const query of rule.query_ids) assert.ok(sections.has(query), `${rule.id}: ${query}`);
  const result = validateAgentAnswer({ status: "need_details", feature: pack.feature, summary: "Проверить теорию",
    draft: "Нужна проверка SUCCESS в данной группе", evidence: [], missingData: [],
    ruleIds: ["WTG-002", "DST-010", "COM-004"], queryIds: ["Q03", "Q07", "Q05", "Q06"], sourcePaths: [] }, packs);
  assert.deepEqual(result.answer.ruleIds, ["WTG-002"]);
  assert.deepEqual(result.answer.queryIds, ["Q03", "Q07"]);
  assert.deepEqual(result.queries.map((q) => q.id), ["Q00", "Q00b", "Q03", "Q07"]);
  assert.ok(result.queries.every((q) => !q.sql.includes("commerce_requests") && !q.sql.includes("student_streak_waivers")));
  assert.match(sections.get("Q03")!, /IS DISTINCT FROM 'SUCCESS'/);
  assert.ok(!sections.get("Q03")!.includes("is_rating ="), "non-rating lectures must still be required");
});

test("manual gate SELECT preserves the exact reviewed canonical predicate", async () => {
  const packs = await loadFeaturePacks(root); const pack = packs.find((p) => p.feature === "weekly-theory-gate-v1")!;
  const source = await readFile(join(backend, "src/main/java/kz/juz40/juz40/domain/course/repository/LessonRepository.java"), "utf8");
  const raw = source.match(/String WEEKLY_THEORY_LOCKED_QUERY = """\n([\s\S]*?)\n\s*""";/)![1];
  let expected = raw.replaceAll("sl.lessonId", ":lesson_id").replaceAll("sl.groupId", ":group_id").replaceAll(":studentId", ":student_id");
  for (const table of ["lessons", "personal_lessons_modifications", "personal_lessons_students", "curator_theme_modifications", "themes", "courses", "groups", "progresses"])
    expected = expected.replace(new RegExp(`(from |join )${table}\\b`, "g"), `$1public.${table}`);
  for (const key of ["student_id", "group_id", "lesson_id"])
    expected = expected.replaceAll(`:${key}`, `CAST(:${key} AS uuid)`);
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const sql = sqlSections(pack.sql).get("Q04")!.replace(/^--[^\n]*$/gm, "");
  assert.equal(normalize(sql), normalize(`SELECT ${expected} AS weekly_theory_locked;`));
});

test("manifest hashes, document copy and bounded backend excerpts match reviewed local sources", async () => {
  const packs = await loadFeaturePacks(root); const pack = packs.find((p) => p.feature === "weekly-theory-gate-v1")!;
  const manifest = JSON.parse(await readFile(join(pack.directory, "sources.json"), "utf8"));
  const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  assert.equal(digest(await readFile(join(pack.directory, "source-document.md"))), manifest.document.sha256);
  const filePaths = new Set<string>();
  for (const file of manifest.files) {
    const content = await readFile(join(backend, file.path));
    assert.equal(digest(content), file.sha256, file.path); filePaths.add(file.path);
  }
  const ranges = new Map<string, Array<{ line: number; end_line: number }>>();
  for (const rule of pack.rules) for (const source of rule.sources) {
    if (source.source !== "backend") continue;
    assert.ok(source.path && source.line && source.end_line);
    assert.ok(filePaths.has(source.path));
    ranges.set(source.path, [...(ranges.get(source.path) ?? []), { line: source.line!, end_line: source.end_line! }]);
  }
  for (const [path, selections] of ranges) {
    const excerpt = sourceExcerpt(await readFile(join(backend, path), "utf8"), selections);
    assert.ok(Buffer.byteLength(excerpt) < 30_000, path);
    if (path.endsWith("LessonRepository.java")) assert.ok(!excerpt.includes("findSupportCandidates"));
  }
});

test("document finishTime promise is explicitly separated from the observed video handler", async () => {
  const packs = await loadFeaturePacks(root); const pack = packs.find((p) => p.feature === "weekly-theory-gate-v1")!;
  const conflict = pack.rules.find((r) => r.id === "WTG-011")!;
  assert.match(conflict.rule, /нет setFinishTime/);
  assert.match(conflict.rule, /не закрывает weekly gate/);
  const source = conflict.sources.find((s) => s.path?.endsWith("StudentProgressAppService.java"))!;
  const excerpt = sourceExcerpt(await readFile(join(backend, source.path!), "utf8"), [{ line: source.line!, end_line: source.end_line! }]);
  assert.ok(excerpt.includes("ProgressStatus.SUCCESS"));
  assert.ok(!excerpt.includes("setFinishTime"));
  const instructions = await readFile(join(pack.directory, "assistant-instructions.md"), "utf8");
  assert.match(instructions, /Обязательный конфликт WTG-011/);
  assert.match(instructions, /Не выполнять|Не выполняй SQL/);
});
