// Готовность формы мини-аппа к пилоту: одна команда вместо десяти проверок
// руками. Запуск:
//
//   npm run pilot            — конфигурация, связь, справочник ярлыков
//   npm run pilot -- --e2e   — плюс сквозная подача обращения на дев-сервере
//
// Ничего не меняет в боевых данных: сквозной прогон создаёт обращение с
// префиксом ТЕСТ- и удаляет его вместе с тикетом в конце. Значения ключей
// никогда не печатаются — только «задан / не задан».
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { OFFICIAL_GROUPS } from "@/lib/groups";
import { platformEnabled, searchStudents } from "@/lib/platform";
import { submissionFormEnabled } from "@/lib/miniapp";
import {
  LABELS_BY_GROUP,
  fieldVisible,
  type LabelField,
  type SubmissionLabel,
} from "@/lib/submissionLabels";

const BASE = process.env.PILOT_BASE ?? "http://localhost:3000";
const E2E = process.argv.includes("--e2e");
// Сквозной прогон подаёт обращение от этого Telegram-пользователя.
const E2E_USER_ID = 900000777;

let problems = 0;
let warnings = 0;

function ok(text: string, detail = "") {
  console.log(`  ✅ ${text}${detail ? ` — ${detail}` : ""}`);
}
function warn(text: string, detail = "") {
  warnings += 1;
  console.log(`  ⚠️  ${text}${detail ? ` — ${detail}` : ""}`);
}
function fail(text: string, detail = "") {
  problems += 1;
  console.log(`  ❌ ${text}${detail ? ` — ${detail}` : ""}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}

// --- 1. Переменные окружения -------------------------------------------------

function checkEnv() {
  section("1. Настройки");

  const required: Array<[string, string]> = [
    ["DATABASE_URL", "база"],
    ["SESSION_SECRET", "вход на сайт"],
    ["TELEGRAM_BOT_TOKEN", "бот"],
    ["TELEGRAM_STORAGE_CHAT_ID", "канал для скриншотов"],
    ["TELEGRAM_WEBHOOK_SECRET", "защита вебхука"],
  ];
  for (const [key, what] of required) {
    const value = process.env[key];
    if (value && value.trim()) ok(`${key} задан`, what);
    else fail(`${key} не задан`, `без него ${what} не работает`);
  }

  const optional: Array<[string, string]> = [
    ["PLATFORM_API_URL", "инструменты платформы"],
    ["PLATFORM_SERVICE_USERNAME", "инструменты платформы"],
    ["PLATFORM_SERVICE_PASSWORD", "инструменты платформы"],
    ["AGENT_TELEGRAM_IDS", "уведомления дежурному об ответах куратора"],
  ];
  for (const [key, what] of optional) {
    const value = process.env[key];
    if (value && value.trim()) ok(`${key} задан`, what);
    else warn(`${key} не задан`, `${what} будет отключено`);
  }

  if (submissionFormEnabled()) ok("форма мини-аппа включена");
  else fail("форма мини-аппа выключена", "нужен TELEGRAM_STORAGE_CHAT_ID");
}

// --- 2. Связь с Telegram и платформой ---------------------------------------

async function checkTelegram() {
  section("2. Telegram");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    fail("токен не задан — проверить бота нечем");
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) ok("бот отвечает", `@${data.result.username}`);
    else fail("бот не отвечает на getMe", "токен неверный или отозван");
  } catch (err) {
    fail("не достучались до Telegram", err instanceof Error ? err.name : "ошибка сети");
    return;
  }

  const storage = process.env.TELEGRAM_STORAGE_CHAT_ID;
  if (!storage) return;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/getChat?chat_id=${encodeURIComponent(storage)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    const data = (await res.json()) as { ok?: boolean; description?: string };
    if (data.ok) ok("канал для скриншотов доступен боту");
    else fail("канал для скриншотов недоступен", data.description ?? "getChat не прошёл");
  } catch {
    fail("канал для скриншотов проверить не удалось", "сеть");
  }
}

async function checkPlatform() {
  section("3. Платформа");
  if (!platformEnabled()) {
    warn("инструменты платформы выключены", "проверка занятости контакта работать не будет");
    return;
  }
  try {
    await searchStudents("test-pilot-check@example.invalid", 1);
    ok("поиск на платформе работает", "автопроверка нового номера и почты включится");
  } catch (err) {
    fail("платформа не ответила", String(err).slice(0, 80));
  }
}

// --- 3. База ----------------------------------------------------------------

async function checkDatabase() {
  section("4. База");
  try {
    const submissions = await prisma.issueSubmission.count();
    ok("база отвечает", `обращений из формы: ${submissions}`);
  } catch (err) {
    fail("база недоступна", String(err).slice(0, 80));
    return;
  }

  // Поля ярлыков появились миграцией 20260918090000 — если её не накатили,
  // форма упадёт на первой же отправке.
  try {
    await prisma.issueSubmission.findFirst({ select: { labelId: true, labelFields: true } });
    ok("миграция с полями ярлыков накачена");
  } catch {
    fail("в базе нет колонок labelId / labelFields", "выполните prisma migrate deploy");
  }

  const presets = await prisma.groupPreset.findMany({ select: { name: true, chatId: true } });
  for (const group of OFFICIAL_GROUPS) {
    const preset = presets.find((p) => p.name === group.name);
    if (!preset) fail(`группа «${group.name}» не заведена`, "нужен seed");
    else if (!preset.chatId) {
      warn(`группа «${group.name}» не привязана к чату`, "обращения из формы придут, из чата — нет");
    } else ok(`группа «${group.name}» привязана к чату`);
  }
}

// --- 4. Справочник ярлыков --------------------------------------------------

function checkLabels() {
  section("5. Ярлыки");

  for (const [groupName, labels] of Object.entries(LABELS_BY_GROUP)) {
    const ids = labels.map((l) => l.id);
    if (new Set(ids).size !== ids.length) {
      fail(`«${groupName}»: повторяются id ярлыков`, ids.join(", "));
      continue;
    }
    if (!labels.some((l) => l.id === "other")) {
      fail(`«${groupName}»: нет «Басқа мәселе»`, "часть обращений не в какую категорию не влезет");
      continue;
    }
    if (labels.length > 12) {
      warn(`«${groupName}»: ярлыков ${labels.length}`, "список на телефоне станет длинным");
    }

    for (const label of labels) {
      checkLabelFields(groupName, label);
    }
    ok(`«${groupName}»: ${labels.length} ярлыков, поля согласованы`);
  }
}

function checkLabelFields(groupName: string, label: SubmissionLabel) {
  const where = `«${groupName}» → «${label.title}»`;
  const byId = new Map<string, LabelField[]>();
  for (const field of label.fields) {
    byId.set(field.id, [...(byId.get(field.id) ?? []), field]);
  }

  for (const field of label.fields) {
    if (!field.label.trim()) fail(`${where}: поле «${field.id}» без подписи`);

    // Условие показа должно ссылаться на поле того же ярлыка, иначе поле
    // не покажется никогда.
    if (field.showIf) {
      const source = byId.get(field.showIf.field);
      if (!source) {
        fail(`${where}: «${field.id}» зависит от несуществующего «${field.showIf.field}»`);
        continue;
      }
      const options = source.flatMap((f) => f.options?.map((o) => o.value) ?? []);
      const unknown = field.showIf.equals.filter((v) => !options.includes(v));
      if (unknown.length > 0) {
        fail(`${where}: «${field.id}» ждёт значений, которых нет в списке`, unknown.join(", "));
      }
    }

    if (field.type === "select" && (field.options ?? []).length < 2) {
      fail(`${where}: у выбора «${field.id}» меньше двух вариантов`);
    }
    if (field.checkOccupancy && field.type !== "phone" && field.type !== "email") {
      fail(`${where}: автопроверка стоит на поле «${field.id}» типа ${field.type}`);
    }
    if (field.type === "photos" && field.required && (field.minPhotos ?? 1) < 1) {
      fail(`${where}: обязательные скрины с minPhotos = 0`);
    }
  }

  // Ярлык без обязательных полей ничего не собирает — это пустая категория.
  const hasRequired = label.fields.some((f) => f.required);
  if (!hasRequired) warn(`${where}: ни одного обязательного поля`);

  // Заполнимость: при пустых ответах должно быть видно хотя бы одно поле.
  const visibleAtStart = label.fields.filter((f) => fieldVisible(f, {}));
  if (visibleAtStart.length === 0) {
    fail(`${where}: при открытии не видно ни одного поля`);
  }
}

// --- 5. Сквозная подача (--e2e) ---------------------------------------------

function signedInitData(userId: number, token: string): string {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAE-pilot",
    user: JSON.stringify({ id: userId, first_name: "ТЕСТ-пилот" }),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

// 1×1 PNG — картинка, которую примет Telegram.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64"
);

async function checkEndToEnd() {
  section("6. Сквозная подача (--e2e)");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    fail("нет токена — подписать initData нечем");
    return;
  }

  const form = new FormData();
  form.append("initData", signedInitData(E2E_USER_ID, token));
  form.append("submissionId", `pilot-${Date.now()}`);
  form.append("groupName", "Сату - Платформа");
  form.append("labelId", "phone-change");
  form.append(
    "labelFields",
    JSON.stringify({
      oldKind: "phone",
      oldPhone: "+7 (700) 000 00 01",
      newPhone: "+7 (700) 000 00 02",
      occupied: "no",
    })
  );
  form.append("photo", new Blob([PNG], { type: "image/png" }), "pilot.png");

  let issueId: string | null = null;
  try {
    const res = await fetch(`${BASE}/api/miniapp/submit`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; issueId?: string; error?: string }
      | null;
    if (res.ok && data?.ok && data.issueId) {
      issueId = data.issueId;
      ok("обращение подано через форму", `тикет ${issueId}`);
    } else {
      // Чаще всего сюда попадают с тестовым токеном: фото не уходит в канал,
      // и маршрут отвечает «форма настроена неверно». Говорим прямо, иначе
      // выглядит как поломка самой формы.
      const hint =
        res.status === 503 || res.status === 502
          ? "фото не ушло в Telegram: нужен боевой TELEGRAM_BOT_TOKEN и бот-админ в канале"
          : (data?.error ?? `http ${res.status}`);
      fail("форма не приняла обращение", hint);
      return;
    }
  } catch (err) {
    fail(
      "дев-сервер недоступен",
      `${BASE} — запустите npm run dev (${err instanceof Error ? err.name : "ошибка"})`
    );
    return;
  }

  try {
    const submission = await prisma.issueSubmission.findFirst({
      where: { issueId },
      select: { labelId: true, labelFields: true, studentContact: true, rawText: true },
    });
    if (submission?.labelId === "phone-change") ok("ярлык сохранён");
    else fail("ярлык не сохранён", String(submission?.labelId));

    const values = (submission?.labelFields ?? {}) as Record<string, string>;
    if (values.newPhone?.includes("000 00 02")) ok("поля ярлыка сохранены");
    else fail("поля ярлыка не сохранены");

    if (submission?.rawText.includes("Жаңа номер")) ok("расшифровка полей попала в заявку");
    else fail("в заявке нет расшифровки полей");

    const issue = await prisma.issue.findUnique({
      where: { id: issueId! },
      select: { description: true, status: true },
    });
    if (issue?.description.includes("Номер өзгерту")) ok("описание тикета — название проблемы");
    else fail("в описании тикета нет названия проблемы", issue?.description.slice(0, 60));
    if (issue?.status === "SENT") ok("тикет встал в «Отправлено»");
  } finally {
    if (issueId) {
      await prisma.issue.delete({ where: { id: issueId } }).catch(() => {});
      const left = await prisma.issue.count({ where: { id: issueId } });
      if (left === 0) ok("тестовое обращение удалено");
      else fail("тестовое обращение осталось в базе", issueId);
    }
  }
}

// --- Запуск -----------------------------------------------------------------

async function main() {
  console.log("Проверка готовности формы к пилоту\n" + "=".repeat(40));

  checkEnv();
  await checkTelegram();
  await checkPlatform();
  await checkDatabase();
  checkLabels();
  if (E2E) await checkEndToEnd();
  else console.log("\n6. Сквозная подача пропущена — добавьте --e2e при запущенном dev-сервере");

  console.log("\n" + "=".repeat(40));
  if (problems === 0 && warnings === 0) {
    console.log("Готово к пилоту: всё на месте.");
  } else if (problems === 0) {
    console.log(`Готово к пилоту, но с оговорками: предупреждений — ${warnings}.`);
  } else {
    console.log(`К пилоту не готово: проблем — ${problems}, предупреждений — ${warnings}.`);
  }
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Проверка упала:", String(err).slice(0, 300));
  process.exit(1);
});
