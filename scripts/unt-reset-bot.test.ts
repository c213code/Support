import assert from "node:assert/strict";
import { test } from "node:test";
import { prisma } from "../src/lib/prisma";
import {
  extractUntResetStudents,
  requestUntResetApproval,
  handleUntResetCallback,
} from "../src/lib/untResetBot";

test("разбор сообщения: карточка только при слове БТ/ДТ и данных ученика", () => {
  assert.equal(extractUntResetStudents("Сәлеметсіз бе, курс ашылмай тұр ali@example.test").length, 0);
  // «бт» внутри слова — не ключевое слово.
  assert.equal(extractUntResetStudents("Субтитр жоқ ali@example.test").length, 0);
  assert.equal(extractUntResetStudents("БТ қайта ашып беріңізші").length, 0);

  const byEmail = extractUntResetStudents("БТ қайта ашып беріңізші\nAli@Example.test");
  assert.equal(byEmail.length, 1);
  assert.deepEqual(byEmail[0].emails, ["ali@example.test"]);

  const byPhone = extractUntResetStudents("деңгейлік тестті өшіріп беріңізші 8 700 000 00 01");
  assert.deepEqual(byPhone[0].phones, ["+77000000001"]);

  const byName = extractUntResetStudents("ДТ нәтижесін өшіріп беріңізші\nАсанов Али");
  assert.equal(byName.length, 1);
  assert.equal(byName[0].name, "Асанов Али");
  assert.equal(byName[0].emails.length + byName[0].phones.length, 0);

  const two = extractUntResetStudents("БТ өшіру керек\nali@example.test\nbota@example.test");
  assert.equal(two.length, 2);
});

type Row = Record<string, unknown>;

