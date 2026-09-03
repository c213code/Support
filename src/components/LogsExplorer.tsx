"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { VpnServiceButton } from "@/components/VpnServiceButton";
import { formatDateTimeAlmaty } from "@/lib/date";
import { IconDatabase, IconSearch } from "@/components/Icons";

type Mode = "student" | "free";

type LogHit = {
  timestamp: string | null;
  username: string | null;
  method: string | null;
  uri: string | null;
  status: string | null;
  requestId: string | null;
  message: string;
  raw: Record<string, unknown>;
};

type SearchResult = { total: number; hits: LogHit[] };

const PERIODS = [
  { key: "now-1h", label: "1 час" },
  { key: "now-24h", label: "24 часа" },
  { key: "now-7d", label: "7 дней" },
  { key: "now-30d", label: "30 дней" },
] as const;

// Логи живут ~15-30 дней (см. CLAUDE.md) — дальше 30 дней смотреть нечего.
const DEFAULT_PERIOD = "now-24h";

function statusBadgeClass(status: string | null): string {
  const code = Number(status);
  if (!Number.isFinite(code)) return "bg-slate-100 text-slate-500";
  if (code >= 500) return "bg-red-50 text-red-700";
  if (code >= 400) return "bg-amber-50 text-amber-700";
  if (code >= 300) return "bg-sky-50 text-sky-700";
  if (code >= 200) return "bg-emerald-50 text-emerald-700";
  return "bg-slate-100 text-slate-500";
}

function rowKey(hit: LogHit, i: number): string {
  return hit.requestId ? `${hit.requestId}-${i}` : `${hit.timestamp}-${i}`;
}

// Режим "по ученику" ищет точной фразой по всем полям без разбора формата —
// email, телефон, ссылка, request id — что угодно, что реально встречается в
// документе. Единственное, что стоит привести к одному виду сам, — телефон:
// агент может ввести его с "+7", с "8" вместо "7", с пробелами/дефисами, а
// искать нужно ровно ту цифровую строку, что лежит в логе.
function normalizeStudentQuery(raw: string): string {
  const trimmed = raw.trim();
  const digitsOnly = trimmed.replace(/[\s\-()]/g, "");
  if (/^(\+7|8|7)\d{10}$/.test(digitsOnly)) {
    return "7" + digitsOnly.slice(-10);
  }
  return trimmed;
}

