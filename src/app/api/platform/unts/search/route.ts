import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import {
  platformEnabled,
  findUntResults,
  findStudentUntFallback,
  getUntResultStatus,
  PlatformError,
  type UntResultMatch,
} from "@/lib/platform";

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  phone_taken: 409,
  upstream_error: 502,
};

export type UntSearchRow = {
  resultId: string;
  fullName: string;
  combination: string | null;
  score: number;
  status: string;
  finishTime: string | null;
  studentEmail: string | null;
};

// Как искали, если по почте/телефону в отчёте пусто (см.
// findStudentUntFallback): UI по этому объясняет агенту, что строки найдены
// по фамилии, а не по почте, — их надо сверить глазами перед обнулением.
export type UntSearchFallback =
  | { status: "student_not_found" }
  | { status: "no_name" }
  | {
      status: "searched";
      by: "lastname" | "firstname";
      query: string;
      studentName: string;
      combinationName: string | null;
    };

// Почта или телефон — только по ним есть смысл искать ученика на платформе
// для запасного поиска. Если агент сам вписал фамилию, второй круг не нужен.
function isContact(value: string): boolean {
  return value.includes("@") || value.replace(/\D/g, "").length >= 9;
}

// Для каждого найденного результата отдельно читаем его статус (/report
// этого не отдаёт — только score) — без этого UI не может решить, можно ли
// обнулять конкретную строку.
async function withStatuses(matches: UntResultMatch[]): Promise<UntSearchRow[]> {
  const results: UntSearchRow[] = [];
  for (const m of matches) {
    try {
      const status = await getUntResultStatus(m.resultId);
      results.push({
        resultId: m.resultId,
        fullName: m.fullName,
        combination: m.combination,
        score: m.score,
        status: status.status,
        finishTime: status.finishTime,
        studentEmail: status.studentEmail,
      });
    } catch (err) {
      // Статус одной строки не прочитался — остальные строки всё равно
      // показываем. Пустой status ниже по цепочке трактуется как "нельзя
      // обнулять" (безопасный дефолт), а не как "тест завершён".
      console.warn(`[platform] статус результата ${m.resultId} не прочитан: ${String(err)}`);
      results.push({
        resultId: m.resultId,
        fullName: m.fullName,
        combination: m.combination,
        score: m.score,
        status: "",
        finishTime: null,
        studentEmail: null,
      });
    }
  }
  return results;
}

// Ищем результаты ученика по тесту; если по почте/телефону пусто — запасной
// поиск по фамилии в комбинации ученика (см. UntSearchFallback).
export async function GET(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) {
    return NextResponse.json({ error: "Инструмент не настроен на сервере" }, { status: 503 });
  }

  const params = request.nextUrl.searchParams;
  const untId = params.get("untId")?.trim() ?? "";
  const product = params.get("product")?.trim() ?? "";
  const student = params.get("student")?.trim() ?? "";
  if (!untId || !product || !student) {
    return NextResponse.json(
      { error: "untId, product и student обязательны" },
      { status: 400 }
    );
  }

  try {
    let matches = await findUntResults(untId, product, student);
    let fallback: UntSearchFallback | undefined;

    // По почте пусто — повторяем ручной путь агента: фамилия (потом имя) в
    // поиске + фильтр по комбинации ученика.
    if (matches.length === 0 && isContact(student)) {
      const info = await findStudentUntFallback(student);
      if (!info) {
        fallback = { status: "student_not_found" };
      } else {
        const tries = [
          { by: "lastname" as const, query: info.lastname },
          { by: "firstname" as const, query: info.firstname },
        ].filter((t): t is { by: "lastname" | "firstname"; query: string } => Boolean(t.query));
        const studentName = [info.lastname, info.firstname].filter(Boolean).join(" ");
        if (tries.length === 0) {
          fallback = { status: "no_name" };
        }
        for (const t of tries) {
          matches = await findUntResults(
            untId,
            product,
            t.query,
            info.combinationId ?? undefined
          );
          fallback = {
            status: "searched",
            by: t.by,
            query: t.query,
            studentName,
            combinationName: info.combinationName,
          };
          if (matches.length > 0) break;
        }
      }
    }

    const results = await withStatuses(matches);
    return NextResponse.json({ results, fallback });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
