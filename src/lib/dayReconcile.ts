import { callGroqChat, GROQ_MODEL } from "@/lib/ai";
import { maskSensitiveForAi } from "@/lib/textClean";
import type { ThreadLine } from "@/lib/resolutionNote";
import type { ResolvedSibling } from "@/lib/relatedIssue";
import { buildReconcileMessages, reasoningParams, RECONCILE_RULES } from "@/lib/reconcilePrompt";
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

// costUsd — сколько запрос стоил, если провайдер это сообщает (OpenRouter).
export type ReconcileUsage = { inputTokens: number; outputTokens: number; costUsd?: number };

export type ReconcileResult =
  | { ok: true; verdict: ReconcileVerdict; usage: ReconcileUsage | null; ms: number }
  | { ok: false; error: string; ms: number };

export type ReconcileProvider = { kind: "gemini" | "groq" | "openrouter"; model: string };

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
  siblings: ResolvedSibling[] = []
): string {
  description = maskSensitiveForAi(description);
  const replies = thread.length
    ? thread
        .map((line, i) => `${i + 1}. ${line.from === "agent" ? "Агент" : "Куратор"}: ${line.text}`)
        .join("\n")
    : "(в этом чате наши по обращению не отвечали)";
  const parts = [`Обращение: ${description}`, `Переписка по порядку:\n${replies}`];
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
  const { status, note, evidence, reason } = data as Record<string, unknown>;
  if (typeof status !== "string" || !RECONCILE_STATUSES.includes(status as ReconcileStatus)) {
    return null;
  }
  return {
    status: status as ReconcileStatus,
    note: typeof note === "string" ? note.trim() : "",
    evidence: typeof evidence === "string" ? evidence.trim() : "",
    reason: typeof reason === "string" ? reason.trim() : "",
  };
}

const MODEL_TIMEOUT_MS = 60_000;

// Ключ Gemini лежит в GEMINI_REPORT_KEY, а не в GEMINI_API_KEY: с последним
// graphify отправляет код проекта во внешний API (см. CLAUDE.md).
async function askGemini(model: string, userText: string, glossary: string): Promise<ReconcileResult> {
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
        systemInstruction: { parts: [{ text: RECONCILE_RULES + glossary }] },
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

async function askGroq(userText: string, glossary: string): Promise<ReconcileResult> {
  const started = Date.now();
  const data = (await callGroqChat(
    {
      model: GROQ_MODEL,
      messages: buildReconcileMessages(GROQ_MODEL, userText, glossary),
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
async function askOpenRouter(model: string, userText: string, glossary: string): Promise<ReconcileResult> {
  const started = Date.now();
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, error: "OPENROUTER_API_KEY не задан", ms: 0 };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: buildReconcileMessages(model, userText, glossary),
      ...reasoningParams("openrouter", model),
      response_format: { type: "json_object" },
      // Почти все свежие модели — reasoning-типа: лимит с запасом на размышления.
      max_tokens: 4000,
      usage: { include: true },
    }),
  }).catch((err: unknown) => err as Error);
  const ms = Date.now() - started;
  if (res instanceof Error) return { ok: false, error: `сеть: ${res.name}`, ms };

  const data = (await res.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string; code?: number };
  } | null;
  if (!res.ok || data?.error) {
    return { ok: false, error: `${res.status}: ${data?.error?.message?.slice(0, 160) ?? ""}`, ms };
  }
  const text = data?.choices?.[0]?.message?.content ?? "";
  const verdict = parseVerdict(text);
  if (!verdict) return { ok: false, error: `не JSON по схеме: ${text.slice(0, 120)}`, ms };
  return {
    ok: true,
    verdict,
    usage: data?.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
          costUsd: data.usage.cost,
        }
      : null,
    ms,
  };
}

// Суждение по одному тикету. thread — уже замаскированная переписка по нему:
// реплики агентов и ответы куратора (collectResolutionContext); без реплик
// агентов судить не о чем, и такой тикет вызывающий код сразу пропускает.
export async function reconcileIssue(
  provider: ReconcileProvider,
  description: string,
  thread: ThreadLine[],
  siblings: ResolvedSibling[] = []
): Promise<ReconcileResult> {
  const userText = buildUserText(description, thread, siblings);
  // Словарь компании — только термины, встретившиеся в этом тексте (правило
  // из CLAUDE.md: весь словарь в каждый запрос не влезает в лимиты).
  const glossary = await buildAiContext(userText);
  if (provider.kind === "gemini") return askGemini(provider.model, userText, glossary);
  if (provider.kind === "openrouter") return askOpenRouter(provider.model, userText, glossary);
  return askGroq(userText, glossary);
}
