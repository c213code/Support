import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { isLogsAiEnabled } from "@/lib/settings";
import { investigateStudentLogs, type LogEventForAi } from "@/lib/ai";
import { formatDateTimeAlmaty } from "@/lib/date";
import { RAW_FIELDS, pickRawField } from "@/lib/logFields";
import {
  LogsServiceError,
  logsErrorStatus,
  searchLogs,
  searchStudentLogs,
  type LogHit,
} from "@/lib/logsClient";

// Худший случай запроса — 15с на логи (logsClient) плюс 25с на модель, и это
// на каждый ключ Groq при переборе. Дефолта платформы хватает, но лимит
// объявляем явно, чтобы он не стал сюрпризом при смене плана.
export const maxDuration = 60;

// Логи одного ученика за сутки — это сотни однотипных GET'ов. Смысл разбора
// не в том, чтобы модель прочитала все, а в том, чтобы увидела ключевые.
// Сколько записей не поместилось — уходит в ответ (`total`) и показывается
// агенту: пустая хронология на обрезанных данных не должна читаться как
// "этого не было".
const MAX_EVENTS_FOR_AI = 60;

// Тела запроса/ответа бывают на десятки килобайт (списки уроков, html) и
// съедают дневную квоту Groq, общую на весь аккаунт — а её делят с авто-
// описаниями тикетов из вебхука (см. CLAUDE.md). Поэтому режем коротко и
// шлём тела не у всех записей, а только там, где они отвечают на вопрос
// "что пошло не так": ошибки и всё, что меняет данные.
const MAX_BODY_CHARS = 200;

function trim(value: string | null): string | null {
  if (!value) return null;
  return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}…` : value;
}

// Успешный GET — это чтение, его тело для разбора почти всегда шум. Ошибки
// и запросы, которые что-то меняют (POST/PUT/PATCH/DELETE), — наоборот,
// ровно то место, где видно "что именно отправил".
function bodiesWorthSending(hit: LogHit): boolean {
  const code = Number(hit.status);
  if (Number.isFinite(code) && code >= 400) return true;
  return (hit.method ?? "GET").toUpperCase() !== "GET";
}

// Из полного документа оставляем только то, что относится к делу: служебные
// поля filebeat/kubernetes занимают больше места, чем всё полезное вместе
// взятое, и модели они мешают ровно так же, как мешали человеку в UI.
//
// Время приводим к тому же виду, в каком его видит агент в таблице (Алматы).
// Иначе модель честно повторит UTC из документа, агент прочитает "14:35" в
// таблице и "09:35" в разборе над ней — и назовёт ученику время, которого не
// было.
function toAiEvent(hit: LogHit): LogEventForAi {
  const withBodies = bodiesWorthSending(hit);
  return {
    time: hit.timestamp ? formatDateTimeAlmaty(new Date(hit.timestamp)) : "",
    method: hit.method,
    uri: hit.uri,
    status: hit.status,
    requestId: hit.requestId,
    message: trim(hit.message) ?? "",
    requestBody: withBodies ? trim(pickRawField(hit.raw, RAW_FIELDS.requestBody)) : null,
    responseBody: withBodies ? trim(pickRawField(hit.raw, RAW_FIELDS.responseBody)) : null,
  };
}

// Разбор логов ученика по описанной агентом ситуации.
//
// Всегда 200 с `investigation: null` и причиной, когда разбирать нечего
// (рубильник выключен, логов не нашлось, модель не ответила): для панели это
// не ошибка, а разные сообщения — тот же принцип, что у suggest-note.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const situation = typeof body?.situation === "string" ? body.situation.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const q = typeof body?.q === "string" ? body.q.trim() : "";
  const from = typeof body?.from === "string" ? body.from : undefined;

  if (!situation) {
    return NextResponse.json({ error: "situation обязателен" }, { status: 400 });
  }
  if (!email && !q) {
    return NextResponse.json({ error: "нужен email или q" }, { status: 400 });
  }

  if (!(await isLogsAiEnabled())) {
    return NextResponse.json({ investigation: null, reason: "ai-off" });
  }

  let hits: LogHit[];
  let total: number;
  try {
    const result = email
      ? await searchStudentLogs(email, { from })
      : await searchLogs(q, { from });
    hits = result.hits;
    total = result.total;
  } catch (err) {
    const code = err instanceof LogsServiceError ? err.code : "upstream_error";
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Не удалось получить логи" },
      { status: logsErrorStatus(code) }
    );
  }

  if (hits.length === 0) {
    // total > 0 при пустых hits — это не "ничего не нашли", а разъехавшийся
    // ответ сервиса логов (см. тот же принцип в logsClient.assertSearchResult).
    return NextResponse.json({
      investigation: null,
      reason: total > 0 ? "logs-shape-error" : "no-logs",
      mode: email ? "student" : "free",
    });
  }

  // Порядок записей задаёт сервис логов, а не мы. Он сортирует по времени
  // убыванием, но полагаться на чужую сортировку в вопросе "какие 60 из 200
  // увидит модель" нельзя: если она когда-нибудь поменяется, модель молча
  // начнёт читать самые старые записи окна. ISO-8601 сравнивается лексикографически.
  const newestFirst = [...hits].sort((a, b) =>
    (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
  );
  const forAi = newestFirst.slice(0, MAX_EVENTS_FOR_AI);

  const investigation = await investigateStudentLogs(situation, forAi.map(toAiEvent));

  if (!investigation) {
    return NextResponse.json({ investigation: null, reason: "ai-error" });
  }

  return NextResponse.json({
    investigation,
    analyzed: forAi.length,
    // Сколько записей нашлось всего (не только присланных модели) — панель
    // покажет разницу, если разбор построен не на всех логах.
    found: hits.length,
  });
}
