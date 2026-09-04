"use client";

import { useEffect, useMemo, useState } from "react";
import { useToast } from "@/components/Toast";
import { formatDateTimeAlmaty } from "@/lib/date";

type UntTest = {
  id: string;
  name: string;
  openTime: string | null;
  endTime: string | null;
  published: boolean;
};

type ResultRow = {
  resultId: string;
  fullName: string;
  combination: string | null;
  score: number;
  status: string;
  finishTime: string | null;
  studentEmail: string | null;
};

function isOpenNow(test: UntTest): boolean {
  if (!test.openTime || !test.endTime) return false;
  const now = Date.now();
  return new Date(test.openTime).getTime() <= now && now <= new Date(test.endTime).getTime();
}

function canReset(row: ResultRow): boolean {
  return row.status === "FINISHED" && Boolean(row.finishTime);
}

function statusLabel(row: ResultRow): string {
  if (row.status === "FINISHED") return "завершён";
  if (row.status === "STARTED") return "решает сейчас";
  if (!row.status) return "статус не проверен";
  return row.status;
}

function statusClass(row: ResultRow): string {
  if (canReset(row)) return "bg-emerald-50 text-emerald-700";
  if (row.status === "STARTED") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-500";
}

// Обнуление "залипшего" результата деңгейлік теста (ДТ) — когда у ученика
// закрыто ПИИ и телефон/почта из-за этого считаются занятыми валидацией.
// Строго только для действительно ЗАВЕРШЁННЫХ попыток (status FINISHED +
// finishTime): удалить процесс решения — потерять прогресс ученика, а не
// снять мешающий валидации хвост. Сервер перепроверяет это же условие ещё
// раз перед самим удалением — фронт здесь только удобство, не гарантия.
export function ResetUntResultTool() {
  const toast = useToast();

  const [tests, setTests] = useState<UntTest[] | null>(null);
  const [testsError, setTestsError] = useState<string | null>(null);
  const [testQuery, setTestQuery] = useState("");
  const [selectedTest, setSelectedTest] = useState<UntTest | null>(null);

  const [products, setProducts] = useState<string[] | null>(null);
  const [product, setProduct] = useState("");

  const [student, setStudent] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<ResultRow[] | null>(null);

  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/unts/tests")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setTests(data.tests ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setTestsError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredTests = useMemo(() => {
    if (!tests) return [];
    const q = testQuery.trim().toLowerCase();
    const list = q ? tests.filter((t) => t.name.toLowerCase().includes(q)) : tests;
    return [...list]
      .sort((a, b) => {
        const openA = isOpenNow(a) ? 1 : 0;
        const openB = isOpenNow(b) ? 1 : 0;
        if (openA !== openB) return openB - openA;
        return (b.openTime ?? "").localeCompare(a.openTime ?? "");
      })
      .slice(0, 30);
  }, [tests, testQuery]);

  function selectTest(test: UntTest) {
    setSelectedTest(test);
    setProducts(null);
    setProduct("");
    setResults(null);
    setDoneIds(new Set());
    fetch(`/api/platform/unts/products?untId=${encodeURIComponent(test.id)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
        return data;
      })
      .then((data) => {
        const list: string[] = data.products ?? [];
        setProducts(list);
        if (list.length >= 1) setProduct(list[0]);
      })
      .catch((err) => {
        toast(`Не удалось получить продукты теста: ${String(err)}`, "error");
        setProducts([]);
      });
  }

  function resetTest() {
    setSelectedTest(null);
    setTestQuery("");
    setProducts(null);
    setProduct("");
    setResults(null);
    setDoneIds(new Set());
  }

  async function search() {
    if (!selectedTest || !product.trim() || !student.trim() || searching) return;
    setSearching(true);
    setResults(null);
    setDoneIds(new Set());
    try {
      const params = new URLSearchParams({
        untId: selectedTest.id,
        product: product.trim(),
        student: student.trim(),
      });
      const res = await fetch(`/api/platform/unts/search?${params}`);
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast(data?.error ?? `Поиск не удался (HTTP ${res.status})`, "error");
        return;
      }
      setResults(data.results ?? []);
    } catch (err) {
      toast(`Сеть недоступна: ${String(err)}`, "error");
    } finally {
      setSearching(false);
    }
  }

  async function doReset(row: ResultRow) {
    if (resettingId) return;
    setResettingId(row.resultId);
    try {
      const res = await fetch("/api/platform/unts/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resultId: row.resultId,
          untId: selectedTest?.id ?? "",
          untName: selectedTest?.name ?? "",
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        toast(data?.error ?? `Не удалось обнулить (HTTP ${res.status})`, "error");
        return;
      }
      setDoneIds((prev) => new Set(prev).add(row.resultId));
      setConfirmingId(null);
      toast(`Результат обнулён у ${data.studentName || row.fullName}`, "success");
    } catch (err) {
      toast(`Сеть недоступна: ${String(err)}`, "error");
    } finally {
      setResettingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="mb-1 text-lg font-semibold text-slate-900">
        Обнуление результата ДТ
      </h1>
      <p className="mb-6 text-sm text-slate-500">
        Только для завершённых попыток — снимает хвост, из-за которого
        телефон/почта считаются занятыми валидацией, а не отменяет решение.
      </p>

      {/* Шаг 1: тест */}
      {!selectedTest && (
        <div>
          <input
            autoFocus
            value={testQuery}
            onChange={(e) => setTestQuery(e.target.value)}
            placeholder="Название теста, например СМАРТ ҚЫРКҮЙЕК ДТ…"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
          />
          {testsError && <p className="mt-2 text-sm text-red-600">{testsError}</p>}
          {!tests && !testsError && <p className="mt-2 text-sm text-slate-400">Загружаем…</p>}
          <div className="mt-3 max-h-80 space-y-1.5 overflow-y-auto">
            {filteredTests.map((t) => (
              <button
                key={t.id}
                onClick={() => selectTest(t)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left transition hover:border-brand-400 hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {t.name}
                  </span>
                  <span className="text-xs text-slate-500">
                    {t.openTime ? formatDateTimeAlmaty(new Date(t.openTime)) : "—"} →{" "}
                    {t.endTime ? formatDateTimeAlmaty(new Date(t.endTime)) : "—"}
                  </span>
                </span>
                {isOpenNow(t) && (
                  <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
                    идёт сейчас
                  </span>
                )}
              </button>
            ))}
            {tests && filteredTests.length === 0 && (
              <p className="text-sm text-slate-400">Ничего не нашли</p>
            )}
          </div>
        </div>
      )}

      {/* Шаг 2: продукт + ученик */}
      {selectedTest && (
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-slate-900">{selectedTest.name}</p>
              <p className="text-xs text-slate-500">
                {selectedTest.openTime ? formatDateTimeAlmaty(new Date(selectedTest.openTime)) : "—"} →{" "}
                {selectedTest.endTime ? formatDateTimeAlmaty(new Date(selectedTest.endTime)) : "—"}
              </p>
            </div>
            <button
              onClick={resetTest}
              className="shrink-0 text-xs text-slate-500 hover:text-slate-800"
            >
              Сменить тест
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div className="w-32">
              <label className="mb-1 block text-xs text-slate-600">Продукт</label>
              {products && products.length > 1 ? (
                <select
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand-500"
                >
                  {products.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  placeholder="SMART"
                  className="w-full rounded-lg border border-slate-300 px-2 py-2 text-sm outline-none focus:border-brand-500"
                />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-xs text-slate-600">
                Почта или телефон ученика
              </label>
              <input
                value={student}
                onChange={(e) => setStudent(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="student@juz40.kz"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
            </div>
            <button
              onClick={search}
              disabled={!product.trim() || !student.trim() || searching}
              className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
            >
              {searching ? "Ищем…" : "Найти"}
            </button>
          </div>

          {results && (
            <div className="mt-4 space-y-2">
              {results.length === 0 && (
                <p className="text-sm text-slate-400">
                  У этого ученика нет результата по выбранным тесту и продукту.
                </p>
              )}
              {results.map((row) => {
                const done = doneIds.has(row.resultId);
                const confirming = confirmingId === row.resultId;
                return (
                  <div
                    key={row.resultId}
                    className={`rounded-lg border p-3 ${
                      done ? "border-emerald-200 bg-emerald-50" : "border-slate-200"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-slate-900">
                          {row.fullName}
                          {row.combination ? ` · ${row.combination}` : ""}
                        </p>
                        <p className="font-mono text-xs text-slate-500">
                          {row.studentEmail ?? "—"} · балл {row.score}
                        </p>
                        {row.finishTime && (
                          <p className="text-xs text-slate-500">
                            завершил {formatDateTimeAlmaty(new Date(row.finishTime))}
                          </p>
                        )}
                      </div>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${statusClass(row)}`}
                      >
                        {statusLabel(row)}
                      </span>
                    </div>

                    {done ? (
                      <p className="mt-2 text-sm font-medium text-emerald-700">Обнулено</p>
                    ) : confirming ? (
                      <div className="mt-2 flex items-center gap-2">
                        <p className="text-xs text-amber-700">
                          Необратимо — удалит результат на платформе. Точно?
                        </p>
                        <button
                          onClick={() => doReset(row)}
                          disabled={resettingId === row.resultId}
                          className="ml-auto shrink-0 rounded-lg bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-40"
                        >
                          {resettingId === row.resultId ? "Обнуляем…" : "Да, обнулить"}
                        </button>
                        <button
                          onClick={() => setConfirmingId(null)}
                          className="shrink-0 text-xs text-slate-500 hover:text-slate-800"
                        >
                          Отмена
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmingId(row.resultId)}
                        disabled={!canReset(row)}
                        title={
                          canReset(row)
                            ? undefined
                            : "Обнулить можно только завершённый результат (status FINISHED)"
                        }
                        className="mt-2 rounded-lg border border-red-200 px-2.5 py-1 text-xs font-medium text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        Обнулить результат
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
