// Клиент к основной платформе JUZ40 (api.juz40-edu.kz) — отдельная система,
// НЕ наша БД. Пока используется только для смены почты ученику через
// инструмент /platform/change-email.
//
// Аутентификация — сервис-аккаунтом (env), а не токеном конкретного агента:
// логинимся раз, кэшируем JWT до истечения, релогинимся при 401. Креды живут
// только на сервере (env-переменные), в клиент не попадают.
//
// Ключевое про смену почты: эндпоинт /change принимает ВЕСЬ объект
// пользователя (а не одно поле), поэтому меняем по схеме read-modify-write —
// читаем текущий объект и переотправляем его целиком, поменяв только почту.
// Маппинг чтения (GET /v2/users/{id}, вложенный) в тело записи (плоское)
// сверен байт-в-байт с тем, что шлёт сама админ-панель, включая parentFirst/
// Lastname = null: инструмент делает ровно то же, что человек в UI.

const DEVICE_HEADER = { "X-Device-Name": "WEB" } as const;
const TIMEOUT_MS = 10000;
// Обновляем токен заранее, чтобы не отправить запрос с истекающим на лету JWT.
const TOKEN_REFRESH_SKEW_MS = 60_000;

export function platformEnabled(): boolean {
  return Boolean(
    process.env.PLATFORM_API_URL &&
      process.env.PLATFORM_SERVICE_USERNAME &&
      process.env.PLATFORM_SERVICE_PASSWORD
  );
}

function baseUrl(): string {
  const url = process.env.PLATFORM_API_URL;
  if (!url) throw new Error("PLATFORM_API_URL is not set");
  return url.replace(/\/+$/, "");
}

// Ошибка вызова платформы с машиночитаемым кодом — роут по нему отдаёт
// осмысленный статус вместо молчаливого отката (см. CLAUDE.md про то, как
// молчаливый fallback уже кусал в ИИ-функциях).
export class PlatformError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "auth_failed"
      | "not_found"
      | "email_taken"
      | "upstream_error"
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

async function platformFetch(
  path: string,
  init: RequestInit & { auth?: string }
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...DEVICE_HEADER,
        ...(init.auth ? { Authorization: `Bearer ${init.auth}` } : {}),
        ...init.headers,
      },
    });
  } catch (err) {
    throw new PlatformError(
      `Платформа недоступна: ${String(err)}`,
      "upstream_error"
    );
  } finally {
    clearTimeout(timeout);
  }
}

// --- токен сервис-аккаунта: логин + кэш ---

let cached: { token: string; expMs: number } | null = null;

function jwtExpiryMs(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8")
    );
    // exp в секундах; если поля нет — считаем, что живёт час.
    return typeof payload.exp === "number"
      ? payload.exp * 1000
      : Date.now() + 3_600_000;
  } catch {
    return Date.now() + 3_600_000;
  }
}

async function login(): Promise<string> {
  const res = await platformFetch("/v1/auth/signin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.PLATFORM_SERVICE_USERNAME,
      password: process.env.PLATFORM_SERVICE_PASSWORD,
      fcmToken: "",
    }),
  });
  if (!res.ok) {
    throw new PlatformError(
      `Логин сервис-аккаунта не прошёл (HTTP ${res.status})`,
      "auth_failed"
    );
  }
  const data = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!data?.token) {
    throw new PlatformError("Логин не вернул токен", "auth_failed");
  }
  cached = { token: data.token, expMs: jwtExpiryMs(data.token) };
  return data.token;
}

async function token(): Promise<string> {
  if (cached && Date.now() < cached.expMs - TOKEN_REFRESH_SKEW_MS) {
    return cached.token;
  }
  return login();
}

// Запрос с токеном; на 401 (токен отозвали/сменился секрет) один раз
// перелогиниваемся и повторяем — иначе кэш мог бы держать мёртвый токен.
async function authed(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  let res = await platformFetch(path, { ...init, auth: await token() });
  if (res.status === 401) {
    cached = null;
    res = await platformFetch(path, { ...init, auth: await login() });
  }
  return res;
}

