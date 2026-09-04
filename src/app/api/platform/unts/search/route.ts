import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import {
  platformEnabled,
  findUntResults,
  getUntResultStatus,
  PlatformError,
} from "@/lib/platform";

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
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

// Ищем результаты ученика по тесту, затем для каждого найденного результата
// отдельно читаем его статус (/report этого не отдаёт — только score) — без
// этого UI не может решить, можно ли обнулять конкретную строку.
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
    const matches = await findUntResults(untId, product, student);
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
        console.warn(
          `[platform] статус результата ${m.resultId} не прочитан: ${String(err)}`
        );
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
    return NextResponse.json({ results });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
