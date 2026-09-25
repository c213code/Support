import { prisma } from "@/lib/prisma";
import { dayRangeUtc, shiftDateString } from "@/lib/date";
import type { IssueStatus } from "@/lib/status";
import { changeIssueStatus } from "@/lib/issueStatus";
import { collectResolutionContext, resolverName } from "@/lib/resolutionNote";
import { findResolvedSiblings, findSplitOriginal, type ResolvedSibling } from "@/lib/relatedIssue";
import { buildUserText, reconcileIssue, type ReconcileProvider } from "@/lib/dayReconcile";

// «Авто-репорт» по кнопке на доске: запуск, пошаговый разбор и применение.
//
// Разбор идёт шагами по несколько тикетов, а не одним запросом на весь день:
// на тикет уходит 3–8 секунд модели, и тридцать тикетов одним вызовом
// упёрлись бы в лимит функции Vercel, а человек смотрел бы на вечный
// спиннер. Шагами — и прогресс виден, и ничего не обрывается.
//
// Ничего не меняется само. Статус тикета меняется только в applyVerdicts —
// когда человек отметил решения и нажал «Применить».

// Модель разбора — переменной RECONCILE_MODEL: «gemini:<модель>» (нужен
// GEMINI_REPORT_KEY), «openrouter:<модель>» (нужен OPENROUTER_API_KEY) или
// «groq».
// Запасная модель для повтора: другая, чем основная, чтобы сбой одной не
// оставлял тикет с «ИИ не ответил». RECONCILE_FALLBACK — «openrouter:<модель>»,
// «groq» или «none»; по умолчанию DeepSeek Flash через OpenRouter (дешёвый и
// на наших тикетах почти не хуже MiMo), без ключа OpenRouter — Groq.
export function fallbackProvider(primary: ReconcileProvider): ReconcileProvider | null {
  const spec = process.env.RECONCILE_FALLBACK?.trim();
  if (spec === "none") return null;
  const candidate: ReconcileProvider | null =
    spec === "groq"
      ? { kind: "groq", model: "groq" }
      : process.env.OPENROUTER_API_KEY
        ? {
            kind: "openrouter",
            model: spec?.startsWith("openrouter:")
              ? spec.slice("openrouter:".length)
              : "deepseek/deepseek-v4.1-flash",
          }
        : process.env.GROQ_API_KEY
          ? { kind: "groq", model: "groq" }
          : null;
  if (!candidate) return null;
  if (candidate.kind !== primary.kind || candidate.model !== primary.model) return candidate;
  // Запасная совпала с основной — тогда Groq, если основная не он.
  return primary.kind !== "groq" && process.env.GROQ_API_KEY ? { kind: "groq", model: "groq" } : null;
}

export function reconcileProvider(): ReconcileProvider {
  const spec = process.env.RECONCILE_MODEL?.trim();
  if (spec === "groq") return { kind: "groq", model: "groq" };
  if (spec?.startsWith("gemini:") && process.env.GEMINI_REPORT_KEY) {
    return { kind: "gemini", model: spec.slice("gemini:".length) };
  }
  if (spec?.startsWith("openrouter:") && process.env.OPENROUTER_API_KEY) {
    return { kind: "openrouter", model: spec.slice("openrouter:".length) };
  }
  // По умолчанию — Groq, которым проект уже пользуется. Бесплатный ключ
  // Gemini упирается в дневную квоту (429) посреди разбора, поэтому Gemini
  // включается только явно: RECONCILE_MODEL=gemini:gemini-flash-latest.
  return { kind: "groq", model: "groq" };
}

function providerLabel(provider: ReconcileProvider): string {
  return provider.kind === "groq" ? "groq" : `${provider.kind}:${provider.model}`;
}

// Какие тикеты разбирать: все нерешённые тикеты дня. «Отправлено» тоже —
// часто по нему уже ответили в чате, просто карточку не тронули.
// Сколько дней назад ещё смотрим на незакрытые тикеты, по которым в
// разбираемый день была переписка.
const CARRY_OVER_DAYS = 7;

