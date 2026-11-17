import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled, PlatformError } from "@/lib/platform";
import { searchUntResults } from "@/lib/untReset";

export type { UntSearchRow, UntSearchFallback } from "@/lib/untReset";

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  phone_taken: 409,
  upstream_error: 502,
};

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
    const { results, fallback } = await searchUntResults(untId, product, student);
    return NextResponse.json({ results, fallback });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
