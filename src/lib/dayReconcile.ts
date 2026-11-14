import Anthropic from "@anthropic-ai/sdk";
import { callGroqDirect, GROQ_MODEL } from "@/lib/ai";
import { maskSensitiveForAi } from "@/lib/textClean";
import type { ThreadLine } from "@/lib/resolutionNote";
import type { ResolvedSibling } from "@/lib/relatedIssue";
import { buildReconcileMessages, modelFamily, reasoningParams, RECONCILE_RULES } from "@/lib/reconcilePrompt";
import { RECONCILE_CHAT_RULES, hasInstructionEvidence } from "@/lib/reconcileChat";
import { buildAiContext } from "@/lib/projectContext";

// Вечерний разбор: чем закончился каждый открытый тикет дня — по переписке в
// рабочем чате, а не по тому, успел ли дежурный передвинуть карточку.
//
// Зачем: сайтом днём пользуются не все, а репорт в 22:00 честен ровно
// настолько, насколько вовремя меняли статусы. Все данные у нас уже есть —
// бот сидит в группах и хранит реплики агентов с привязкой к тикетам (см.
// collectResolutionContext). Не хватало шага, который прочитает их за
// человека. Здесь только суждение по одному тикету; что с ним делать (показать
// дежурному, применить после подтверждения), решает вызывающий код.
//
// Модель выбирается переменной: сначала сравниваем кандидатов на прошлых днях
// (scripts/eval-reconcile.ts), в прод идёт самая дешёвая из тех, что не хуже
// по точности.

export const RECONCILE_STATUSES = [
  "RESOLVED",
  "IN_PROGRESS",
  "PENDING",
  "NEXT_DAY",
  "ESCALATED",
  "UNCLEAR",
] as const;
export type ReconcileStatus = (typeof RECONCILE_STATUSES)[number];

export type ReconcileVerdict = {
  status: ReconcileStatus;
  // Строка для репорта: что сделали (у RESOLVED) или что происходит.
  note: string;
  // Дословная цитата из реплик агента, на которой основан вывод, — чтобы
  // дежурный проверял решение за секунду, а не перечитывал чат.
  evidence: string;
  // Почему модель выбрала этот статус — одна фраза для человека,
  // проверяющего разбор (показывается в окне под «Почему так?»).
  reason: string;
};

// costUsd — сколько запрос стоил: OpenRouter сообщает сам, у Claude считаем
// по прайсу (ANTHROPIC_PRICES).
export type ReconcileUsage = { inputTokens: number; outputTokens: number; costUsd?: number };

export type ReconcileResult =
  | { ok: true; verdict: ReconcileVerdict; usage: ReconcileUsage | null; ms: number }
  | { ok: false; error: string; ms: number };

export type ReconcileProvider = { kind: "gemini" | "groq" | "openrouter" | "anthropic"; model: string };

// Сами правила и подача под каждую модель — в lib/reconcilePrompt.ts.

