import Anthropic from "@anthropic-ai/sdk";

// Claude для ИИ-функций по сообщениям (lib/ai.ts). Включается переменной
// AI_MODEL (например claude-sonnet-5-5) вместе с ANTHROPIC_API_KEY; без них
// всё идёт через Groq, как раньше.
//
// Функции в ai.ts написаны под OpenAI-совместимый формат Groq (messages с
// role: system, response_format, reasoning_effort). Здесь он переводится в
// Claude API, а ответ — обратно в форму { choices: [{ message: { content } }] },
// поэтому ни одна функция в ai.ts не переписывалась.
//
// Любой сбой (ключ, лимит расходов в Console, таймаут, отказ) — null, и
// callGroqChat идёт в Groq: фичи не замолкают, когда месячный бюджет кончился.

export function claudeAiModel(): string | null {
  const model = process.env.AI_MODEL?.trim();
  return model && model.startsWith("claude-") && process.env.ANTHROPIC_API_KEY ? model : null;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  // Повторов нет: запасной путь — Groq, а вебхук Telegram ждать не может.
  client ??= new Anthropic({ maxRetries: 0 });
  return client;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
function asEffort(value: unknown): Effort | null {
  return EFFORTS.includes(value as Effort) ? (value as Effort) : null;
}

// Claude иногда оборачивает JSON в ```json … ```, а функции в ai.ts делают
// JSON.parse по content. Отдаём чистый объект от первой { до последней }.
function extractJson(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return text;
  const candidate = text.slice(start, end + 1);
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    return text;
  }
}

type ChatMessage = { role?: unknown; content?: unknown };

export async function callClaudeChat(
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  const model = claudeAiModel();
  if (!model) return null;

  const all = (Array.isArray(body.messages) ? body.messages : []) as ChatMessage[];
  const system = all
    .filter((m) => m.role === "system")
    .map((m) => String(m.content ?? ""))
    .join("\n\n");
  const messages: Anthropic.MessageParam[] = all
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: String(m.content ?? "") }));
  if (!messages.length || messages[messages.length - 1].role !== "user") return null;

  const wantsJson =
    typeof body.response_format === "object" &&
    (body.response_format as { type?: unknown } | null)?.type === "json_object";
  // Лимиты в ai.ts подобраны под gpt-oss и местами малы (200 токенов). У
  // Claude размышления тоже идут в max_tokens, поэтому даём запас — платится
  // только то, что реально сгенерировано.
  const requested = typeof body.max_tokens === "number" ? body.max_tokens : 1000;
  const effort = asEffort(body.reasoning_effort) ?? asEffort(process.env.AI_EFFORT?.trim()) ?? "medium";

  try {
    const response = await anthropic().messages.create(
      {
        model,
        max_tokens: Math.max(requested, 4000),
        ...(system ? { system } : {}),
        messages,
        output_config: { effort },
      },
      // Таймауты в ai.ts (5–8 с) подобраны под Groq, который отвечает за
      // секунду. Claude с размышлениями думает дольше, а оборванный по
      // таймауту запрос всё равно оплачен — поэтому не меньше 20 с (вебхук
      // живёт до 300 с).
      { timeout: Math.max(timeoutMs, 20_000) }
    );
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") {
      console.warn(`[claude] ${model}: stop_reason=${response.stop_reason}, уходим в Groq`);
      return null;
    }
    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    if (!text) return null;
    return {
      choices: [{ message: { content: wantsJson ? extractJson(text) : text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens:
          response.usage.input_tokens +
          (response.usage.cache_read_input_tokens ?? 0) +
          (response.usage.cache_creation_input_tokens ?? 0),
        completion_tokens: response.usage.output_tokens,
      },
    };
  } catch (err) {
    // Сообщение SDK без ключа: статус и текст ошибки API.
    const detail =
      err instanceof Anthropic.APIError ? `${err.status ?? "?"} ${err.message}` : String(err);
    console.warn(`[claude] ${model}: ${detail.slice(0, 300)} — уходим в Groq`);
    return null;
  }
}
