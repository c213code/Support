import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  platformEnabled,
  getUntResultStatus,
  deleteUntResult,
  PlatformError,
} from "@/lib/platform";

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  upstream_error: 502,
};

// Удаляем прод-результат теста необратимо, поэтому не доверяем тому, что
// клиент уже когда-то видел статус "FINISHED" на экране — перепроверяем его
// прямо перед DELETE (могло пройти время, ученик мог зайти и продолжить
// решать). Обнулять можно только реально завершённый результат: удалить
// решение ученика в процессе — не "снять зависший ПИИ", а потерять прогресс.
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
    const status = await getUntResultStatus(resultId);
    if (status.status !== "FINISHED" || !status.finishTime) {
      return NextResponse.json(
        { error: "Результат ещё не завершён (нет статуса FINISHED и finishTime) — обнулять нельзя" },
        { status: 409 }
      );
    }

    await deleteUntResult(resultId);

    // Журнал — после успешного удаления (несделанное не журналируем, см.
    // schema.prisma). Сбой самой записи не должен превращать уже случившееся
    // удаление в "ошибку" для клиента.
    try {
      await prisma.untResultReset.create({
        data: {
          actor: identity.name,
          untId,
          untName: untName || null,
          resultId,
          studentEmail: status.studentEmail,
          studentName: status.studentName || null,
          finishTimeWas: status.finishTime,
        },
      });
    } catch (auditErr) {
      console.warn(`[platform] результат обнулён, но журнал не записался: ${String(auditErr)}`);
    }

    return NextResponse.json({
      ok: true,
      resultId,
      studentEmail: status.studentEmail,
      studentName: status.studentName,
    });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