// Фейковая платформа + Telegram + база: всё, что модуль трогает снаружи.
function harness() {
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: "fixture", AGENT_TELEGRAM_IDS: "Ерош:123", OWN_AGENT_TELEGRAM_IDS: "123",
    PLATFORM_API_URL: "https://platform.example.test",
    PLATFORM_SERVICE_USERNAME: "fixture", PLATFORM_SERVICE_PASSWORD: "fixture",
  });
  const state = {
    enabled: true,
    sourceText: "",
    telegram: [] as Row[],
    rows: new Map<string, Row>(),
    audit: [] as Row[],
    deletes: [] as string[],
    // resultId → строка отчёта и её статус на платформе
    results: new Map<string, { untId: string; fullName: string; email: string; score: number; status: string; finishTime: string | null }>(),
    counter: 100,
    accounts: [] as Array<{ id: string; roles: string[]; username: string; firstname: string; lastname: string }>,
  };
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19);
  const tests = [
    { id: "unt-smart", name: "SMART ҚАРАША БТ", openTime: iso(now - 3600e3), endTime: iso(now + 3600e3), published: true, product: "SMART" },
    { id: "unt-junior", name: "JUNIOR БТ ҚАРАША", openTime: iso(now - 3600e3), endTime: iso(now + 3600e3), published: true, product: "JUNIOR" },
    { id: "unt-old", name: "SMART ҚАЗАН БТ", openTime: iso(now - 30 * 86400e3), endTime: iso(now - 29 * 86400e3), published: true, product: "SMART" },
  ];
  const restores: Array<() => void> = [];
  const stub = (model: object, method: string, fn: (args: Row) => Promise<unknown>) => {
    const target = model as Row; const before = target[method]; target[method] = fn;
    restores.push(() => { target[method] = before; });
  };
  stub(prisma.appSetting, "findUnique", async () => ({ untResetBotEnabled: state.enabled }));
  stub(prisma.groupPreset, "findMany", async () => []);
  stub(prisma.issue, "findUnique", async () => ({ groupName: "Service" }));
  stub(prisma.telegramMessage, "findMany", async () => [{ text: state.sourceText }]);
  stub(prisma.pendingUntReset, "create", async (args) => {
    const data = args.data as Row;
    if ([...state.rows.values()].some((row) => row.resultId === data.resultId)) {
      throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
    }
    const row: Row = { dmMessageId: null, status: "PENDING", createdAt: new Date(), ...data };
    state.rows.set(String(row.id), row); return { ...row };
  });
  stub(prisma.pendingUntReset, "findUnique", async (args) => {
    const row = state.rows.get(String((args.where as Row).id)); return row ? { ...row } : null;
  });
  stub(prisma.pendingUntReset, "updateMany", async (args) => {
    const where = args.where as Row; const row = state.rows.get(String(where.id));
    if (!row || Object.entries(where).some(([key, value]) => row[key] !== value)) return { count: 0 };
    Object.assign(row, args.data); return { count: 1 };
  });
  stub(prisma.pendingUntReset, "update", async (args) => {
    const row = state.rows.get(String((args.where as Row).id))!;
    Object.assign(row, args.data); return { ...row };
  });
  stub(prisma.pendingUntReset, "delete", async (args) => {
    state.rows.delete(String((args.where as Row).id)); return {};
  });
  stub(prisma.untResultReset, "create", async (args) => { state.audit.push(args.data as Row); return args.data; });

  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "api.telegram.org") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      state.telegram.push({ method: url.pathname.split("/").at(-1), ...body });
      return Response.json({ ok: true, result: { message_id: ++state.counter } });
    }
    if (url.hostname !== "platform.example.test") throw Error(`Unexpected network request: ${url}`);
    if (url.pathname === "/v1/auth/signin") return Response.json({ token: "fixture-token" });
    if (url.pathname === "/v1/unts") return Response.json(tests);
    // Ученик на платформе — нужен запасному поиску по фамилии.
    if (url.pathname === "/v1/users") {
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      return Response.json({ content: state.accounts.filter((a) => a.username === search) });
    }
    const account = state.accounts.find((a) => url.pathname === `/v2/users/${a.id}`);
    if (account) return Response.json({ ...account, subjectCombination: null });
    const report = url.pathname.match(/^\/v1\/unts\/([^/]+)\/report$/);
    if (report) {
      const untId = report[1]; const student = (url.searchParams.get("student") ?? "").toLowerCase();
      assert.equal(url.searchParams.get("product"), tests.find((t) => t.id === untId)?.product);
      const infos = [...state.results.entries()]
        .filter(([, r]) => r.untId === untId && (r.email === student || r.fullName.toLowerCase().includes(student.split(" ")[0])))
        .map(([resultId, r]) => ({ resultId, fullName: r.fullName, combination: "Мат-Физ", score: r.score }));
      return Response.json({ studentUntInfos: infos });
    }
    const personal = url.pathname.match(/^\/v1\/unts\/results\/([^/]+)\/personal-report$/);
    if (personal) {
      const r = state.results.get(personal[1]);
      if (!r) return new Response("", { status: 404 });
      return Response.json({ id: personal[1], status: r.status, finishTime: r.finishTime,
        student: { username: r.email, fullName: r.fullName } });
    }
    const result = url.pathname.match(/^\/v1\/unts\/results\/([^/]+)$/);
    if (result && method === "DELETE") {
      state.deletes.push(result[1]); state.results.delete(result[1]);
      return new Response(null, { status: 204 });
    }
    const unt = url.pathname.match(/^\/v1\/unts\/([^/]+)$/);
    if (unt) return Response.json({ slots: [{ streamTypes: [tests.find((t) => t.id === unt[1])?.product] }] });
    throw Error(`Unexpected endpoint: ${method} ${url.pathname}`);
  };

  const cleanup = () => {
    restores.reverse().forEach((restore) => restore()); globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  };
  const ask = (text: string, issueId = "fixture-issue") => {
    state.sourceText = text;
    return requestUntResetApproval({ issueId, chatId: "-100123", messageId: 50, incomingText: text });
  };
  const cards = () => state.telegram.filter((m) => m.method === "sendMessage");
  const press = (row: Row, action: "del" | "skip", fromId = 123) => handleUntResetCallback({
    id: "fixture-callback", data: `unt_reset:${row.id}:${action}`, from: { id: fromId },
    message: { message_id: Number(row.dmMessageId), chat: { id: fromId, type: "private" } },
  });
  return { state, cleanup, ask, cards, press };
}

