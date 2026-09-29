import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { findStudentByContact, isStudentRegistered, platformEnabled } from "@/lib/platform";

// Занят ли новый номер (или почта) на платформе — подсказка прямо в форме
// мини-аппа, пока куратор его вводит.
//
// Зачем: смена номера упирается в занятый логин чаще всего, и раньше это
// выяснялось только когда дежурный дошёл до тикета и попробовал. Теперь
// куратор видит это сразу и тем же обращением говорит, что делать с тем
// пользователем.
//
// Отдельного API для этого не понадобилось: /v1/users?search= находит и по
// номеру — проверено на живой платформе во всех форматах (+7…, 7…, последние
// девять цифр).
//
// Наружу отдаём почту и телефон найденного. Сначала показывали только имя, но
// на платформе они сплошь мусорные («kkkkkkk ppppoo», «цукуцк уцк») — по
// такому имени куратор не понимает, чей это аккаунт, а по почте понимает
// сразу.
//
// available: false — проверить нечем (инструмент выключен, платформа не
// ответила). Форма тогда спрашивает то же самое вручную, а не врёт «свободен».

// Короче этого искать бессмысленно: платформа вернёт пол-базы по совпадению
// куска имени.
const MIN_DIGITS = 9;
const MIN_QUERY = 5;

// Проверок в час на куратора. Щедро для набора номера (форма спрашивает не
// чаще раза в 600 мс и только с девяти цифр), но закрывает главное: маршрут
// отвечает, есть ли на платформе такой ученик, и без счётчика по нему можно
// было бы перебирать номера и почты чужих людей.
const MAX_CHECKS_PER_HOUR = 60;

export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) return NextResponse.json({ available: false });

  const body = (await request.json().catch(() => null)) as {
    initData?: unknown;
    contact?: unknown;
    // Поле контакта уже существующего ученика (checksStudent): тогда нужен
    // ещё и ответ, закончил ли он регистрацию.
    student?: unknown;
  } | null;

  const check = verifyInitData(typeof body?.initData === "string" ? body.initData : "");
  if (!check.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!platformEnabled()) return NextResponse.json({ available: false });

  // Сначала запись, потом подсчёт — параллельные проверки видят друг друга.
  const now = Date.now();
  await prisma.miniAppAttempt.create({
    data: { telegramUserId: check.user.id, kind: "check" },
  });
  const checks = await prisma.miniAppAttempt.count({
    where: {
      telegramUserId: check.user.id,
      kind: "check",
      createdAt: { gte: new Date(now - 60 * 60 * 1000) },
    },
  });
  if (checks > MAX_CHECKS_PER_HOUR) {
    console.warn(`[miniapp] лимит проверок контакта: user=${check.user.id}, ${checks} за час`);
    // Для формы это то же самое, что «проверить не смогли»: она покажет
    // ручной вопрос вместо молчания.
    return NextResponse.json({ available: false });
  }

  const contact = typeof body?.contact === "string" ? body.contact.trim().slice(0, 200) : "";
  const digits = contact.replace(/\D/g, "");
  const isEmail = contact.includes("@");
  if (isEmail ? contact.length < MIN_QUERY : digits.length < MIN_DIGITS) {
    return NextResponse.json({ available: true, taken: false });
  }

  try {
    const match = await findStudentByContact(contact);
    // Регистрацию спрашиваем только у поля ученика и только у найденного:
    // эндпоинт понимает лишь логин и на чужое отвечает тем же false.
    const registered =
      match && body?.student === true && match.email
        ? await isStudentRegistered(match.email).catch(() => null)
        : null;

    const name = match
      ? [match.firstname, match.lastname].filter(Boolean).join(" ").trim()
      : "";
    return NextResponse.json({
      available: true,
      taken: Boolean(match),
      name: name || null,
      email: match?.email || null,
      phone: match?.phoneNumber || null,
      registered,
    });
  } catch (err) {
    // Платформа недоступна — честно говорим «проверить не смогли», иначе
    // форма показала бы «свободен» и куратор на это положился бы.
    console.warn(`[miniapp] проверка контакта не удалась: ${String(err).slice(0, 150)}`);
    return NextResponse.json({ available: false });
  }
}
