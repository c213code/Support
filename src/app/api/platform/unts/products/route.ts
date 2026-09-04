import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled, getUntProducts, PlatformError } from "@/lib/platform";

const STATUS_BY_CODE: Record<PlatformError["code"], number> = {
  not_configured: 503,
  auth_failed: 502,
  not_found: 404,
  email_taken: 409,
  upstream_error: 502,
};

export async function GET(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!platformEnabled()) {
    return NextResponse.json({ error: "Инструмент не настроен на сервере" }, { status: 503 });
  }

  const untId = request.nextUrl.searchParams.get("untId")?.trim() ?? "";
  if (!untId) {
    return NextResponse.json({ error: "untId обязателен" }, { status: 400 });
  }

  try {
    const products = await getUntProducts(untId);
    return NextResponse.json({ products });
  } catch (err) {
    if (err instanceof PlatformError) {
      return NextResponse.json({ error: err.message }, { status: STATUS_BY_CODE[err.code] });
    }
    throw err;
  }
}
