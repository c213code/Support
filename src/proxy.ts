import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (verifySessionToken(token) !== null) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  // Запоминаем, куда шли: ссылка «Өтініш #…» из рабочей группы ведёт на
  // конкретный тикет, и без этого после входа дежурный оказывался на
  // главной, а тикет терялся. Только для страниц — у запроса к API
  // возвращаться некуда.
  const { pathname, search } = request.nextUrl;
  if (!pathname.startsWith("/api/") && pathname !== "/") {
    loginUrl.searchParams.set("next", `${pathname}${search}`);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // api/cron/* — свои эндпоинты Vercel Cron, аутентифицируются
    // отдельным CRON_SECRET-заголовком (см. api/cron/evening-report), у
    // них нет и не может быть сессионной куки агента.
    // /miniapp и /api/miniapp/* — форма обращения для кураторов внутри
    // Telegram: у них нет куки агента, автор проверяется по подписи
    // Telegram (initData, см. src/lib/miniapp.ts) в самом маршруте. Ровно
    // эти пути, а не всё, что начинается с этих букв: иначе будущий
    // /miniapp-admin молча оказался бы без входа.
    "/((?!login|api/auth/login|api/telegram/webhook|api/cron|miniapp$|miniapp/|api/miniapp/|_next/static|_next/image|favicon.ico).*)",
  ],
};