export async function startRun(reportDate: string, startedBy: string) {
  const today = await prisma.issue.findMany({
    where: { reportDate, status: { not: "RESOLVED" } },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  // Плюс вчерашние (и старше, до недели) незакрытые тикеты, по которым в
  // ЭТОТ день писали в чате. Иначе ответ дежурного на вчерашнее обращение
  // («<почта> <пароль> — осымен кіреді» 25.09 на тикет от 24.09) не видел
  // ни один разбор: вчерашний уже прошёл, а сегодняшний берёт только
  // сегодняшние тикеты.
  const { start, end } = dayRangeUtc(reportDate);
  const earlier = await prisma.issue.findMany({
    where: {
      reportDate: { gte: shiftDateString(reportDate, -CARRY_OVER_DAYS), lt: reportDate },
      status: { not: "RESOLVED" },
      OR: [
        { sourceMessages: { some: { receivedAt: { gte: start, lt: end } } } },
        { agentReplies: { some: { receivedAt: { gte: start, lt: end } } } },
      ],
    },
    select: { id: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const issues = [...earlier, ...today];
  return prisma.reconcileRun.create({
    data: {
      reportDate,
      startedBy,
      model: providerLabel(reconcileProvider()),
      finishedAt: issues.length === 0 ? new Date() : null,
      verdicts: {
        create: issues.map((issue) => ({ issueId: issue.id, statusBefore: issue.status })),
      },
    },
  });
}

// Почему тикет пропущен — словами для окна, а не кодом.
const SKIP_REASON: Record<"no-agent-ids" | "no-issue-messages" | "no-agent-messages", string> = {
  "no-agent-ids": "не задан список агентов (OWN_AGENT_TELEGRAM_IDS) — своих реплик не отличить",
  "no-issue-messages": "к тикету не привязано ни одного сообщения из чата",
  "no-agent-messages": "в чате по нему никто из агентов не отвечал",
};

// Чьё имя пойдёт в «X шешті». Решено по соседней группе (цитата — из её
// решения) — решал тот, кто решал там: «Тикош шешті, …» в заметке соседа.
// Иначе — кто ответил в этом чате; без точной переписки — никто (подставится
// тот, кто применит).
function resolverFor(
  verdict: { status: string; evidence: string },
  siblings: ResolvedSibling[],
  context: Awaited<ReturnType<typeof collectResolutionContext>>
): string | null {
  if (verdict.status === "RESOLVED" && verdict.evidence) {
    const source = siblings.find((s) => s.note?.includes(verdict.evidence));
    const name = source?.note?.match(/^\s*([^,]+?)\s+шешті/)?.[1];
    if (source) return name ?? null;
  }
  return context.ok && context.context.exact ? resolverName(context.context) : null;
}

type PendingVerdict = { id: string; issueId: string; issue: { description: string } };

// Суждение по одному тикету запуска — пишет результат в его строку журнала.
async function judgeVerdict(verdict: PendingVerdict, provider: ReconcileProvider): Promise<void> {
  const context = await collectResolutionContext(verdict.issueId);
  // Та же общая поломка могла быть решена в другой группе (см.
  // findResolvedSiblings) — тогда есть о чём судить даже без нашего ответа
  // в этом чате: часто здесь и не отвечали, ответили там.
  const siblings = await findResolvedSiblings(verdict.issueId);
  // Не продолжение ли это другого открытого тикета того же автора — тогда
  // окно предложит объединить (как тикеты Амины за 24 и 25.09).
  const mergeTargetId = (await findSplitOriginal(verdict.issueId))?.id ?? null;
  const thread = context.ok && context.context.exact ? context.context.thread : [];
  // Судим только по точно привязанным репликам: найденные догадкой по окну
  // времени могут быть о соседнем тикете, а ошибка тут уходит в репорт.
  if ((!context.ok || !context.context.exact) && siblings.length === 0) {
    // updateMany, а не update: тикет могли объединить посреди разбора, и его
    // строка журнала ушла каскадом — тогда писать некуда, и это не ошибка.
    await prisma.reconcileVerdict.updateMany({
      where: { id: verdict.id },
      data: {
        state: "skipped",
        proposed: "UNCLEAR",
        error: context.ok ? "переписка найдена только догадкой — судить рискованно" : SKIP_REASON[context.reason],
        mergeTargetId,
      },
    });
    return;
  }

  // Что видела модель — в журнал: по нему ошибка разбора видна сразу.
  const input = buildUserText(verdict.issue.description, thread, siblings);
  let result = await reconcileIssue(provider, verdict.issue.description, thread, siblings);
  // Сетевой сбой, «модель перегружена» (503), пустой ответ и минутный лимит
  // Groq проходят сами — один повтор (на прогонах по прошлым дням так падало
  // 2–14% запросов). Groq считает лимит поминутно (8000 токенов на ключ,
  // с рассуждениями high это 3 тикета) — ему пауза 15 секунд; у остальных
  // сбой случайный, хватит 3. Исчерпанную дневную квоту Gemini повтор не
  // спасёт: такой тикет помечается ошибкой, его можно разобрать заново позже.
  //
  // Повтор — к запасной модели (fallbackProvider): у MiMo бывают серии пустых
  // ответов, и повтор к ней же 25.09 дважды подряд вернул пусто по тикету,
  // который она же через минуту разобрала верно.
  let answeredBy: ReconcileProvider = provider;
  if (!result.ok && !/^429|quota|RESOURCE_EXHAUSTED/i.test(result.error)) {
    const retry = fallbackProvider(provider) ?? provider;
    await new Promise((resolve) => setTimeout(resolve, retry.kind === "groq" ? 15_000 : 3000));
    result = await reconcileIssue(retry, verdict.issue.description, thread, siblings);
    answeredBy = retry;
  }
  if (result.ok && answeredBy !== provider) {
    result.verdict.reason = `${result.verdict.reason} (ответила запасная модель: ${providerLabel(answeredBy)})`.trim();
  }
  await prisma.reconcileVerdict.updateMany({
    where: { id: verdict.id },
    data: result.ok
      ? {
          state: "done",
          proposed: result.verdict.status,
          note: result.verdict.note,
          evidence: result.verdict.evidence,
          reason: result.verdict.reason || null,
          resolver: resolverFor(result.verdict, siblings, context),
          input,
          mergeTargetId,
        }
      : { state: "error", error: result.error.slice(0, 300), input, mergeTargetId },
  });
}

// Разобрать следующие несколько тикетов запуска.
export async function stepRun(runId: string): Promise<{ remaining: number }> {
  const run = await prisma.reconcileRun.findUnique({ where: { id: runId }, select: { id: true } });
  if (!run) return { remaining: 0 };

  const provider = reconcileProvider();
  // Шаг ждёт самый медленный ответ: медиана у моделей ~1 с, но каждый
  // десятый — 5–25 с. Чем больше тикетов в шаге, тем реже этот хвост
  // повторяется. Groq держим на 3 — его лимит 8000 токенов в минуту на ключ;
  // у OpenRouter такого лимита нет. 6 × худшие 60 с + повтор укладываются
  // в maxDuration маршрута (300 с), потому что идут одновременно.
  const batch = provider.kind === "groq" ? 3 : 6;
  const pending = await prisma.reconcileVerdict.findMany({
    where: { runId, state: "pending" },
    orderBy: { createdAt: "asc" },
    take: batch,
    select: { id: true, issueId: true, issue: { select: { description: true } } },
  });

  // Тикеты шага — одновременно: по очереди вечер в 40 тикетов ждал бы
  // минуты. Упёршийся в лимит ключ Groq сменяет следующий.
  await Promise.all(pending.map((verdict) => judgeVerdict(verdict, provider)));

  const remaining = await prisma.reconcileVerdict.count({ where: { runId, state: "pending" } });
  if (remaining === 0) {
    await prisma.reconcileRun.update({ where: { id: runId }, data: { finishedAt: new Date() } });
  }
  return { remaining };
}

// Статусы, которые разбор может поставить сам. «Передано» — нет: для него
// нужна команда, а её из чата надёжно не вытащить. «Непонятно» — не статус.
const APPLICABLE = new Set<IssueStatus>(["RESOLVED", "IN_PROGRESS", "PENDING"]);

export type ApplyOutcome = { verdictId: string; applied: boolean; reason?: string };

// Применить отмеченные человеком решения.
// status — статус, который выбрал человек, если модель ошиблась или не
// поняла («Непонятно», «Передано»). Без него применяется предложенный.
export type ApplyItem = { verdictId: string; status?: IssueStatus };

export async function applyVerdicts(
  runId: string,
  items: ApplyItem[],
  actor: string
): Promise<ApplyOutcome[]> {
  const chosen = new Map(items.map((item) => [item.verdictId, item.status]));
  const verdicts = await prisma.reconcileVerdict.findMany({
    where: { runId, id: { in: [...chosen.keys()] } },
    select: {
      id: true,
      issueId: true,
      state: true,
      proposed: true,
      note: true,
      resolver: true,
      statusBefore: true,
      appliedAt: true,
      issue: { select: { status: true } },
    },
  });

  const outcomes: ApplyOutcome[] = [];
  for (const verdict of verdicts) {
    const override = chosen.get(verdict.id);
    const status = override ?? (verdict.proposed as IssueStatus | null);
    // Свой статус человек может поставить и тикету, который модель
    // пропустила или не разобрала, — он сам посмотрел переписку.
    const judged = override ? verdict.state !== "pending" : verdict.state === "done";
    if (verdict.appliedAt) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "уже применено" });
      continue;
    }
    if (!judged || !status || !APPLICABLE.has(status)) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "это не статус для применения" });
      continue;
    }
    // Пока разбор шёл, тикет могли тронуть руками — тогда решение человека
    // важнее догадки модели.
    if (verdict.issue.status !== verdict.statusBefore) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "статус уже поменяли вручную" });
      continue;
    }

    // Заметка модели описывает её вывод; если человек выбрал другой статус,
    // она не про то («Мәселенің шешілгені нақты емес» под «Решено»).
    const modelNote = status === verdict.proposed ? verdict.note : null;
    const note =
      status === "RESOLVED"
        ? `${verdict.resolver ?? actor} шешті${modelNote ? `, ${modelNote}` : ""}`
        : modelNote || undefined;
    // source "chat": в группе ответ дежурного уже прозвучал — повторять его
    // словами бота незачем (правило одной строки в CLAUDE.md).
    const result = await changeIssueStatus({
      issueId: verdict.issueId,
      status,
      actor,
      source: "chat",
      note,
    });
    if (!result.ok) {
      outcomes.push({ verdictId: verdict.id, applied: false, reason: "тикет не найден" });
      continue;
    }
    await prisma.reconcileVerdict.update({
      where: { id: verdict.id },
      data: { appliedAt: new Date(), appliedBy: actor },
    });
    outcomes.push({ verdictId: verdict.id, applied: true });
  }
  return outcomes;
}

