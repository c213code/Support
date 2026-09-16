// GET к своему API с честным результатом вместо исключения.
//
// Когда сессия истекла, proxy.ts отвечает на запрос к API редиректом на
// /login: fetch молча идёт за редиректом и получает HTML-страницу входа со
// статусом 200. Голый `res.json()` на ней падал, ошибку никто не ловил, и
// экран просто переставал обновляться. Здесь этот случай различим
// (reason: "session"), чтобы вызывающий мог показать «войдите снова».
// error — текст из тела ответа ({ error: "..." }), если сервер его прислал.
// Нужен там, где причину должен увидеть человек: «Telegram не принял
// сообщение» — это не общий сбой, а руководство к действию (см.
// SubmissionChat.tsx). Без него любой отказ выглядел бы одинаково.
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "session" | "http" | "network"; error?: string };

export async function fetchApiJson<T>(
  url: string,
  init?: RequestInit
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    console.warn(`[api] ${url} не загрузился:`, err);
    return { ok: false, reason: "network" };
  }
  if (isSessionLost(res)) return { ok: false, reason: "session" };
  if (!res.ok) {
    console.warn(`[api] ${url} → ${res.status}`);
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, reason: "http", error: body?.error };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    console.warn(`[api] ${url}: ответ не JSON`);
    return { ok: false, reason: "http" };
  }
}

// Ответ означает «сессии нет»: редирект на вход или 401. Для POST это
// особенно важно — редирект заканчивается страницей входа со статусом 200, и
// `res.ok` выглядел бы как успешное сохранение.
export function isSessionLost(res: Response): boolean {
  return res.redirected || res.status === 401;
}