test("сообщение куратора → одна карточка в личку → удаление только по кнопке агента, один раз", async () => {
  const h = harness();
  try {
    h.state.results.set("res-1", { untId: "unt-smart", fullName: "Асанов Али", email: "ali@example.test",
      score: 87, status: "FINISHED", finishTime: "2026-11-17T14:20:00" });
    // Результат в давно закрытом тесте — не предлагаем.
    h.state.results.set("res-old", { untId: "unt-old", fullName: "Асанов Али", email: "ali@example.test",
      score: 50, status: "FINISHED", finishTime: "2026-10-18T14:20:00" });

    const text = "БТ қайта ашып беріңізші ali@example.test";
    assert.equal(await h.ask(text), true);
    assert.equal(await h.ask(text), true, "повторное сообщение про тот же результат карточку не дублирует");
    assert.equal(h.cards().length, 1);
    const card = h.cards()[0];
    assert.equal(card.chat_id, 123, "карточка уходит агенту в личку");
    for (const part of ["Асанов Али", "ali@example.test", "SMART ҚАРАША БТ", "87", "17.11 14:20"]) {
      assert.ok(String(card.text).includes(part), `в карточке есть «${part}»`);
    }
    assert.ok(!String(card.text).includes("сверьте"), "найден по почте — пометки о сверке нет");
    const buttons = (card.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard.flat();
    assert.equal(buttons.length, 2);
    for (const b of buttons) assert.ok(Buffer.byteLength(b.callback_data) <= 64, "callback_data ≤ 64 байт");
    assert.equal(h.state.deletes.length, 0, "без нажатия ничего не удаляется");

    const row = [...h.state.rows.values()][0];
    await h.press(row, "del", 999);
    assert.equal(h.state.deletes.length, 0, "чужой человек удалить не может");
    h.state.enabled = false;
    await h.press(row, "del");
    assert.equal(h.state.deletes.length, 0, "выключенная функция не удаляет");
    h.state.enabled = true;

    await h.press(row, "del");
    await h.press(row, "del");
    assert.deepEqual(h.state.deletes, ["res-1"], "повторное нажатие второй раз не удаляет");
    assert.equal(row.status, "DONE");
    assert.equal(h.state.audit.length, 1);
    assert.equal(h.state.audit[0].actor, "Ерош");
    assert.equal(h.state.audit[0].untName, "SMART ҚАРАША БТ");
    assert.ok(h.state.telegram.some((m) => m.method === "editMessageText" && String(m.text).includes("удалён")));
    assert.ok(h.state.telegram.every((m) => m.chat_id === undefined || m.chat_id === 123),
      "в рабочую группу бот не пишет ничего");
  } finally { h.cleanup(); }
});

test("нет карточки: ученик ещё решает, функция выключена, нет ключевого слова", async () => {
  const h = harness();
  try {
    h.state.results.set("res-2", { untId: "unt-junior", fullName: "Бота Серик", email: "bota@example.test",
      score: 0, status: "STARTED", finishTime: null });
    assert.equal(await h.ask("БТ ашылмай тұр bota@example.test"), false);

    h.state.results.get("res-2")!.status = "FINISHED";
    h.state.results.get("res-2")!.finishTime = "2026-11-17T12:00:00";
    assert.equal(await h.ask("Курс ашылмай тұр bota@example.test"), false);
    h.state.enabled = false;
    assert.equal(await h.ask("БТ ашылмай тұр bota@example.test"), false);
    assert.equal(h.cards().length, 0);

    h.state.enabled = true;
    assert.equal(await h.ask("БТ ашылмай тұр bota@example.test"), true);
    assert.ok(String(h.cards()[0].text).includes("JUNIOR БТ ҚАРАША"), "тест найден по тарифу ученика");
  } finally { h.cleanup(); }
});

test("только имя → карточка с пометкой о сверке; «Не трогать» закрывает карточку без удаления", async () => {
  const h = harness();
  try {
    h.state.results.set("res-3", { untId: "unt-smart", fullName: "Асанов Али", email: "ali@example.test",
      score: 60, status: "FINISHED", finishTime: "2026-11-17T10:00:00" });
    // Однофамилец: фамилия совпала, имя — нет. Не предлагаем.
    h.state.results.set("res-4", { untId: "unt-smart", fullName: "Асанов Берик", email: "berik@example.test",
      score: 70, status: "FINISHED", finishTime: "2026-11-17T10:00:00" });
    assert.equal(await h.ask("ДТ нәтижесін өшіріп беріңізші\nАсанов Али"), true);
    assert.equal(h.cards().length, 1);
    assert.ok(String(h.cards()[0].text).includes("сверьте"));
    assert.ok(String(h.cards()[0].text).includes("Асанов Али"));

    const row = [...h.state.rows.values()][0];
    await h.press(row, "skip");
    await h.press(row, "del");
    assert.equal(row.status, "DECLINED");
    assert.equal(h.state.deletes.length, 0);
  } finally { h.cleanup(); }
});

test("результат перестал быть завершённым к моменту нажатия → не удаляем", async () => {
  const h = harness();
  try {
    h.state.results.set("res-5", { untId: "unt-smart", fullName: "Асанов Али", email: "ali@example.test",
      score: 60, status: "FINISHED", finishTime: "2026-11-17T10:00:00" });
    assert.equal(await h.ask("БТ өшіріп беріңізші ali@example.test"), true);
    h.state.results.get("res-5")!.status = "STARTED";
    const row = [...h.state.rows.values()][0];
    await h.press(row, "del");
    assert.equal(h.state.deletes.length, 0);
    assert.equal(row.status, "FAILED");
  } finally { h.cleanup(); }
});

test("по почте пусто, платформа ищет по фамилии → карточка только на самого ученика, без пачки похожих", async () => {
  const h = harness();
  try {
    // Ученик есть на платформе, но результат лежит на другом его аккаунте:
    // по почте отчёт пуст, запасной поиск идёт по фамилии «Сарсен».
    h.state.accounts.push({ id: "00000000-0000-4000-8000-000000000009", roles: ["STUDENT"],
      username: "nazifa@example.test", firstname: "Назифа", lastname: "Сарсен" });
    const add = (id: string, fullName: string) => h.state.results.set(id, { untId: "unt-smart", fullName,
      email: `${id}@example.test`, score: 50, status: "FINISHED", finishTime: "2026-11-17T10:00:00" });
    add("r-1", "Сарсен Назифа"); add("r-2", "Сарсенбай Аяулым");
    add("r-3", "Сарсенбева Нурзинет"); add("r-4", "Сарсенбек Казына");

    const text = "БТ қайта ашып беріңізші\nnazifa@example.test";
    assert.equal(await h.ask(text), true);
    assert.equal(h.cards().length, 1, "одна карточка, а не четыре");
    const card = String(h.cards()[0].text);
    assert.ok(card.includes("Сарсен Назифа") && card.includes("сверьте"));
    assert.ok(card.includes("БТ қайта ашып беріңізші / nazifa@example.test"), "текст обращения виден в карточке");

    // Два полных тёзки — бот не выбирает между ними и молчит.
    h.state.rows.clear(); h.state.telegram.length = 0;
    add("r-5", "Сарсен Назифа");
    assert.equal(await h.ask(text), false);
    assert.equal(h.cards().length, 0);
  } finally { h.cleanup(); }
});