// Логи — однородные записи одной формы: таблица читается быстрее карточек,
// когда задача — просканировать полсотни строк и найти одну аномалию.
//
// Используется и как страница /logs (без пропсов — email читается из URL),
// и как модалка прямо с карточки тикета (initialEmail/onClose — модалка
// монтирует компонент заново на каждое открытие, так что initialEmail нужен
// только на момент монтирования, реагировать на его смену не на чем).
export function LogsExplorer({
  initialEmail,
  onClose,
}: {
  initialEmail?: string;
  onClose?: () => void;
} = {}) {
  const toast = useToast();

  const [mode, setMode] = useState<Mode>("student");
  const [input, setInput] = useState("");
  const [period, setPeriod] = useState<string>(DEFAULT_PERIOD);

  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  // "unavailable"/"timeout" — отдельно от прочих ошибок: единственный случай,
  // где у пользователя есть осмысленное действие прямо здесь (включить сервис).
  const [serviceDown, setServiceDown] = useState(false);
  const [serviceDownDetail, setServiceDownDetail] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const autoSearchedRef = useRef(false);
  // Параметры последней попытки — ретрай через 8с бьёт именно по ним, а не
  // по тому, что окажется в input/mode/period к тому моменту (агент вполне
  // успевает передумать за 8 секунд).
  const lastAttemptRef = useRef<{ mode: Mode; input: string; period: string } | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  async function search(overrides?: { mode?: Mode; input?: string; period?: string }) {
    const activeMode = overrides?.mode ?? mode;
    const activePeriod = overrides?.period ?? period;
    const rawValue = (overrides?.input ?? input).trim();
    if (!rawValue) return;
    const value = activeMode === "student" ? normalizeStudentQuery(rawValue) : rawValue;

    lastAttemptRef.current = { mode: activeMode, input: value, period: activePeriod };
    setLoading(true);
    setServiceDown(false);
    setServiceDownDetail(null);
    try {
      const path = activeMode === "student" ? "/api/logs/student" : "/api/logs/search";
      const param = activeMode === "student" ? "email" : "q";
      const res = await fetch(
        `${path}?${param}=${encodeURIComponent(value)}&from=${activePeriod}`
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 503 || res.status === 504) {
          setServiceDown(true);
          setServiceDownDetail(data?.error ?? null);
        } else {
          toast(data?.error ?? `Не удалось выполнить поиск (HTTP ${res.status})`, "error");
        }
        setResult(null);
        return;
      }
      // HTTP 200 с нечитаемым/неожиданным телом — это не "ничего не нашли",
      // а сломанный ответ; не путаем одно с другим (см. platform.ts).
      if (!data || !Array.isArray(data.hits) || typeof data.total !== "number") {
        toast("Сервис логов вернул неожиданный ответ", "error");
        setResult(null);
        return;
      }
      setResult(data);
      setExpanded(null);
    } catch (err) {
      setResult(null);
      toast(`Сеть недоступна: ${String(err)}`, "error");
    } finally {
      setLoading(false);
    }
  }

  // С карточки тикета (initialEmail, модалка) или со страницы /logs?email=...
  // — сразу режим "по ученику" и поиск, без ручного ввода.
  useEffect(() => {
    if (autoSearchedRef.current) return;
    autoSearchedRef.current = true;
    const email = initialEmail ?? new URLSearchParams(window.location.search).get("email");
    if (!email) return;
    const t = setTimeout(() => {
      setMode("student");
      setInput(email);
      search({ mode: "student", input: email });
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- одноразовое чтение при монтировании (initialEmail фиксирован на момент открытия модалки)
  }, []);

  async function startServiceAndRetry() {
    if (enabling) return;
    setEnabling(true);
    try {
      const res = await fetch("/api/vpn-service", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast(data?.error ?? `Не удалось включить сервис (HTTP ${res.status})`, "error");
        setEnabling(false);
        return;
      }
      toast("Включаю сервис — туннель поднимается, это займёт несколько секунд", "success");
      const attempt = lastAttemptRef.current;
      retryTimerRef.current = setTimeout(async () => {
        if (attempt) await search(attempt);
        setEnabling(false);
      }, 8000);
    } catch (err) {
      toast(`Не удалось включить сервис: ${String(err)}`, "error");
      setEnabling(false);
    }
  }

  function selectPeriod(key: string) {
    setPeriod(key);
    // Пресеты периода — фильтр, а не декорация: меняешь его над уже
    // показанными результатами, значит ждёшь, что таблица обновится сама,
    // а не будешь молча смотреть на данные за старый диапазон.
    if (result || serviceDown) search({ period: key });
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 id="logs-modal-title" className="text-lg font-semibold text-slate-900">
            Логи
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Прямой доступ к Elasticsearch — то же самое, что раньше искали в Kibana.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <VpnServiceButton
            onError={(m) => toast(m, "error")}
            onInfo={(m) => toast(m, "success")}
          />
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Закрыть"
              aria-label="Закрыть"
              className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Режим + строка поиска + период — один блок, чтобы искать можно было
          в одно действие: выбрал режим, ввёл значение, нажал Enter. */}
      <div className="rounded-xl border border-slate-200 bg-white p-3">
        <div className="mb-3 flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
          {(
            [
              { key: "student" as const, label: "По ученику" },
              { key: "free" as const, label: "Свободный поиск" },
            ]
          ).map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                setMode(m.key);
                setResult(null);
                setServiceDown(false);
              }}
              className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                mode === m.key
                  ? "bg-white text-slate-900 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              placeholder={
                mode === "student"
                  ? "email, телефон (77771234567), ссылка или ID ученика…"
                  : "responseStatusCode:500 AND requestUri:/login…"
              }
              className="w-full rounded-lg border border-slate-300 py-2 pl-8 pr-3 text-sm outline-none focus:border-brand-500"
            />
          </div>
          <button
            type="button"
            onClick={() => search()}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:opacity-40"
          >
            {loading ? "Ищем…" : "Искать"}
          </button>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => selectPeriod(p.key)}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                period === p.key
                  ? "bg-brand-50 text-brand-700"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Сервис выключен — единственное состояние с прямым действием прямо
          здесь, а не отсылкой "иди включи и вернись". */}
      {serviceDown && (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <div>
            <p className="text-sm font-medium text-amber-900">Логи сейчас недоступны</p>
            <p className="mt-0.5 text-xs text-amber-700">
              {serviceDownDetail ?? "Туннель до Elasticsearch не поднят — без него логи не достать."}
            </p>
          </div>
          <button
            onClick={startServiceAndRetry}
            disabled={enabling}
            className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {enabling ? "Включаем…" : "Включить и повторить"}
          </button>
        </div>
      )}

      {!serviceDown && result && (
        <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
          {result.hits.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
              <IconDatabase className="h-8 w-8 text-slate-300" />
              <p className="text-sm text-slate-500">
                Ничего не нашли за выбранный период — попробуй увеличить диапазон.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-400">
                    <th className="px-3 py-2 font-medium">Время</th>
                    <th className="px-3 py-2 font-medium">Метод</th>
                    <th className="px-3 py-2 font-medium">Статус</th>
                    <th className="px-3 py-2 font-medium">URI</th>
                    <th className="px-3 py-2 font-medium">Кто</th>
                    <th className="px-3 py-2 font-medium">Сообщение</th>
                  </tr>
                </thead>
                <tbody>
                  {result.hits.map((hit, i) => {
                    const key = rowKey(hit, i);
                    const isOpen = expanded === key;
                    return (
                      <Fragment key={key}>
                        <tr
                          onClick={() => setExpanded(isOpen ? null : key)}
                          className="cursor-pointer border-b border-slate-100 transition last:border-0 hover:bg-slate-50"
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-500">
                            {hit.timestamp ? formatDateTimeAlmaty(new Date(hit.timestamp)) : "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-600">
                            {hit.method ?? "—"}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2">
                            <span
                              className={`rounded px-1.5 py-0.5 font-mono text-xs font-semibold ${statusBadgeClass(hit.status)}`}
                            >
                              {hit.status ?? "—"}
                            </span>
                          </td>
                          <td className="max-w-xs truncate px-3 py-2 font-mono text-xs text-slate-700">
                            {hit.uri ?? "—"}
                          </td>
                          <td className="max-w-[160px] truncate px-3 py-2 font-mono text-xs text-slate-500">
                            {hit.username ?? "—"}
                          </td>
                          <td className="min-w-[280px] max-w-lg whitespace-normal break-words px-3 py-2 font-mono text-xs text-slate-700">
                            {hit.message || "—"}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <td colSpan={6} className="px-3 py-3">
                              <pre className="max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
                                {JSON.stringify(hit.raw, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {result.total > result.hits.length && (
            <p className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400">
              Показано {result.hits.length} из {result.total} — сузь период или уточни запрос.
            </p>
          )}
        </div>
      )}

      {!serviceDown && !result && !loading && (
        <div className="mt-10 flex flex-col items-center gap-2 text-center text-slate-400">
          <IconDatabase className="h-8 w-8" />
          <p className="text-sm">
            {mode === "student"
              ? "Введи email, телефон, ссылку или ID ученика и нажми Enter — ищем точным совпадением по всем полям, формат неважен."
              : "Введи запрос в синтаксисе Elasticsearch и нажми Enter."}
          </p>
        </div>
      )}
    </div>
  );
}