// Реплики агентов приходят уже замаскированными (collectResolutionContext), а
// описание — нет: у тикетов из формы и заведённых руками в нём бывает почта
// ученика. Без маски модель повторяет её в ответе, и почта оседает в журнале.
// Экспорт — ради журнала: разбор сохраняет ровно тот текст, что видела
// модель, чтобы по ошибке сразу было видно, чего ей не хватило.
// siblings — решённые почти одновременно похожие тикеты других групп
// (findResolvedSiblings): возможно, та же общая поломка. Модель сама решает,
// одна ли это поломка, — см. правило в reconcilePrompt.ts.
export function buildUserText(
  description: string,
  thread: ThreadLine[],
  siblings: ResolvedSibling[] = [],
  // Общие сообщения агентов в чате без стрелки (ResolutionContext.general).
  general: { text: string }[] = [],
  instructions: string[] = []
): string {
  description = maskSensitiveForAi(description);
  const replies = thread.length
    ? thread
        .map((line, i) => `${i + 1}. ${line.from === "agent" ? "Агент" : "Куратор"}: ${line.text}`)
        .join("\n")
    : "(в этом чате наши по обращению не отвечали)";
  const parts = [`Обращение: ${description}`, `Переписка по порядку:\n${replies}`];
  if (general.length) {
    parts.push(
      "Сообщения агентов в этом чате после обращения — без ответа на конкретное обращение (могут относиться сразу к нескольким похожим):\n" +
        general.map((g) => `- ${g.text}`).join("\n")
    );
  }
  if (siblings.length) {
    parts.push(
      "Похожие обращения в ДРУГИХ группах, уже решённые (возможно, та же общая поломка):\n" +
        siblings
          .map(
            (s) =>
              `- [${s.groupName}] ${maskSensitiveForAi(s.description)} — решено${s.note ? `: ${maskSensitiveForAi(s.note)}` : ""}`
          )
          .join("\n")
    );
  }
  if (instructions.length) {
    parts.push("Указания дежурного (JSON, по порядку):\n" + JSON.stringify(instructions.map(maskSensitiveForAi)));
  }
  return parts.join("\n\n");
}

// Последний {…} в тексте. DeepSeek изредка пишет в ответ свои размышления
// («We need answer JSON…»), а сам JSON — в конце.
export function lastJsonObject(raw: string): unknown {
  const end = raw.lastIndexOf("}");
  if (end < 0) return null;
  // lastIndexOf с отрицательным fromIndex ищет с нуля, а не «нигде», —
  // поэтому после нулевой позиции выходим сами, иначе цикл не кончится.
  for (let start = raw.lastIndexOf("{", end); start >= 0; start = start > 0 ? raw.lastIndexOf("{", start - 1) : -1) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // Не с той скобки — пробуем раньше.
    }
  }
  return null;
}

// Ответ модели — только если он по схеме: иначе вечерний разбор показал бы
// дежурному статус, которого не бывает.
function parseVerdict(raw: string): ReconcileVerdict | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = lastJsonObject(raw);
  }
  if (typeof data !== "object" || data === null) return null;
  const { status: rawStatus, note, evidence, reason } = data as Record<string, unknown>;
  // Схему статуса держит только Gemini; Groq и OpenRouter знают её из
  // промпта и иногда отвечают «resolved» — суждение то же, регистр не тот.
  const status = typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() : "";
  if (!RECONCILE_STATUSES.includes(status as ReconcileStatus)) return null;
  return {
    status: status as ReconcileStatus,
    note: typeof note === "string" ? note.trim() : "",
    evidence: typeof evidence === "string" ? evidence.trim() : "",
    reason: typeof reason === "string" ? reason.trim() : "",
  };
}

// Трудная переписка (восемь реплик, спор о том, что делать) думается долго:
// 25.09 MiMo отвечала за 50–60 с, и на 60 с запрос обрывался. 110 с —
// с запасом, а попытка + пауза + повтор ещё укладываются в 300 с шага.
const MODEL_TIMEOUT_MS = 110_000;

