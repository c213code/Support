import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { platformEnabled, changeStudentPhone, PlatformError } from "@/lib/platform";
import { normalizeKzPhone } from "@/lib/phone";

// Смена номера ученику — как смена почты (change-email): только вошедший
// агент, только при настроенном инструменте, автор — из сессии. Номер
// принимаем в любом виде, как его прислали, и приводим к "+7XXXXXXXXXX".
const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  phone_taken: 409,
  upstream_error: 502,
};

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) {
    return NextResponse.json({ error: "Инструмент не настроен на сервере" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const newPhone = typeof body?.newPhone === "string" ? normalizeKzPhone(body.newPhone) : null;
  if (!id) {
    return NextResponse.json({ error: "id ученика обязателен" }, { status: 400 });
  }
  if (!newPhone) {
    return NextResponse.json(
      { error: "Номер не похож на казахстанский: нужно 10–11 цифр, например +7 775 666 55 33" },
      { status: 400 }
    );
  }

  try {
    const result = await changeStudentPhone(id, newPhone);
    // Журнал — после успешной смены; его сбой смену не отменяет (она уже
    // произошла), поэтому только в консоль.
    try {
      await prisma.platformPhoneChange.create({
        data: {
          actor: identity.name,
          studentId: id,
          studentName: result.studentName || null,
          oldPhone: result.oldPhone ?? "",
          newPhone: result.newPhone,
        },
      });
    } catch (auditErr) {
      console.warn(`[platform] смена номера прошла, но журнал не записался: ${String(auditErr)}`);
    }
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
