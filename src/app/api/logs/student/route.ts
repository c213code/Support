import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { LogsServiceError, logsErrorStatus, searchStudentLogs } from "@/lib/logsClient";

export async function GET(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const email = params.get("email")?.trim();
  if (!email) {
    return NextResponse.json({ error: "email обязателен" }, { status: 400 });
  }

  const size = Number(params.get("size") ?? 200);

  try {
    const result = await searchStudentLogs(email, {
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
      size: Number.isFinite(size) ? size : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    const code = err instanceof LogsServiceError ? err.code : "upstream_error";
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Поиск не удался" },
      { status: logsErrorStatus(code) }
    );
  }
}