// Ключ Gemini лежит в GEMINI_REPORT_KEY, а не в GEMINI_API_KEY: с последним
// graphify отправляет код проекта во внешний API (см. CLAUDE.md).
async function askGemini(model: string, userText: string, glossary: string, rules?: string): Promise<ReconcileResult> {
  const started = Date.now();
  const key = process.env.GEMINI_REPORT_KEY;
  if (!key) return { ok: false, error: "GEMINI_REPORT_KEY не задан", ms: 0 };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: (rules ?? RECONCILE_RULES) + glossary }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: {
          // Схема ответа — на стороне API: невалидного JSON не придёт.
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              status: { type: "STRING", enum: [...RECONCILE_STATUSES] },
              note: { type: "STRING" },
              evidence: { type: "STRING" },
              reason: { type: "STRING" },
            },
            required: ["status", "note", "evidence"],
          },
        },
      }),
    }
  ).catch((err: unknown) => err as Error);
  const ms = Date.now() - started;
  if (res instanceof Error) return { ok: false, error: `сеть: ${res.name}`, ms };

  const data = (await res.json().catch(() => null)) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
    };
    error?: { message?: string };
  } | null;
  if (!res.ok) {
    return { ok: false, error: `${res.status}: ${data?.error?.message?.slice(0, 160) ?? ""}`, ms };
  }
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const verdict = parseVerdict(text);
  if (!verdict) return { ok: false, error: `не JSON по схеме: ${text.slice(0, 120)}`, ms };
  const u = data?.usageMetadata;
  return {
    ok: true,
    verdict,
    // Размышления у Gemini оплачиваются как выход — считаем их туда же.
    usage: u
      ? {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        }
      : null,
    ms,
  };
}

async function askGroq(userText: string, glossary: string, rules?: string): Promise<ReconcileResult> {
  const started = Date.now();
  const data = (await callGroqDirect(
    {
      model: GROQ_MODEL,
      messages: buildReconcileMessages(GROQ_MODEL, userText, glossary, undefined, rules),
      ...reasoningParams("groq", GROQ_MODEL),
      response_format: { type: "json_object" },
      // Модель reasoning-типа: маленький лимит съедают размышления, и ответ
      // приходит пустым (см. грабли в CLAUDE.md). С reasoning_effort high
      // размышления бывают длиннее 2000 токенов — Groq тогда отвечает
      // json_validate_failed с пустым ответом (так падало 15 тикетов из 50).
      max_tokens: 4000,
    },
    30_000
  )) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  const ms = Date.now() - started;
  if (!data) return { ok: false, error: "Groq не ответил (квота/сеть — см. [groq] в логе)", ms };
  const text = data.choices?.[0]?.message?.content ?? "";
  const verdict = parseVerdict(text);
  if (!verdict) return { ok: false, error: `не JSON по схеме: ${text.slice(0, 120)}`, ms };
  return {
    ok: true,
    verdict,
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
      : null,
    ms,
  };
}

// OpenRouter — один ключ на модели разных компаний (DeepSeek, Qwen, GLM,
// Kimi, MiMo…): их сравнивают на прошлых днях тем же скриптом, а в прод идёт
// победитель без новой интеграции. API совместим с OpenAI.
async function askOpenRouter(model: string, userText: string, glossary: string, rules?: string): Promise<ReconcileResult> {
  const started = Date.now();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, error: "OPENROUTER_API_KEY не задан", ms: 0 };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: buildReconcileMessages(model, userText, glossary, undefined, rules),
      ...reasoningParams("openrouter", model),
      response_format: { type: "json_object" },
      // Почти все свежие модели — reasoning-типа: лимит с запасом на
      // размышления. 4000 не хватало: DeepSeek на трудной переписке
      // исписал весь лимит размышлениями и вернул пустой ответ. MiMo — 4000:
      // на прогоне по истории ~5% тикетов уходили у неё за 4000 токенов
      // размышлений, съедали пятую часть всех токенов, думали 70–240 с и
      // были верны в трети случаев. При исчерпании лимита пробуем запасную
      // модель через общий обработчик ошибок в reconcileRun.
      max_tokens: modelFamily(model) === "mimo" ? 4000 : 8000,
      // DeepSeek на OpenRouter раздают ~26 провайдеров, от официального до
      // fp4-сборок, и цена одного и того же запроса отличалась в десять раз.
      // Сначала сам DeepSeek и DeepInfra (fp8, с кэшем), остальные — запасом.
      ...(modelFamily(model) === "deepseek"
        ? { provider: { order: ["deepseek", "deepinfra"], allow_fallbacks: true } }
        : {}),
      usage: { include: true },
    }),
  }).catch((err: unknown) => err as Error);
  const ms = Date.now() - started;
  if (res instanceof Error) return { ok: false, error: `сеть: ${res.name}`, ms };

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string; code?: number };
  } | null;
  if (!res.ok || data?.error) {
    return { ok: false, error: `${res.status}: ${data?.error?.message?.slice(0, 160) ?? ""}`, ms };
  }
  const text = data?.choices?.[0]?.message?.content ?? "";
  const usage = data?.usage
    ? {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
        costUsd: data.usage.cost,
      }
    : null;
  // Лимит генерации — технический сбой, а не суждение о тикете.
  // Возвращаем ошибку, чтобы reconcileRun попробовал запасную модель.
  // Даже формально валидный JSON при length может быть незаконченным ответом.
  if (data?.choices?.[0]?.finish_reason === "length") {
    return {
      ok: false,
      error: "Модель исчерпала лимит ответа; статус обращения не определён",
      ms,
    };
  }
  if (!text.trim()) return { ok: false, error: "Модель вернула пустой ответ; статус обращения не определён", ms };
  const verdict = parseVerdict(text);
  if (!verdict) return { ok: false, error: `не JSON по схеме: ${text.slice(0, 120)}`, ms };
  return {
    ok: true,
    verdict,
    usage,
    ms,
  };
}

