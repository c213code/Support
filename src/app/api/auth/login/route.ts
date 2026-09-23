import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createSessionToken, findAgentByPassword, SESSION_COOKIE_NAME } from "@/lib/auth";
import { SHARED_AGENT } from "@/lib/agents";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  // Логин — просто имя человека, доступ решает пароль (см.
  // findAgentByPassword): у Ероша и Алпы он свой, у сменных — общий пароль
  // «Дежурного», и тогда введённое имя становится автором в репорте.
  const name = String(body?.name ?? "").trim().slice(0, 40);
  const password = typeof body?.password === "string" ? body.password : "";

  if (!name) {
    return NextResponse.json({ error: "Введите своё имя" }, { status: 400 });
  }
  const agent = findAgentByPassword(password);
  if (!agent) {
    return NextResponse.json({ error: "Неверный пароль" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, agent });
  response.cookies.set(
    SESSION_COOKIE_NAME,
    // Имя из поля нужно только общему аккаунту: у именного автор — он сам.
    createSessionToken(agent, agent === SHARED_AGENT ? name : undefined),
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