// Журнал: запуски дня с решениями — для окна «Авто-репорт» и для вечерней
// сверки «что ИИ посчитал сделанным и что из этого применили».
// Запуски дня и тикеты, с которыми окно предлагает объединить (описание и
// дата — чтобы человек видел, с чем именно).
export async function runsForDay(reportDate: string) {
  const runs = await runsOnly(reportDate);
  const targetIds = [
    ...new Set(runs.flatMap((r) => r.verdicts.map((v) => v.mergeTargetId)).filter((id): id is string => !!id)),
  ];
  const targets = targetIds.length
    ? await prisma.issue.findMany({
        where: { id: { in: targetIds } },
        select: { id: true, description: true, reportDate: true, groupName: true, status: true },
      })
    : [];
  return { runs, mergeTargets: Object.fromEntries(targets.map((t) => [t.id, t])) };
}

async function runsOnly(reportDate: string) {
  return prisma.reconcileRun.findMany({
    where: { reportDate },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: {
      verdicts: {
        orderBy: { createdAt: "asc" },
        // input (что видела модель) — не здесь: это килобайты на тикет, а
        // журнал перечитывается на каждом шаге разбора. Его отдаёт
        // verdictInput по запросу, когда человек раскрыл «Почему так?».
        omit: { input: true },
        include: {
          issue: {
            select: {
              description: true,
              groupName: true,
              groupEmoji: true,
              status: true,
              telegramLink: true,
              reportDate: true,
            },
          },
        },
      },
    },
  });
}

// Что видела модель по одному решению — для «Почему так?» в окне.
export async function verdictInput(verdictId: string): Promise<string | null> {
  const verdict = await prisma.reconcileVerdict.findUnique({
    where: { id: verdictId },
    select: { input: true },
  });
  return verdict?.input ?? null;
}
