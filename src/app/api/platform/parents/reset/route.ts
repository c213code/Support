import { NextResponse, type NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getParentAccount, requestParentCredentials, platformEnabled, PlatformError } from "@/lib/platform";
import { ParentAccessError, UUID_PATTERN } from "@/lib/parentAccess";
import { runParentAccessReset } from "@/lib/parentAccessReset";

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!platformEnabled()) return NextResponse.json({ error: "Инструмент не настроен" }, { status: 503 });
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: "Недопустимый источник запроса" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const parentId = typeof body?.parentId === "string" ? body.parentId : "";
  const requestId = typeof body?.requestId === "string" ? body.requestId : "";
  if (!UUID_PATTERN.test(parentId) || !UUID_PATTERN.test(requestId) ||
    typeof body?.expectedLogin !== "string" || !body.expectedLogin || body.expectedLogin.length > 300 ||
    !(body.expectedPhone === null || typeof body.expectedPhone === "string" && body.expectedPhone.length <= 50) ||
    !Array.isArray(body.studentIds) || body.studentIds.length > 100 ||
    !body.studentIds.every((id: unknown) => typeof id === "string" && UUID_PATTERN.test(id))) {
    return NextResponse.json({ error: "Обновите поиск и выберите аккаунт родителя" }, { status: 400 });
  }
  try {
    const result = await runParentAccessReset({ parentId, expectedLogin: body.expectedLogin,
      expectedPhone: body.expectedPhone, studentIds: body.studentIds }, {
      read: getParentAccount,
      begin: async () => {
        try { await prisma.parentAccessReset.create({ data: {
          id: requestId, actor: identity.name, parentId, studentIds: body.studentIds,
        } }); }
        catch (error) {
          if ((error as { code?: string }).code === "P2002") {
            throw new ParentAccessError("Этот запрос уже выполнялся. Повторный сброс не отправлен. Проверьте результат на платформе.");
          }
          throw new ParentAccessError("Не удалось зарегистрировать действие. Сброс не выполнялся.", 503);
        }
      },
      reset: requestParentCredentials,
      finish: async (status) => { await prisma.parentAccessReset.update({ where: { id: requestId }, data: { status } }); },
    });
    return NextResponse.json({ result }, { headers: { "Cache-Control": "no-store, private" } });
  } catch (error) {
    if (error instanceof ParentAccessError) return NextResponse.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    if (error instanceof PlatformError) return NextResponse.json({ error: error.message }, { status: 502, headers: { "Cache-Control": "no-store" } });
    throw error;
  }
}
