import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { isLogsAiEnabled } from "@/lib/settings";
import { explainLogError, type LogErrorEvent } from "@/lib/ai";

export const maxDuration = 30;

// Тело запроса/ответа уже обрезано до MAX_BODY_CHARS на клиенте (та же строка,
// что показана в раскрытой строке таблицы), но режем ещё раз здесь — маршрут
// не должен доверять чужому фронту в вопросе "сколько символов ушло в модель".
const MAX_BODY_CHARS = 400;

function trimBody(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}…` : value;
}

// Объяснение одной ошибочной записи лога (4xx/5xx) — агент кликает на строку
// в таблице, где уже есть все поля, поэтому в отличие от /api/logs/investigate
// сюда не нужен повторный поход в Elasticsearch.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const status = typeof body?.status === "string" ? body.status : "";
  const code = Number(status);
  if (!status || !Number.isFinite(code) || code < 400) {
    return NextResponse.json({ error: "нужен status ошибки (4xx/5xx)" }, { status: 400 });
  }

  if (!(await isLogsAiEnabled())) {
    return NextResponse.json({ explanation: null, reason: "ai-off" });
  }

  const event: LogErrorEvent = {
    method: typeof body?.method === "string" ? body.method : null,
    uri: typeof body?.uri === "string" ? body.uri : null,
    status,
    requestId: typeof body?.requestId === "string" ? body.requestId : null,
    message: typeof body?.message === "string" ? body.message : "",
    requestBody: trimBody(body?.requestBody),
    responseBody: trimBody(body?.responseBody),
  };

  const explanation = await explainLogError(event);
  if (!explanation) {
    return NextResponse.json({ explanation: null, reason: "ai-error" });
  }

  return NextResponse.json({ explanation });
}
