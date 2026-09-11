import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFICIAL_GROUPS } from "@/lib/groups";
import { buildDescription } from "@/lib/ticketDescription";
import { insertSentIssue } from "@/lib/webhook/acknowledge";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { uploadPhoto } from "@/lib/telegram";

// Сжатое на телефоне фото весит сотни килобайт; 10 МБ — лимит самого
// Telegram на sendPhoto, дальше он всё равно откажет.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Весь запрос: фото плюс текстовые поля с запасом. Маршрут открыт без входа,
// а formData() читает тело целиком в память — поэтому огромный запрос
// отсекаем по заголовку, ещё до чтения и до проверки подписи.
const MAX_REQUEST_BYTES = MAX_PHOTO_BYTES + 1024 * 1024;
// Подать обращение может любой, кто открыл бота, — нужен хоть какой-то
// предел от случайного (или намеренного) потока заявок.
const MAX_PER_HOUR = 10;

function field(form: FormData, name: string, max: number): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

// Приём обращения из формы мини-аппа. Маршрут открыт без куки агента (см.
// proxy.ts) — автор проверяется по подписи Telegram, а не по сессии.
//
// Обращение попадает только на сайт: в рабочую группу ничего не пишется,
// поэтому реакций и ответов бота при смене статуса у таких тикетов нет.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) {
    return NextResponse.json({ error: "Форма пока выключена" }, { status: 503 });
  }

  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "Фото больше 10 МБ" }, { status: 413 });
  }

  const form = await request.formData().catch(() => null);
  if (!form) return badRequest("Не удалось прочитать форму");

  const user = verifyInitData(field(form, "initData", 8192));
  if (!user) {
    return NextResponse.json(
      { error: "Откройте форму заново из бота в Telegram" },
      { status: 401 }
    );
  }

  const group = OFFICIAL_GROUPS.find((g) => g.name === field(form, "groupName", 100));
  const description = field(form, "description", 4000);
  const studentContact = field(form, "studentContact", 200);
  const lessonLink = field(form, "lessonLink", 500);
  const photo = form.get("photo");

  if (!group) return badRequest("Выберите группу");
  if (!description) return badRequest("Опишите проблему");
  if (!studentContact) return badRequest("Укажите почту или телефон ученика");
  if (!lessonLink) return badRequest("Укажите ссылку на урок или задание");
  if (!(photo instanceof File) || photo.size === 0) return badRequest("Прикрепите фото");
  if (!photo.type.startsWith("image/")) return badRequest("Прикрепить можно только фото");
  if (photo.size > MAX_PHOTO_BYTES) return badRequest("Фото больше 10 МБ");

  const recent = await prisma.issueSubmission.count({
    where: {
      telegramUserId: user.id,
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (recent >= MAX_PER_HOUR) {
    return NextResponse.json(
      { error: "Слишком много обращений за час — попробуйте позже" },
      { status: 429 }
    );
  }

  // Порядок: описание → фото → тикет. Описание первым: обращение, которое
  // чистка/ИИ отклонят как мусор, не должно оставлять фото в служебном канале.
  // own и contextual совпадают — у формы нет цитаты, на которую отвечали.
  const cleaned = await buildDescription(description, description);
  if (cleaned === null) {
    return badRequest("Опишите проблему подробнее — по такому тексту тикет не заводится");
  }

  // Фото до тикета: если Telegram его не принял, тикета без обязательного
  // вложения быть не должно, а повторная отправка формы не создаст дубль.
  const photoFileId = await uploadPhoto(
    process.env.TELEGRAM_STORAGE_CHAT_ID!,
    photo,
    `${user.name} · ${group.name}\n${description.slice(0, 200)}`
  );
  if (!photoFileId) {
    return NextResponse.json(
      { error: "Не удалось сохранить фото — попробуйте ещё раз или выберите другое" },
      { status: 502 }
    );
  }

  const preset = await prisma.groupPreset.findUnique({
    where: { name: group.name },
    select: { emoji: true },
  });
  const issue = await insertSentIssue(
    group.name,
    preset?.emoji ?? group.emoji,
    cleaned,
    null
  );

  try {
    await prisma.issueSubmission.create({
      data: {
        issueId: issue.id,
        telegramUserId: user.id,
        authorName: user.name,
        rawText: description,
        studentContact,
        lessonLink,
        photoFileId,
      },
    });
  } catch (err) {
    // Тикет без заявки — это обращение без контакта ученика и фото на
    // карточке. Лучше не завести ничего и честно попросить повторить, чем
    // тихо оставить на доске пустышку.
    console.error(`[miniapp] заявка не записалась, тикет ${issue.id} удалён: ${String(err)}`);
    await prisma.issue.delete({ where: { id: issue.id } }).catch(() => {});
    return NextResponse.json(
      { error: "Не удалось сохранить обращение — попробуйте ещё раз" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, issueId: issue.id });
}
