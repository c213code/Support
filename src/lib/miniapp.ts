import { createHmac, timingSafeEqual } from "crypto";

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

// Адрес мини-аппа для кнопки в боте — Telegram открывает web_app только по
// https. VERCEL_PROJECT_PRODUCTION_URL Vercel задаёт сам (без схемы, и даже
// в превью указывает на прод); PUBLIC_APP_URL — ручное переопределение
// (свой домен или туннель для локальной проверки).
export function miniAppUrl(): string | null {
  const override = process.env.PUBLIC_APP_URL?.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const base = override || (vercel ? `https://${vercel}` : null);
  return base ? `${base}/miniapp` : null;
}

export type MiniAppUser = { id: bigint; name: string };

// initData живёт, пока открыт мини-апп. Сутки с запасом покрывают "открыл,
// начал заполнять, отвлёкся", но не дают переиспользовать старую подпись.
const MAX_AGE_SECONDS = 24 * 60 * 60;

// Проверка initData по алгоритму Telegram (core.telegram.org/bots/webapps):
//   secret = HMAC_SHA256(ключ "WebAppData", сообщение — токен бота)
//   hash   = hex(HMAC_SHA256(ключ secret, сообщение — data_check_string))
// data_check_string — все поля, кроме hash, отсортированные по ключу, в виде
// "key=value" через перевод строки. Поле signature (подпись для сторонней
// проверки) в строку входит — исключается только hash.
export function verifyInitData(initData: string): MiniAppUser | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !initData) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
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
    return null;
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) {
    return null;
  }

  try {
    const user = JSON.parse(params.get("user") ?? "") as Record<string, unknown>;
    if (typeof user.id !== "number") return null;
    const fullName = [user.first_name, user.last_name]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .trim();
    const name =
      fullName || (typeof user.username === "string" ? `@${user.username}` : `id${user.id}`);
    return { id: BigInt(user.id), name: name.slice(0, 80) };
  } catch {
    return null;
  }
}