// --- операции над учениками ---

export type StudentSummary = {
  id: string;
  firstname: string | null;
  lastname: string | null;
  email: string | null; // это же логин (username в платформе)
  phoneNumber: string | null;
  googleMail: string | null;
};

function toSummary(u: Record<string, unknown>): StudentSummary {
  return {
    id: String(u.id ?? ""),
    firstname: (u.firstname as string) ?? null,
    // почта = username: у платформы нет отдельного поля email в ответе,
    // логин и почта — одно и то же (см. change: email и username идут вместе).
    lastname: (u.lastname as string) ?? null,
    email: (u.username as string) ?? (u.email as string) ?? null,
    phoneNumber: (u.phoneNumber as string) ?? null,
    googleMail: (u.googleMail as string) ?? null,
  };
}

export async function searchStudents(
  query: string,
  limit = 10
): Promise<StudentSummary[]> {
  const res = await authed(
    `/v1/users?page=0&size=${limit}&search=${encodeURIComponent(query)}`
  );
  if (!res.ok) {
    throw new PlatformError(
      `Поиск не удался (HTTP ${res.status})`,
      "upstream_error"
    );
  }
  const data = (await res.json().catch(() => undefined)) as unknown;
  if (data === undefined) {
    throw new PlatformError("Поиск вернул нечитаемый ответ", "upstream_error");
  }
  // Форма ответа у Spring может быть Page ({content}), обёрткой ({data}) или
  // голым массивом — нормализуем, не завязываясь на одну. Но если ни одна не
  // подошла — это НЕ «пустой список», а неожиданный формат: падаем, а не
  // выдаём «никого не нашли» (иначе сбой поиска выглядит как пустой
  // результат, а как ещё и молча отключает предпроверку занятости почты).
  const d = data as { content?: unknown; data?: unknown };
  const list = Array.isArray(data)
    ? data
    : Array.isArray(d.content)
      ? d.content
      : Array.isArray(d.data)
        ? d.data
        : null;
  if (list === null) {
    throw new PlatformError("Неожиданный формат ответа поиска", "upstream_error");
  }
  return (list as Record<string, unknown>[]).map(toSummary);
}

// Полный объект ученика (вложенный) — источник для read-modify-write.
type StudentRaw = {
  id: string;
  roles: string[] | null;
  username: string | null;
  firstname: string | null;
  lastname: string | null;
  instagramLink: string | null;
  profilePhotoUrl: string | null;
  phoneNumber: string | null;
  googleMail: string | null;
  grade: string | null;
  learningGoal: string | null;
  subjectCombination: { first?: { id: string }; second?: { id: string } } | null;
  region: { id: string } | null;
  school: { id: string } | null;
  parent: { phoneNumber: string | null } | null;
};

async function getStudentRaw(id: string): Promise<StudentRaw> {
  const res = await authed(`/v2/users/${id}?role=STUDENT`);
  if (res.status === 404) {
    throw new PlatformError("Ученик не найден", "not_found");
  }
  if (!res.ok) {
    throw new PlatformError(
      `Не удалось прочитать ученика (HTTP ${res.status})`,
      "upstream_error"
    );
  }
  // Этот объект уходит в read-modify-write целиком, поэтому мусорный/чужой
  // ответ = молчаливое затирание профиля ученика. Не строим тело записи из
  // непроверенного чтения: если ответ не распарсился, это не тот id, это не
  // ученик, или нет логина (поля, на которые опирается запись) — падаем, а
  // не пишем.
  const raw = (await res.json().catch(() => null)) as StudentRaw | null;
  if (!raw || typeof raw !== "object") {
    throw new PlatformError("Платформа вернула нечитаемый ответ", "upstream_error");
  }
  if (String(raw.id ?? "") !== id) {
    throw new PlatformError(
      "Платформа вернула не того ученика — смена отменена",
      "upstream_error"
    );
  }
  if (raw.roles != null && !raw.roles.includes("STUDENT")) {
    throw new PlatformError("Это не аккаунт ученика", "not_found");
  }
  if (typeof raw.username !== "string" || !raw.username) {
    throw new PlatformError(
      "Ответ платформы без ожидаемых полей — смена отменена, чтобы не затереть данные",
      "upstream_error"
    );
  }
  return raw;
}

