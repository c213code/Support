import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled, searchStudents, PlatformError } from "@/lib/platform";

// Поиск ученика в основной платформе JUZ40 перед сменой почты. Только для
// вошедших агентов и только если инструмент настроен (заданы PLATFORM_* env).
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
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  // Короткий запрос не шлём в платформу — толку от одной буквы нет, а лишний
  // вызов есть.
  if (query.length < 3) {
    return NextResponse.json({ students: [] });
  }

  try {
    const students = await searchStudents(query);
    return NextResponse.json({ students });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
