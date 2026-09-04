import { NextResponse } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled, listUntTests, PlatformError } from "@/lib/platform";

// Список тестов (деңгейлік/ДТ и прочие "unts") для инструмента обнуления
// результата — список небольшой (десятки-сотни записей), поэтому фильтрацию
// по названию делает клиент, а не отдельный query-параметр здесь.
export async function GET() {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) {
    return NextResponse.json({ error: "Инструмент не настроен на сервере" }, { status: 503 });
  }

  try {
    const tests = await listUntTests();
    return NextResponse.json({ tests });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    throw err;
  }
}
