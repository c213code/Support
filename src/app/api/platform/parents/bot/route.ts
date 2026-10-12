import { NextResponse, type NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { isParentAccessBotEnabled, setParentAccessBotEnabled } from "@/lib/settings";
import { parentAccessBotReady } from "@/lib/parentAccessBot";

export async function GET() {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: await isParentAccessBotEnabled(), ready: parentAccessBotReady() },
    { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!await getCurrentIdentity()) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) return NextResponse.json({ error: "Недопустимый источник" }, { status: 403 });
  const body = await request.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "Нужен переключатель enabled" }, { status: 400 });
  if (body.enabled && !parentAccessBotReady()) return NextResponse.json({ error: "Не настроены Groq, Telegram или сервис-аккаунт платформы" }, { status: 503 });
  await setParentAccessBotEnabled(body.enabled);
  return NextResponse.json({ enabled: body.enabled }, { headers: { "Cache-Control": "no-store" } });
}
