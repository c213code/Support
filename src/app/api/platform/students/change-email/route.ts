import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  platformEnabled,
  changeStudentEmail,
  PlatformError,
} from "@/lib/platform";

// Меняем прод-данные ученика, поэтому строго: только вошедший агент, только
// при настроенном инструменте, с валидацией почты. Автор берётся из сессии
// (getCurrentIdentity().name) — с клиента не принимаем, как и везде в проекте.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  upstream_error: 502,
};

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) {
    return NextResponse.json(
      { error: "Инструмент не настроен на сервере" },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const newEmail =
    typeof body?.newEmail === "string" ? body.newEmail.trim() : "";

  if (!id) {
    return NextResponse.json({ error: "id ученика обязателен" }, { status: 400 });
  }
  if (!EMAIL_RE.test(newEmail)) {
    return NextResponse.json(
      { error: "Некорректный формат почты" },
      { status: 400 }
    );
  }

  try {
    const result = await changeStudentEmail(id, newEmail);

    // Журнал: кто, какому ученику, A→B, когда. Пишем после успешной смены —
    // журналировать несделанное нельзя. Сбой записи журнала (маловероятный)
    // не откатывает смену, но и не должен вернуть клиенту «ошибка»: смена
    // уже произошла. Поэтому логируем в консоль, а клиенту отдаём успех.
    try {
      await prisma.platformEmailChange.create({
        data: {
          actor: identity.name,
          studentId: id,
          studentName: result.studentName || null,
          oldEmail: result.oldEmail ?? "",
          newEmail: result.newEmail,
        },
      });
    } catch (auditErr) {
      console.warn(
        `[platform] смена почты прошла, но журнал не записался: ${String(auditErr)}`
      );
    }

    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json(
        { error: err.message },
        { status: STATUS_BY_CODE[err.code] }
      );
    }
    throw err;
  }
}
