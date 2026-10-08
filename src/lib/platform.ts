// Клиент к основной платформе JUZ40 (api.juz40-edu.kz) — отдельная система,
// НЕ наша БД. Инструменты дежурного: смена почты или номера ученику
// (/platform/change-email) и обнуление результата ДТ (/platform/reset-unt).
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
      | "phone_taken"
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

// Ученик по контакту — точное совпадение, а не «похоже»: search цепляет и
// куски имени, и по ним объявлять ученика найденным нельзя. У телефона
// сравниваем по цифрам — на платформе они записаны как попало («+7…»,
// «+7 ( (7) 77) …»), и пробуем два вида запроса: «+7…» и без кода страны
// (номер с «8…» платформа не находит вовсе).
const PHONE_TAIL = 9;

function phoneQueries(contact: string): string[] {
  let digits = contact.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  const local = digits.length === 11 ? digits.slice(1) : digits;
  return [...new Set([`+${digits}`, local])].filter((q) => q.length >= PHONE_TAIL);
}

export async function findStudentByContact(contact: string): Promise<StudentSummary | null> {
  const value = contact.trim();
  const isEmail = value.includes("@");
  const tail = value.replace(/\D/g, "").slice(-PHONE_TAIL);
  if (!isEmail && tail.length < PHONE_TAIL) return null;
  const matches = (user: StudentSummary) =>
    isEmail
      ? (user.email ?? "").toLowerCase() === value.toLowerCase()
      : (user.phoneNumber ?? "").replace(/\D/g, "").endsWith(tail);
  for (const query of isEmail ? [value] : phoneQueries(value)) {
    const found = (await searchStudents(query, 5)).find(matches);
    if (found) return found;
  }
  return null;
}

// Завершил ли ученик регистрацию: GET /v1/users/username/{логин}/registered —
// тот же запрос делает админ-панель, открывая аккаунт. false — аккаунт есть,
// но регистрация не закончена: на входе ученик видит «Сіз тіркелуді әлі
// аяқтамадыңыз», и чинить тут нечего — ему надо дойти по ссылке из SMS или
// почты. Эндпоинт понимает только логин (почту): по номеру и по
// несуществующему логину он тоже отвечает false, поэтому спрашиваем его
// только о найденном ученике и по его username. null — ответ не прочитан.
export async function isStudentRegistered(username: string): Promise<boolean | null> {
  const res = await authed(`/v1/users/username/${encodeURIComponent(username)}/registered`);
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as unknown;
  return typeof body === "boolean" ? body : null;
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
  // Потоки, к которым подключён ученик: пусто — курс ему не подключён.
  streams?: unknown[] | null;
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

// Сколько потоков подключено ученику — «курс көрінбейді» часто просто
// потому, что курс не подключён. null — прочитать не вышло.
export async function studentStreamCount(id: string): Promise<number | null> {
  const raw = await getStudentRaw(id).catch(() => null);
  return Array.isArray(raw?.streams) ? raw.streams.length : null;
}

export type ChangeEmailResult = {
  studentName: string;
  oldEmail: string | null;
  newEmail: string;
};

export type ChangePhoneResult = {
  studentName: string;
  oldPhone: string | null;
  newPhone: string;
};

// Тело записи /change из прочитанного профиля — ровно то, что шлёт сама
// админ-панель, с заменой только нужных полей.
function changeBody(u: StudentRaw, patch: { email?: string; phoneNumber?: string }) {
  return {
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
    email: patch.email ?? u.username,
    username: patch.email ?? u.username,
    phoneNumber: patch.phoneNumber ?? u.phoneNumber,
    googleMail: u.googleMail,
  };
}

// Запись через /change и подтверждение перечитыванием. HTTP 200 ещё не
// значит, что поле сменилось (эндпоинт мог тихо ничего не сделать), —
// иначе покажем зелёный «успех» на несделанную смену (тот молчаливый
// провал, о котором предупреждает CLAUDE.md). С несколькими попытками:
// чтение после записи у платформы отстаёт (реплика), и первая проверка
// ловила устаревшее значение — на живом тесте это давало ложный «не
// изменилась» при удавшейся смене.
async function writeAndConfirm(
  id: string,
  body: ReturnType<typeof changeBody>,
  what: { failed: string; unchanged: string },
  applied: (after: StudentRaw) => boolean
): Promise<void> {
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
    throw new PlatformError(`${what.failed} (HTTP ${res.status})`, "upstream_error");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    const after = await getStudentRaw(id).catch(() => null);
    if (after && applied(after)) return;
  }
  throw new PlatformError(
    `Платформа приняла запрос, но ${what.unchanged} — проверь вручную`,
    "upstream_error"
  );
}

function studentName(u: StudentRaw): string {
  return [u.firstname, u.lastname].filter(Boolean).join(" ").trim();
}

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

  // 2) read-modify-write целым объектом; 3) перечитать и подтвердить.
  const u = await getStudentRaw(id);
  await writeAndConfirm(
    id,
    changeBody(u, { email: newEmail }),
    { failed: "Смена почты не прошла", unchanged: "почта не изменилась" },
    (after) => (after.username ?? "").toLowerCase() === newEmail.toLowerCase()
  );
  return { studentName: studentName(u), oldEmail: u.username, newEmail };
}

