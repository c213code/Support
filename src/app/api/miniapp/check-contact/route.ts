import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { platformEnabled, searchStudents } from "@/lib/platform";

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
// Наружу отдаём только имя найденного: куратору этого хватает, чтобы понять
// «это мой ученик» или «чужой», а почту и телефон чужого человека показывать
// в форме незачем.
//
// available: false — проверить нечем (инструмент выключен, платформа не
// ответила). Форма тогда спрашивает то же самое вручную, а не врёт «свободен».

// Короче этого искать бессмысленно: платформа вернёт пол-базы по совпадению
// куска имени.
const MIN_DIGITS = 9;
const MIN_QUERY = 5;

export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) return NextResponse.json({ available: false });

  const body = (await request.json().catch(() => null)) as {
    initData?: unknown;
    contact?: unknown;
  } | null;

  const check = verifyInitData(typeof body?.initData === "string" ? body.initData : "");
  if (!check.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!platformEnabled()) return NextResponse.json({ available: false });

  const contact = typeof body?.contact === "string" ? body.contact.trim().slice(0, 200) : "";
  const digits = contact.replace(/\D/g, "");
  const isEmail = contact.includes("@");
  if (isEmail ? contact.length < MIN_QUERY : digits.length < MIN_DIGITS) {
    return NextResponse.json({ available: true, taken: false });
  }

  try {
    const found = await searchStudents(contact, 5);
    // Точное совпадение, а не «похоже»: тот же search цепляет и куски имени,
    // и по ним объявлять номер занятым нельзя.
    const tail = digits.slice(-MIN_DIGITS);
    const match = found.find((user) =>
      isEmail
        ? (user.email ?? "").toLowerCase() === contact.toLowerCase()
        : (user.phoneNumber ?? "").replace(/\D/g, "").endsWith(tail)
    );

    const name = match
      ? [match.firstname, match.lastname].filter(Boolean).join(" ").trim()
      : "";
    return NextResponse.json({
      available: true,
      taken: Boolean(match),
      name: name || null,
    });
  } catch (err) {
    // Платформа недоступна — честно говорим «проверить не смогли», иначе
    // форма показала бы «свободен» и куратор на это положился бы.
    console.warn(`[miniapp] проверка контакта не удалась: ${String(err).slice(0, 150)}`);
    return NextResponse.json({ available: false });
  }
}
