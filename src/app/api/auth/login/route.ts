import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME, verifyAgentPassword } from "@/lib/auth";
import { SHARED_AGENT } from "@/lib/agents";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const agent = body?.agent as string | undefined;
  const password = body?.password as string | undefined;
  const displayName = (body?.displayName as string | undefined)?.trim();

  if (!agent || !password || !verifyAgentPassword(agent, password)) {
    return NextResponse.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }

  // Под общим аккаунтом обязательно указать своё имя — оно станет автором.
  if (agent === SHARED_AGENT && !displayName) {
    return NextResponse.json({ error: "Укажите своё имя" }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, agent });
  response.cookies.set(
    SESSION_COOKIE_NAME,
    createSessionToken(agent, displayName),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 дней
    }
  );
  return response;
}
