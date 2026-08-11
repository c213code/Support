import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (verifySessionToken(token) !== null) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // api/cron/* — свои эндпоинты Vercel Cron, аутентифицируются
    // отдельным CRON_SECRET-заголовком (см. api/cron/evening-report), у
    // них нет и не может быть сессионной куки агента.
    "/((?!login|api/auth/login|api/telegram/webhook|api/cron|_next/static|_next/image|favicon.ico).*)",
  ],
};