// Claude API напрямую (ключ ANTHROPIC_API_KEY, официальный SDK).
//
// - Ответ по JSON-схеме на стороне API (output_config.format): статус из
//   списка, невалидного JSON не придёт — как у Gemini.
// - Правила (~4100 токенов) — отдельным блоком system с cache_control:
//   они одинаковы у всех тикетов, и повторное чтение из кэша стоит 1/10–1/20
//   обычного входа. Словарь — следующим блоком, после метки: он у каждого
//   тикета свой и кэш не ломает.
// - Глубина размышлений — output_config.effort (RECONCILE_EFFORT: low /
//   medium / high / xhigh / max, по умолчанию medium). У Opus 5.5 и Sonnet 5.5
//   размышления выключить нельзя — только понизить effort.
// - Повторов внутри SDK нет (maxRetries: 0): повтор и запасная модель — в
//   reconcileRun, как у остальных провайдеров.
let anthropicClient: Anthropic | null = null;
function anthropic(): Anthropic {
  anthropicClient ??= new Anthropic({ maxRetries: 0, timeout: MODEL_TIMEOUT_MS });
  return anthropicClient;
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];

function claudeEffort(): ClaudeEffort {
  const value = process.env.RECONCILE_EFFORT?.trim();
  return CLAUDE_EFFORTS.includes(value as ClaudeEffort) ? (value as ClaudeEffort) : "medium";
}

// $ за 1M токенов: вход, выход, чтение кэша, запись кэша (5 мин — 1.25× входа).
// Нет модели в таблице — цена в журнале просто не считается.
const ANTHROPIC_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

// Серверный повтор на другой модели Claude, если классификатор безопасности
// откажет (stop_reason: refusal). Есть не у всех моделей — у Haiku нет.
const MODELS_WITH_SERVER_FALLBACK = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-fable-5-2"]);

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: [...RECONCILE_STATUSES] },
    note: { type: "string" },
    evidence: { type: "string" },
    reason: { type: "string" },
  },
  required: ["status", "note", "evidence", "reason"],
  additionalProperties: false,
} as const;

