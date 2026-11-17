import { NextResponse, type NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { isUntResetBotEnabled, setUntResetBotEnabled } from "@/lib/settings";
import { untResetBotReady } from "@/lib/untResetBot";

// Рубильник «сброс БТ/ДТ из Telegram» (см. src/lib/untResetBot.ts). Выключен
// по умолчанию, включает человек со страницы /platform/reset-unt.
export async function GET() {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: await isUntResetBotEnabled(), ready: untResetBotReady() },
    { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: "Недопустимый источник" }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "Нужен переключатель enabled" }, { status: 400 });
  if (body.enabled && !untResetBotReady()) return NextResponse.json({ error: "Не настроены Telegram или сервис-аккаунт платформы" }, { status: 503 });
  await setUntResetBotEnabled(body.enabled);
  return NextResponse.json({ enabled: body.enabled }, { headers: { "Cache-Control": "no-store" } });
}
