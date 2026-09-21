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

// В поиск уходит нормализованный номер, а не то, что видно в поле: форма
// показывает «+7 (777) 777 77 77», а на платформе тот же номер может лежать
// как «+77777777777» или даже «+7 ( (7) 77) 777 77 77». Пробуем варианты по
// очереди, пока не найдём совпадение.
// Вариантов ровно два: на свободном номере отрабатывают оба, и каждый лишний
// запрос — лишняя секунда ожидания под полем.
function phoneQueries(contact: string): string[] {
  let digits = contact.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("8")) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  const local = digits.length === 11 ? digits.slice(1) : digits;
  return [...new Set([`+${digits}`, local])].filter((q) => q.length >= MIN_DIGITS);
}

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
    // Точное совпадение, а не «похоже»: тот же search цепляет и куски имени,
    // и по ним объявлять контакт занятым нельзя. У телефона сравниваем по
    // цифрам — на платформе они записаны как попало.
    const tail = digits.slice(-MIN_DIGITS);
    const matches = (user: { email: string | null; phoneNumber: string | null }) =>
      isEmail
        ? (user.email ?? "").toLowerCase() === contact.toLowerCase()
        : (user.phoneNumber ?? "").replace(/\D/g, "").endsWith(tail);

    let match: Awaited<ReturnType<typeof searchStudents>>[number] | undefined;
    for (const query of isEmail ? [contact] : phoneQueries(contact)) {
      const found = await searchStudents(query, 5);
      match = found.find(matches);
      if (match) break;
    }

    const name = match
      ? [match.firstname, match.lastname].filter(Boolean).join(" ").trim()
      : "";
    return NextResponse.json({
      available: true,
      taken: Boolean(match),
      name: name || null,
      email: match?.email || null,
      phone: match?.phoneNumber || null,
    });
  } catch (err) {
    // Платформа недоступна — честно говорим «проверить не смогли», иначе
    // форма показала бы «свободен» и куратор на это положился бы.
    console.warn(`[miniapp] проверка контакта не удалась: ${String(err).slice(0, 150)}`);
    return NextResponse.json({ available: false });
  }
}
