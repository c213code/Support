import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { devChatId } from "@/lib/devTeams";
import { redactSecrets } from "@/lib/textClean";

// Разовая уборка сообщений чата разработчиков, сохранённых до того, как у
// него появился свой вход в вебхуке: (1) в архив — во «Входящих» им не место,
// (2) ключи доступа из curl («Authorization: Bearer eyJ…») — из текста.
// Новые сообщения сразу ложатся так (см. вебхук). Правка данных — поэтому
// кнопкой, которую нажимает человек, а не миграцией (см. CLAUDE.md).

// Грубый отбор строк, где может быть ключ, — чтобы не гонять все тысячи
// сообщений через регулярки. Точно решает redactSecrets.
const SECRET_HINTS = ["eyJ", "bearer", "authorization", "cookie:", "token=", "password=", "api_key", "apikey"];

function candidatesWhere(chatId: string) {
  return {
    chatId,
    OR: [
      { archived: false },
      ...SECRET_HINTS.map((hint) => ({ text: { contains: hint, mode: "insensitive" as const } })),
    ],
  };
}

// Точный счёт, а не по подсказкам: уже вычищенное «Authorization: <скрыто>»
// подсказке тоже отвечает, и баннер не пропадал бы никогда.
async function pendingRows(chatId: string) {
  const rows = await prisma.telegramMessage.findMany({
    where: candidatesWhere(chatId),
    select: { id: true, text: true, archived: true },
  });
  return rows.filter((r) => !r.archived || (r.text != null && redactSecrets(r.text) !== r.text));
}

export async function GET() {
  const chatId = devChatId();
  if (!chatId) return NextResponse.json({ pending: 0 });
  return NextResponse.json({ pending: (await pendingRows(chatId)).length });
}

export async function POST() {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const chatId = devChatId();
  if (!chatId) {
    return NextResponse.json({ error: "DEV_CHAT_ID не задан" }, { status: 400 });
  }

  const archived = await prisma.telegramMessage.updateMany({
    where: { chatId, archived: false },
    data: { archived: true, viewed: true },
  });

  const rows = await prisma.telegramMessage.findMany({
    where: candidatesWhere(chatId),
    select: { id: true, text: true },
  });
  const changed = rows
    .map((r) => ({ id: r.id, text: r.text, redacted: r.text ? redactSecrets(r.text) : r.text }))
    .filter((r) => r.redacted !== r.text);
  for (const r of changed) {
    await prisma.telegramMessage.update({ where: { id: r.id }, data: { text: r.redacted } });
  }

  return NextResponse.json({ ok: true, archived: archived.count, redacted: changed.length });
}
