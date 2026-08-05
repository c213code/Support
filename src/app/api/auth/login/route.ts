import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createSessionToken, SESSION_COOKIE_NAME, verifyAgentPassword } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const agent = body?.agent as string | undefined;
  const password = body?.password as string | undefined;

  if (!agent || !password || !verifyAgentPassword(agent, password)) {
    return NextResponse.json({ error: "Неверный логин или пароль" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, agent });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(agent), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 дней
  });
  return response;
}
