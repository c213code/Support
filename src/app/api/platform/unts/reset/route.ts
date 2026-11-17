import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled, PlatformError } from "@/lib/platform";
import { resetUntResult } from "@/lib/untReset";

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  phone_taken: 409,
  upstream_error: 502,
};

// Сама проверка FINISHED и удаление — в resetUntResult (src/lib/untReset.ts):
// та же функция работает и для кнопки в личке бота.
export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) {
    return NextResponse.json({ error: "Инструмент не настроен на сервере" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const resultId = typeof body?.resultId === "string" ? body.resultId.trim() : "";
  const untId = typeof body?.untId === "string" ? body.untId.trim() : "";
  const untName = typeof body?.untName === "string" ? body.untName.trim() : "";
  if (!resultId) {
    return NextResponse.json({ error: "resultId обязателен" }, { status: 400 });
  }

  try {
    const outcome = await resetUntResult({ resultId, untId, untName, actor: identity.name });
    if (!outcome.ok) {
      return NextResponse.json(
        { error: "Результат ещё не завершён (нет статуса FINISHED и finishTime) — обнулять нельзя" },
        { status: 409 }
      );
    }
    return NextResponse.json(outcome);
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
