// Клиент к отдельному сервису juz40-vpn-logs (держит корпоративный WireGuard
// и отдаёт логи из Elasticsearch по HTTPS с bearer-токеном — см. соседний
// репозиторий juz40-vpn-logs, README/DEPLOY.md). Support сам к VPN не
// подключается — только ходит по обычному HTTPS к уже поднятому сервису.
//
// Тот же принцип, что у platform.ts: токен и адрес сервиса — только в env на
// сервере, в клиент не попадают. Отличие — здесь нет логина/JWT, один
// статичный bearer-токен на весь сервис.

const TIMEOUT_MS = 15_000;

export function logsServiceEnabled(): boolean {
  return Boolean(process.env.LOGS_SERVICE_URL && process.env.LOGS_SERVICE_TOKEN);
}

function baseUrl(): string {
  const url = process.env.LOGS_SERVICE_URL;
  if (!url) throw new Error("LOGS_SERVICE_URL is not set");
  return url.replace(/\/+$/, "");
}

export class LogsServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "unavailable"
      | "timeout"
      | "auth_failed"
      | "bad_request"
      | "upstream_error"
  ) {
    super(message);
    this.name = "LogsServiceError";
  }
}

async function logsFetch(path: string): Promise<Response> {
  if (!logsServiceEnabled()) {
    throw new LogsServiceError(
      "Сервис логов не настроен (LOGS_SERVICE_URL/LOGS_SERVICE_TOKEN)",
      "not_configured"
    );
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl()}${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${process.env.LOGS_SERVICE_TOKEN}` },
    });
  } catch (err) {
    // Свой таймаут (AbortError) — это НЕ "сервис выключен": свободный поиск
    // может гонять запрос по 30 дням и честно не уложиться в TIMEOUT_MS, пока
    // сервис жив и здоров. Путать одно с другим — значит гонять агента по
    // кругу "включить VPN" на уже включённом сервисе.
    if (err instanceof Error && err.name === "AbortError") {
      throw new LogsServiceError(
        `Запрос к логам не уложился в ${TIMEOUT_MS / 1000}с — сузь период или запрос`,
        "timeout"
      );
    }
    throw new LogsServiceError(
      `Сервис логов недоступен: ${String(err)}`,
      "unavailable"
    );
  } finally {
    clearTimeout(timeout);
  }
}

function mapErrorStatus(status: number): LogsServiceError {
  if (status === 401 || status === 403) {
    return new LogsServiceError("Сервис логов отклонил токен", "auth_failed");
  }
  if (status === 400) {
    return new LogsServiceError("Некорректный запрос к логам", "bad_request");
  }
  if (status === 502 || status === 503) {
    return new LogsServiceError(
      "Сервис логов не достучался до Elasticsearch — проверь, что VPN-туннель поднят",
      "unavailable"
    );
  }
  return new LogsServiceError(`Сервис логов вернул HTTP ${status}`, "upstream_error");
}

// 200 с нечитаемым/неожиданным телом — это не "ничего не нашли", а сломанный
// ответ (схема разъехалась, апстрим упал за фасадом 200 и т.п.). Путать одно
// с другим — ровно то, от чего явно предостерегает platform.ts.
function assertSearchResult(data: unknown): asserts data is LogsSearchResult {
  const d = data as { total?: unknown; hits?: unknown } | null;
  if (!d || typeof d.total !== "number" || !Array.isArray(d.hits)) {
    throw new LogsServiceError(
      "Сервис логов вернул неожиданный формат ответа",
      "upstream_error"
    );
  }
}

export type LogHit = {
  timestamp: string | null;
  username: string | null;
  method: string | null;
  uri: string | null;
  status: string | null;
  requestId: string | null;
  message: string;
  raw: Record<string, unknown>;
};

export type LogsSearchResult = {
  total: number;
  hits: LogHit[];
};

type SearchParams = { from?: string; to?: string; size?: number };

export async function searchLogs(
  q: string,
  params: SearchParams = {}
): Promise<LogsSearchResult> {
  const qs = new URLSearchParams({ q, size: String(params.size ?? 200) });
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);

  const res = await logsFetch(`/logs/search?${qs}`);
  if (!res.ok) throw mapErrorStatus(res.status);
  const data = await res.json().catch(() => null);
  assertSearchResult(data);
  return data;
}

export async function searchStudentLogs(
  email: string,
  params: SearchParams = {}
): Promise<LogsSearchResult> {
  const qs = new URLSearchParams({ email, size: String(params.size ?? 200) });
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);

  const res = await logsFetch(`/logs/student?${qs}`);
  if (!res.ok) throw mapErrorStatus(res.status);
  const data = await res.json().catch(() => null);
  assertSearchResult(data);
  return data;
}

// HTTP-статус, которым роут отвечает клиенту на каждый код ошибки — держим
// в одном месте, чтобы /search и /student не разъезжались.
export function logsErrorStatus(code: LogsServiceError["code"]): number {
  switch (code) {
    case "not_configured":
      return 501;
    case "unavailable":
      return 503;
    case "timeout":
      return 504;
    case "bad_request":
      return 400;
    case "auth_failed":
    case "upstream_error":
      return 502;
  }
}
