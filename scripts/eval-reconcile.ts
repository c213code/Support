// Прогон вечернего разбора (lib/dayReconcile.ts) на прошлых днях: насколько
// модель угадывает статус, который дежурные проставили руками.
//
//   npm run eval:reconcile -- --models=gemini:gemini-3.8-flash,groq --limit=60
//   npm run eval:reconcile -- --models=openrouter:deepseek/deepseek-v4.1-flash,groq
//
// Эталон — финальный статус тикета в базе. Он шумный: тикет могли закрыть и
// через три дня, а бывает, что закрыли без единой реплики в чате. Поэтому в
// выборку идут только тикеты с перепиской агентов, и главная метрика —
// «решено / не решено», а не точное совпадение из пяти статусов.
//
// Самое дорогое — ложное «решено»: такой тикет уйдёт в репорт боссам как
// сделанный. Поэтому отдельно считаем точность RESOLVED.
import { writeFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { collectResolutionContext } from "@/lib/resolutionNote";
import { GROQ_MODEL } from "@/lib/ai";
import {
  reconcileIssue,
  type ReconcileProvider,
  type ReconcileResult,
} from "@/lib/dayReconcile";

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const FROM = arg("from", "2026-09-01");
const TO = arg("to", "2026-09-15");
const LIMIT = Number(arg("limit", "60"));
const DELAY_MS = Number(arg("delay", "4000"));
const OUT = arg("out", "");
// --set=dev — другая, не пересекающаяся выборка того же размера: на ней
// подбирают промпт, а итог проверяют на обычной (test). Иначе правила
// подгоняются под те самые тикеты, по которым их потом оценивают.
const SET = arg("set", "test");
const PROVIDERS: ReconcileProvider[] = arg("models", "gemini:gemini-3.8-flash,groq")
  .split(",")
  .map((spec) => {
    // Модель — всё после первого двоеточия: у OpenRouter бывают «…:batch».
    const cut = spec.indexOf(":");
    const kind = cut < 0 ? spec : spec.slice(0, cut);
    const model = cut < 0 ? "" : spec.slice(cut + 1);
    if (kind === "groq") return { kind: "groq", model: "groq" };
    if (kind === "openrouter") return { kind: "openrouter", model };
    return { kind: "gemini", model: model || "gemini-3.8-flash" };
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Бесплатный уровень Gemini отвечает 429 при частых запросах, а свежие
// модели — 503 «high demand» в часы пик. Это не ошибки модели, а очередь:
// ждём и повторяем, иначе прогон мерил бы загрузку Google, а не качество.
const TRANSIENT = /^(429|500|503)|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|overloaded|quota/i;
async function withRetry(call: () => Promise<ReconcileResult>): Promise<ReconcileResult> {
  let result = await call();
  for (let attempt = 1; attempt <= 4 && !result.ok && TRANSIENT.test(result.error); attempt++) {
    await sleep(15_000 * attempt);
    result = await call();
  }
  // Как в проде (stepRun): любой сбой, кроме квоты, — ещё один повтор.
  if (!result.ok && !/^429|quota|RESOURCE_EXHAUSTED/i.test(result.error)) {
    await sleep(15_000);
    result = await call();
  }
  return result;
}

// Детерминированное перемешивание: один и тот же прогон — одна и та же выборка.
function stableKey(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

(async () => {
  // Локальная копия базы без OWN_AGENT_TELEGRAM_IDS не знает, кто «свои».
  // Берём тех, чьи реплики вебхук уже привязывал как агентские.
  if (!process.env.OWN_AGENT_TELEGRAM_IDS && !process.env.AGENT_TELEGRAM_IDS) {
    const agents = await prisma.telegramMessage.groupBy({
      by: ["fromId"],
      where: { agentIssueId: { not: null }, fromId: { not: null } },
    });
    process.env.OWN_AGENT_TELEGRAM_IDS = agents.map((a) => String(a.fromId)).join(",");
    console.log(`агенты взяты из базы: ${agents.length}`);
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate: { gte: FROM, lte: TO } },
    select: { id: true, description: true, status: true, note: true, reportDate: true },
  });
  const withContext: Array<(typeof issues)[number] & { agentTexts: string[]; exact: boolean }> = [];
  for (const issue of issues) {
    const ctx = await collectResolutionContext(issue.id);
    // Только точно привязанные реплики: найденные догадкой по окну времени
    // могут быть о соседнем тикете, и такой промах был бы не на совести
    // модели. В проде разбор так же судит только по точным.
    if (ctx.ok && ctx.context.exact) {
      withContext.push({ ...issue, agentTexts: ctx.context.agentTexts, exact: true });
    }
  }
  // Поровну решённых и нерешённых — иначе при 60% «решено» модель, которая
  // на всё отвечает RESOLVED, выглядела бы неплохо.
  const resolved = withContext.filter((i) => i.status === "RESOLVED").sort((a, b) => stableKey(a.id) - stableKey(b.id));
  const open = withContext.filter((i) => i.status !== "RESOLVED").sort((a, b) => stableKey(a.id) - stableKey(b.id));
  const half = Math.floor(LIMIT / 2);
  const skipResolved = SET === "dev" ? half : 0;
  const skipOpen = SET === "dev" ? LIMIT - half : 0;
  const sample = [
    ...resolved.slice(skipResolved, skipResolved + half),
    ...open.slice(skipOpen, skipOpen + LIMIT - half),
  ];
  console.log(
    `тикетов ${FROM}…${TO}: ${issues.length}, с точно привязанной перепиской: ${withContext.length} ` +
      `(решено ${resolved.length}, открыто ${open.length}); в прогоне: ${sample.length} (${SET})\n`
  );

  const report: Record<string, unknown[]> = {};
  const summary: string[] = [];
  for (const provider of PROVIDERS) {
    const name = provider.kind === "groq" ? `groq (${GROQ_MODEL})` : provider.model;
    const rows: Array<{ id: string; truth: string; got: string | null; note: string; evidence: string; agentNote: string | null; error?: string; ms: number; inTok: number; outTok: number; cost: number }> = [];
    for (const [index, issue] of sample.entries()) {
      const result = await withRetry(() => reconcileIssue(provider, issue.description, issue.agentTexts));
      rows.push({
        id: issue.id,
        truth: issue.status,
        got: result.ok ? result.verdict.status : null,
        note: result.ok ? result.verdict.note : "",
        evidence: result.ok ? result.verdict.evidence : "",
        agentNote: issue.note,
        error: result.ok ? undefined : result.error,
        ms: result.ms,
        inTok: result.ok ? (result.usage?.inputTokens ?? 0) : 0,
        outTok: result.ok ? (result.usage?.outputTokens ?? 0) : 0,
        cost: result.ok ? (result.usage?.costUsd ?? 0) : 0,
      });
      process.stdout.write(`\r${name}: ${index + 1}/${sample.length}`);
      await sleep(DELAY_MS);
    }
    process.stdout.write("\n");

    const answered = rows.filter((r) => r.got !== null);
    const truthResolved = (r: (typeof rows)[number]) => r.truth === "RESOLVED";
    const saidResolved = (r: (typeof rows)[number]) => r.got === "RESOLVED";
    const tp = answered.filter((r) => truthResolved(r) && saidResolved(r)).length;
    const fp = answered.filter((r) => !truthResolved(r) && saidResolved(r)).length;
    const fn = answered.filter((r) => truthResolved(r) && !saidResolved(r)).length;
    const binaryOk = answered.filter((r) => truthResolved(r) === saidResolved(r)).length;
    const unclear = answered.filter((r) => r.got === "UNCLEAR").length;
    const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "—");
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

    summary.push(
      [
        name.padEnd(22),
        `верно ${pct(binaryOk, answered.length)}`.padEnd(12),
        `«решено» точно ${pct(tp, tp + fp)} (ложных ${fp})`.padEnd(28),
        `находит решённые ${pct(tp, tp + fn)}`.padEnd(20),
        `«непонятно» ${unclear}`.padEnd(14),
        `ошибок ${rows.length - answered.length}`.padEnd(10),
        `~${avg(answered.map((r) => r.ms))} мс`.padEnd(10),
        `токенов/тикет ~${avg(answered.map((r) => r.inTok))}+${avg(answered.map((r) => r.outTok))}`,
        // Цену сообщает только OpenRouter; у остальных тут пусто.
        ...(rows.some((r) => r.cost > 0)
          ? [`$${rows.reduce((a, r) => a + r.cost, 0).toFixed(4)} за прогон`]
          : []),
      ].join(" ")
    );
    report[name] = rows;

    console.log(`\n── ${name}: заметки модели рядом с тем, что написал дежурный ──`);
    for (const r of answered.filter((x) => x.truth === "RESOLVED" && x.got === "RESOLVED").slice(0, 6)) {
      console.log(`  модель: «${r.note}»  | дежурный: «${(r.agentNote ?? "").slice(0, 60)}»`);
    }
    console.log(`── ${name}: ложные «решено» (эталон — не решено) ──`);
    for (const r of answered.filter((x) => x.truth !== "RESOLVED" && x.got === "RESOLVED").slice(0, 5)) {
      console.log(`  [${r.truth}] «${r.note}» ← «${r.evidence.slice(0, 80)}»`);
    }
    const errors = rows.filter((r) => r.error).slice(0, 3);
    for (const r of errors) console.log(`  ошибка: ${r.error}`);
  }

  console.log("\n════════ итог ════════");
  for (const line of summary) console.log(line);
  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ from: FROM, to: TO, sample: sample.length, report }, null, 2));
    console.log(`\nподробности: ${OUT}`);
  }
  process.exit(0);
})();
