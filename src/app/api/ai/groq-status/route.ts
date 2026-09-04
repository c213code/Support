import { NextResponse } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { checkGroqStatus } from "@/lib/ai";

// Реальный вызов Groq (список моделей + тестовый чат) — не бесплатная
// операция, поэтому в отличие от settings-роутов GET здесь тоже за авторизацией.
export const maxDuration = 20;

export async function GET() {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await checkGroqStatus());
}