export type ChangeEmailResult = {
  studentName: string;
  oldEmail: string | null;
  newEmail: string;
};

export async function changeStudentEmail(
  id: string,
  newEmail: string
): Promise<ChangeEmailResult> {
  // 1) не даём увести почту, уже занятую другим учеником. Это удобная
  // предпроверка, но НЕ она обеспечивает уникальность — её гарантирует сама
  // платформа (и мы перепроверяем результат в п.3). Поэтому сбой самого
  // поиска не должен блокировать смену под видом «поиск не удался»: ловим
  // его отдельно от реального «почта занята» и продолжаем.
  try {
    const existing = await searchStudents(newEmail, 5);
    if (
      existing.some(
        (s) => s.id !== id && s.email?.toLowerCase() === newEmail.toLowerCase()
      )
    ) {
      throw new PlatformError(
        "Эта почта уже занята другим учеником",
        "email_taken"
      );
    }
  } catch (err) {
    if (err instanceof PlatformError && err.code === "email_taken") throw err;
    console.warn(
      `[platform] предпроверка занятости почты не удалась, полагаемся на платформу: ${String(err)}`
    );
  }

  // 2) read-modify-write целым объектом.
  const u = await getStudentRaw(id);
  const body = {
    id: u.id,
    firstname: u.firstname,
    lastname: u.lastname,
    // Панель шлёт null в оба parent-поля (ФИО родителя ведётся отдельно),
    // повторяем — иначе поведение разойдётся с UI.
    parentFirstname: null,
    parentLastname: null,
    instagramLink: u.instagramLink,
    profilePhotoUrl: u.profilePhotoUrl,
    firstSubjectId: u.subjectCombination?.first?.id ?? null,
    secondSubjectId: u.subjectCombination?.second?.id ?? null,
    parentPhoneNumber: u.parent?.phoneNumber ?? null,
    regionId: u.region?.id ?? null,
    schoolId: u.school?.id ?? null,
    grade: u.grade,
    learningGoal: u.learningGoal,
    // email и username — одно и то же (логин ученика), меняются вместе.
    email: newEmail,
    username: newEmail,
    phoneNumber: u.phoneNumber,
    googleMail: u.googleMail,
  };

  const res = await authed(`/v1/admin/users/${id}/change`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Тело ответа платформы может нести внутренние детали/трейсы — логируем
    // на сервере, но наружу отдаём общий текст (клиент увидит только его).
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.warn(`[platform] /change HTTP ${res.status}: ${detail}`);
    throw new PlatformError(
      `Смена почты не прошла (HTTP ${res.status})`,
      "upstream_error"
    );
  }

  // 3) HTTP 200 ещё не значит, что почта сменилась (эндпоинт мог тихо
  // ничего не сделать). Перечитываем и подтверждаем — иначе покажем зелёный
  // «успех» на несделанную смену (ровно тот молчаливый провал, о котором
  // предупреждает CLAUDE.md). С несколькими попытками: чтение после записи у
  // платформы отстаёт (реплика), и первая проверка ловит устаревшее значение
  // — на живом тесте это давало ложный «не изменилась» при удавшейся смене.
  let confirmed = false;
  for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    const after = await getStudentRaw(id).catch(() => null);
    if (after && (after.username ?? "").toLowerCase() === newEmail.toLowerCase()) {
      confirmed = true;
    }
  }
  if (!confirmed) {
    throw new PlatformError(
      "Платформа приняла запрос, но почта не изменилась — проверь вручную",
      "upstream_error"
    );
  }

  return {
    studentName: [u.firstname, u.lastname].filter(Boolean).join(" ").trim(),
    oldEmail: u.username,
    newEmail,
  };
}
