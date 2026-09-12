import { createHmac, timingSafeEqual } from "crypto";
import { setWebAppMenuButton } from "@/lib/telegram";

// Мини-апп Telegram для кураторов: подать обращение формой, а не сообщением
// в рабочую группу (страница /miniapp, приём — POST /api/miniapp/submit).
//
// Кто подаёт — узнаём из initData: Telegram подписывает её токеном бота,
// поэтому имя и id автора подделать нельзя. Паролей здесь нет и не нужно —
// заводить аккаунты сотне кураторов было бы отдельной проблемой.

// Фото из формы хранит Telegram: бот кладёт его в закрытый канал, у нас
// остаётся только file_id. Пока канал не задан — форма выключена целиком
// (тот же принцип, что у platformEnabled: фича катится выключенной).
export function submissionFormEnabled(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_STORAGE_CHAT_ID
  );
}

// Адрес мини-аппа для кнопки в боте. VERCEL_PROJECT_PRODUCTION_URL Vercel
// задаёт сам (без схемы, и даже в превью указывает на прод); PUBLIC_APP_URL —
// ручное переопределение (свой домен или туннель для проверки).
//
// Telegram принимает web_app-кнопку только с https: адрес без схемы или с
// http:// он молча отвергнет, и куратор не получит на /start вообще ничего.
// Поэтому неверный адрес ловим здесь и пишем в лог ошибкой, а не надеемся на
// Telegram. Вызывается только при включённой форме.
export function miniAppUrl(): string | null {
  const override = process.env.PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const base = override || (vercel ? `https://${vercel}` : null);
  if (!base) {
    console.error(
      "[miniapp] форма включена, но адреса для кнопки нет: задайте PUBLIC_APP_URL (на Vercel он берётся из VERCEL_PROJECT_PRODUCTION_URL)"
    );
    return null;
  }
  try {
    const url = new URL(`${base}/miniapp`);
    if (url.protocol !== "https:") throw new Error("не https");
    return url.toString();
  } catch {
    console.error(`[miniapp] неверный адрес мини-аппа "${base}" — нужен полный адрес с https://`);
    return null;
  }
}

// Подпись кнопки меню бота. Коротко: Telegram показывает её в узкой кнопке
// слева от поля ввода.
export const MINI_APP_BUTTON_TEXT = "Өтініш";

// Кнопка меню должна открывать форму всегда, а не только сразу после /start.
// Telegram возвращает на её место меню команд (например, когда у бота есть
// команды для этого чата), и вернуть кнопку потом некому — куратор просто
// перестаёт её видеть. Поэтому переставляем на каждое сообщение боту в личке:
// один дешёвый вызов, зато кнопка не исчезает.
export async function ensureMiniAppMenuButton(chatId: number): Promise<void> {
  if (!submissionFormEnabled()) return;
  const url = miniAppUrl();
  if (!url) return;
  await setWebAppMenuButton(chatId, MINI_APP_BUTTON_TEXT, url);
}

export type MiniAppUser = { id: bigint; name: string };

// Почему initData не принята. Маршрут пишет причину в лог и по ней выбирает
// текст для куратора: "открыто слишком давно" он исправит сам (переоткроет
// форму), а "подпись не сошлась" — нет, это чаще настройка, чем подделка.
export type InitDataCheck =
  | { ok: true; user: MiniAppUser }
  | { ok: false; reason: "no_token" | "no_hash" | "bad_hash" | "expired" | "bad_user" };

// Сутки — компромисс: хватает на "открыл, отвлёкся, дописал", а подпись
// старше суток не примем. В пределах суток повтор той же initData возможен —
// его сдерживает лимит попыток в час (POST /api/miniapp/submit).
const MAX_AGE_SECONDS = 24 * 60 * 60;

// Проверка initData по алгоритму Telegram (core.telegram.org/bots/webapps):
//   secret = HMAC_SHA256(ключ "WebAppData", сообщение — токен бота)
//   hash   = hex(HMAC_SHA256(ключ secret, сообщение — data_check_string))
// data_check_string — все поля, кроме hash, отсортированные по ключу, в виде
// "key=value" через перевод строки. Поле signature (подпись для сторонней
// проверки) в строку входит — исключается только hash.
export function verifyInitData(initData: string): InitDataCheck {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, reason: "no_token" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "no_hash" };
  params.delete("hash");

  // Сортируем по ключу, а не строки "key=value" целиком: "=" в ASCII стоит
  // раньше букв, но позже цифр, и сортировка строк разошлась бы с
  // сортировкой ключей на ключах вида "a" / "a1".
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const hashBuf = Buffer.from(hash);
  if (expectedBuf.length !== hashBuf.length || !timingSafeEqual(expectedBuf, hashBuf)) {
    return { ok: false, reason: "bad_hash" };
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return { ok: false, reason: "expired" };
  }

  try {
    const user = JSON.parse(params.get("user") ?? "") as Record<string, unknown>;
    if (typeof user.id !== "number") return { ok: false, reason: "bad_user" };
    const fullName = [user.first_name, user.last_name]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .trim();
    const name =
      fullName || (typeof user.username === "string" ? `@${user.username}` : `id${user.id}`);
    return { ok: true, user: { id: BigInt(user.id), name: name.slice(0, 80) } };
  } catch {
    return { ok: false, reason: "bad_user" };
  }
}