async function askAnthropic(model: string, userText: string, glossary: string, rules?: string): Promise<ReconcileResult> {
  const started = Date.now();
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: "ANTHROPIC_API_KEY не задан", ms: 0 };

  // Через общий buildReconcileMessages — чтобы и здесь работала подмена
  // правил из eval-прогона (--rules). Словарь отдельно, после метки кэша.
  const [systemMessage, userMessage] = buildReconcileMessages(model, userText, "", undefined, rules);
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: systemMessage.content, cache_control: { type: "ephemeral" } },
  ];
  if (glossary.trim()) system.push({ type: "text", text: glossary });
  const withFallback = MODELS_WITH_SERVER_FALLBACK.has(model);

  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await anthropic().beta.messages.create({
      model,
      // С запасом на размышления: при effort medium их обычно сотни токенов,
      // но трудная переписка думается дольше, а обрезанный ответ — сбой.
      max_tokens: 8000,
      system,
      messages: [{ role: "user", content: userMessage.content }],
      output_config: {
        effort: claudeEffort(),
        format: { type: "json_schema", schema: VERDICT_SCHEMA },
      },
      ...(withFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, error: "сеть: таймаут", ms };
    if (err instanceof Anthropic.APIConnectionError) return { ok: false, error: "сеть: нет соединения", ms };
    if (err instanceof Anthropic.APIError) {
      return { ok: false, error: `${err.status ?? "?"}: ${err.message.slice(0, 160)}`, ms };
    }
    return { ok: false, error: `сбой: ${(err as Error).name}`, ms };
  }
  const ms = Date.now() - started;

  const u = response.usage;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const price = ANTHROPIC_PRICES[response.model] ?? ANTHROPIC_PRICES[model];
  const usage: ReconcileUsage = {
    inputTokens: u.input_tokens + cacheRead + cacheWrite,
    outputTokens: u.output_tokens,
    costUsd: price
      ? (u.input_tokens * price.input +
          cacheRead * price.cacheRead +
          cacheWrite * price.cacheWrite +
          u.output_tokens * price.output) /
        1_000_000
      : undefined,
  };

  if (response.stop_reason === "refusal") {
    return { ok: false, error: `Claude отказался отвечать (${response.stop_details?.category ?? "без категории"})`, ms };
  }
  // Как у OpenRouter: упёрлись в лимит — технический сбой, пусть reconcileRun
  // попробует запасную модель.
  if (response.stop_reason === "max_tokens") {
    return { ok: false, error: "Модель исчерпала лимит ответа; статус обращения не определён", ms };
  }
  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
  if (!text.trim()) return { ok: false, error: "Модель вернула пустой ответ; статус обращения не определён", ms };
  const verdict = parseVerdict(text);
  if (!verdict) return { ok: false, error: `не JSON по схеме: ${text.slice(0, 120)}`, ms };
  return { ok: true, verdict, usage, ms };
}

// Суждение по одному тикету. thread — уже замаскированная переписка по нему:
// реплики агентов и ответы куратора (collectResolutionContext); без реплик
// агентов судить не о чем, и такой тикет вызывающий код сразу пропускает.
export async function reconcileIssue(
  provider: ReconcileProvider,
  description: string,
  thread: ThreadLine[],
  siblings: ResolvedSibling[] = [],
  general: { text: string }[] = [],
  instructions: string[] = []
): Promise<ReconcileResult> {
  const userText = buildUserText(description, thread, siblings, general, instructions);
  // Словарь компании — только термины, встретившиеся в этом тексте (правило
  // из CLAUDE.md: весь словарь в каждый запрос не влезает в лимиты).
  const glossary = await buildAiContext(userText);
  const rules = instructions.length ? RECONCILE_CHAT_RULES : undefined;
  const result = await (provider.kind === "gemini"
    ? askGemini(provider.model, userText, glossary, rules)
    : provider.kind === "openrouter"
      ? askOpenRouter(provider.model, userText, glossary, rules)
      : provider.kind === "anthropic"
        ? askAnthropic(provider.model, userText, glossary, rules)
        : askGroq(userText, glossary, rules));
  if (instructions.length && result.ok && result.verdict.status !== "UNCLEAR" &&
      !hasInstructionEvidence(result.verdict.evidence, instructions.map(maskSensitiveForAi))) {
    result.verdict = { status: "UNCLEAR", note: "", evidence: "",
      reason: "ИИ не привёл точную цитату из указаний — уточните результат работы" };
  }
  return result;
}