// Смена номера — тот же /change, другое поле. newPhone уже приведён к
// "+7XXXXXXXXXX" (normalizeKzPhone): в таком виде его хранит платформа.
export async function changeStudentPhone(
  id: string,
  newPhone: string
): Promise<ChangePhoneResult> {
  // Номер, занятый другим учеником, — частая причина «номер өзгертсем
  // ошибка шығады»: скажем об этом прямо, а не кодом платформы. Как и у
  // почты, сбой самой предпроверки смену не блокирует.
  try {
    const existing = await searchStudents(newPhone, 5);
    const other = existing.find((s) => s.id !== id && s.phoneNumber === newPhone);
    if (other) {
      throw new PlatformError(
        `Этот номер уже у другого ученика (${[other.firstname, other.lastname].filter(Boolean).join(" ") || other.email || "без имени"})`,
        "phone_taken"
      );
    }
  } catch (err) {
    if (err instanceof PlatformError && err.code === "phone_taken") throw err;
    console.warn(
      `[platform] предпроверка занятости номера не удалась, полагаемся на платформу: ${String(err)}`
    );
  }

  const u = await getStudentRaw(id);
  await writeAndConfirm(
    id,
    changeBody(u, { phoneNumber: newPhone }),
    { failed: "Смена номера не прошла", unchanged: "номер не изменился" },
    (after) => after.phoneNumber === newPhone
  );
  return { studentName: studentName(u), oldPhone: u.phoneNumber, newPhone };
}

// --- деңгейлік тест (УНТ/ДТ): обнуление результата ---
//
// Ученики иногда закрывают ПИИ (персональные данные) до/во время сдачи, из-за
// чего попытка "залипает" в незавершённом виде и телефон/почта считаются
// занятыми валидацией при повторной попытке. Штатный путь агента поддержки —
// найти конкретный результат в отчёте по тесту и удалить его, если он уже
// ЗАВЕРШЁН (status "FINISHED" + реальный finishTime); удалять незавершённую
// попытку нельзя — ученик потеряет прогресс, а не мешающий валидации хвост.

export type UntTestSummary = {
  id: string;
  name: string;
  openTime: string | null;
  endTime: string | null;
  published: boolean;
};

export async function listUntTests(): Promise<UntTestSummary[]> {
  const res = await authed("/v1/unts");
  if (!res.ok) {
    throw new PlatformError(
      `Не удалось получить список тестов (HTTP ${res.status})`,
      "upstream_error"
    );
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) {
    throw new PlatformError(
      "Платформа вернула неожиданный формат списка тестов",
      "upstream_error"
    );
  }
  return (data as Record<string, unknown>[])
    .map((t) => ({
      id: String(t.id ?? ""),
      name: String(t.name ?? ""),
      openTime: typeof t.openTime === "string" ? t.openTime : null,
      endTime: typeof t.endTime === "string" ? t.endTime : null,
      published: Boolean(t.published),
    }))
    .filter((t) => t.id);
}

// Продукт (SMART/SMART-PRO/...) — это streamTypes слота теста, а не отдельно
// хранимое поле теста; тест может обслуживать несколько продуктов сразу
// разными слотами. Возвращаем уникальный список, чтобы UI мог выбрать сам,
// если он один, и спросить агента, если их несколько.
export async function getUntProducts(untId: string): Promise<string[]> {
  const res = await authed(`/v1/unts/${untId}`);
  if (res.status === 404) {
    throw new PlatformError("Тест не найден", "not_found");
  }
  if (!res.ok) {
    throw new PlatformError(`Не удалось прочитать тест (HTTP ${res.status})`, "upstream_error");
  }
  const data = (await res.json().catch(() => null)) as {
    slots?: Array<{ streamTypes?: unknown }>;
  } | null;
  const products = new Set<string>();
  for (const slot of data?.slots ?? []) {
    for (const p of Array.isArray(slot.streamTypes) ? slot.streamTypes : []) {
      if (typeof p === "string" && p) products.add(p);
    }
  }
  return [...products];
}

export type UntResultMatch = {
  resultId: string;
  fullName: string;
  combination: string | null;
  score: number;
};

// /report принимает student= и сам фильтрует по email/телефону на стороне
// платформы (это тот же параметр, что использует админ-панель) — здесь его
// не переизобретаем, только читаем результат.
//
// combinationId — тот же фильтр «Комбинация», что в админ-панели
// (combinationIds=): нужен, когда ищем не по почте, а по фамилии — без него
// однофамильцы со всего теста.
export async function findUntResults(
  untId: string,
  product: string,
  student: string,
  combinationId?: string
): Promise<UntResultMatch[]> {
  const params = new URLSearchParams({ product, student });
  if (combinationId) params.set("combinationIds", combinationId);
  const res = await authed(`/v1/unts/${untId}/report?${params}`);
  if (!res.ok) {
    throw new PlatformError(`Поиск результата не удался (HTTP ${res.status})`, "upstream_error");
  }
  const data = (await res.json().catch(() => null)) as { studentUntInfos?: unknown } | null;
  const list = Array.isArray(data?.studentUntInfos) ? data!.studentUntInfos : null;
  if (list === null) {
    throw new PlatformError("Платформа вернула неожиданный формат отчёта", "upstream_error");
  }
  return (list as Record<string, unknown>[])
    .map((r) => ({
      resultId: String(r.resultId ?? ""),
      fullName: String(r.fullName ?? "—"),
      combination: typeof r.combination === "string" ? r.combination : null,
      score: typeof r.score === "number" ? r.score : 0,
    }))
    .filter((r) => r.resultId);
}

// Запасной путь, когда по почте/телефону в отчёте пусто: результат ДТ мог
// лечь на другой аккаунт того же ученика (старая почта, второй аккаунт), и
// агент ищет его в отчёте руками — фильтр «Комбинация» + фамилия в поиске.
// Отсюда — то, что для этого нужно знать об ученике: имя, фамилия и id его
// комбинации. У ученика в профиле хранятся только два предмета
// (subjectCombination.first/second), а отчёт фильтрует по id комбинации из
// справочника /v2/subjects/combinations — сопоставляем по паре предметов
// без учёта порядка.
export type UntStudentFallback = {
  firstname: string | null;
  lastname: string | null;
  combinationId: string | null;
  combinationName: string | null;
};

type SubjectCombination = {
  id: string;
  name: string;
  firstId: string;
  secondId: string;
};

async function listSubjectCombinations(): Promise<SubjectCombination[]> {
  const res = await authed("/v2/subjects/combinations");
  if (!res.ok) {
    throw new PlatformError(
      `Не удалось получить комбинации предметов (HTTP ${res.status})`,
      "upstream_error"
    );
  }
  const data = (await res.json().catch(() => null)) as unknown;
  if (!Array.isArray(data)) {
    throw new PlatformError("Платформа вернула неожиданный формат комбинаций", "upstream_error");
  }
  return (data as Record<string, unknown>[])
    .map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      firstId: String((c.first as { id?: unknown } | null)?.id ?? ""),
      secondId: String((c.second as { id?: unknown } | null)?.id ?? ""),
    }))
    .filter((c) => c.id);
}

// null — ученика с таким контактом на платформе нет.
export async function findStudentUntFallback(
  contact: string
): Promise<UntStudentFallback | null> {
  const found = await findStudentByContact(contact);
  if (!found) return null;
  const raw = await getStudentRaw(found.id);
  const sc = raw.subjectCombination as
    | { id?: string; first?: { id?: string }; second?: { id?: string } }
    | null;

  let combination: SubjectCombination | null = null;
  const pair = [sc?.first?.id, sc?.second?.id].filter((id): id is string => Boolean(id));
  if (sc?.id || pair.length === 2) {
    const all = await listSubjectCombinations();
    combination =
      all.find((c) => c.id === sc?.id) ??
      all.find(
        (c) =>
          pair.length === 2 &&
          new Set([c.firstId, c.secondId, ...pair]).size === 2
      ) ??
      null;
  }

  return {
    firstname: raw.firstname?.trim() || null,
    lastname: raw.lastname?.trim() || null,
    combinationId: combination?.id ?? null,
    combinationName: combination?.name ?? null,
  };
}

export type UntResultStatus = {
  resultId: string;
  status: string;
  finishTime: string | null;
  studentEmail: string | null;
  studentName: string;
};

export async function getUntResultStatus(resultId: string): Promise<UntResultStatus> {
  const res = await authed(`/v1/unts/results/${resultId}/personal-report`);
  if (res.status === 404) {
    throw new PlatformError("Результат не найден — возможно, уже удалён", "not_found");
  }
  if (!res.ok) {
    throw new PlatformError(`Не удалось прочитать результат (HTTP ${res.status})`, "upstream_error");
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data || typeof data.id !== "string") {
    throw new PlatformError("Платформа вернула неожиданный формат результата", "upstream_error");
  }
  const student = (data.student ?? {}) as Record<string, unknown>;
  return {
    resultId: data.id,
    status: typeof data.status === "string" ? data.status : "",
    finishTime: typeof data.finishTime === "string" ? data.finishTime : null,
    studentEmail: typeof student.username === "string" ? student.username : null,
    studentName: typeof student.fullName === "string" ? student.fullName : "",
  };
}

export async function deleteUntResult(resultId: string): Promise<void> {
  const res = await authed(`/v1/unts/results/${resultId}`, { method: "DELETE" });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    console.warn(`[platform] DELETE /unts/results/${resultId} HTTP ${res.status}: ${detail}`);
    throw new PlatformError(`Удаление не прошло (HTTP ${res.status})`, "upstream_error");
  }
}
