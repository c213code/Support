import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFICIAL_GROUPS } from "@/lib/groups";
import { buildDescription } from "@/lib/ticketDescription";
import { cleanTicketDescription, isNoiseOnly } from "@/lib/textClean";
import { insertSentIssue } from "@/lib/webhook/acknowledge";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { uploadPhoto } from "@/lib/telegram";

// Потолок фото — не 10 МБ Telegram, а меньше лимита Vercel на тело запроса
// (4.5 МБ): больший запрос платформа отбросит ещё до этого маршрута своим
// 413. Сжатое на телефоне фото весит сотни КБ; лимит касается только
// оригинала, который браузер не смог сжать. Тот же лимит — в форме.
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
// Проверка по Content-Length отсекает честно объявленный большой запрос до
// чтения формы. Без заголовка (chunked) тело всё равно прочитается — от этого
// на Vercel спасает лимит платформы, а не этот код.
const MAX_REQUEST_BYTES = 4.5 * 1024 * 1024;
// Подать обращение может любой, кто открыл бота. Считаются ПОПЫТКИ, а не
// удачные подачи: иначе отклонённые как мусор тексты (каждый — запрос к ИИ)
// шли бы без предела и могли выжечь дневную квоту Groq всем ИИ-функциям.
const MAX_ATTEMPTS_PER_HOUR = 20;
// Сколько дней держать журнал попыток — лимиту нужен только последний час.
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

function field(form: FormData, name: string, max: number): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function reply(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "P2002";
}

// Приём обращения из формы мини-аппа. Маршрут открыт без куки агента (см.
// proxy.ts) — автор проверяется по подписи Telegram, а не по сессии.
//
// Обращение попадает только на сайт: в рабочую группу ничего не пишется,
// поэтому реакций и ответов бота при смене статуса у таких тикетов нет.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) return reply(503, "Форма пока выключена");

  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) {
    return reply(413, "Фото слишком большое — сделайте скриншот экрана и прикрепите его");
  }

  const form = await request.formData().catch(() => null);
  if (!form) return reply(400, "Не удалось прочитать форму");

  const check = verifyInitData(field(form, "initData", 8192));
  if (!check.ok) {
    // Initdata в лог не пишем — только причину. bad_hash — чаще настройка
    // (у бота с кнопкой другой токен, чем у этого сервера), чем подделка, и
    // куратор его не исправит, поэтому это ошибка, а не предупреждение.
    if (check.reason === "bad_hash" || check.reason === "no_token") {
      console.error(`[miniapp] initData отклонена: ${check.reason}`);
    } else {
      console.warn(`[miniapp] initData отклонена: ${check.reason}`);
    }
    return reply(
      401,
      check.reason === "expired"
        ? "Форма открыта больше суток назад — закройте её и откройте заново из бота"
        : "Откройте форму заново из бота в Telegram"
    );
  }
  const user = check.user;

  // Повтор той же отправки (ответ потерялся в дороге, куратор нажал ещё раз)
  // — отдаём уже заведённый тикет, а не заводим второй.
  const clientSubmissionId = field(form, "submissionId", 64) || null;
  if (clientSubmissionId) {
    const existing = await findExisting(clientSubmissionId, user.id);
    if (existing) return NextResponse.json({ ok: true, issueId: existing, repeated: true });
  }

  // Место в лимите занимаем ДО медленной работы (ИИ, загрузка фото): иначе
  // пачка параллельных запросов проходила бы проверку вся, пока первый ещё
  // не записан. Сначала запись, потом подсчёт — параллельные попытки видят
  // друг друга, и лишние отсекаются.
  const now = Date.now();
  await prisma.miniAppAttempt.create({ data: { telegramUserId: user.id } });
  const attempts = await prisma.miniAppAttempt.count({
    where: { telegramUserId: user.id, createdAt: { gte: new Date(now - 60 * 60 * 1000) } },
  });
  if (attempts > MAX_ATTEMPTS_PER_HOUR) {
    console.warn(`[miniapp] лимит попыток: user=${user.id}, ${attempts} за час`);
    return reply(429, "Слишком много попыток за час — попробуйте позже");
  }
  await prisma.miniAppAttempt.deleteMany({
    where: { createdAt: { lt: new Date(now - ATTEMPT_RETENTION_MS) } },
  });

  const group = OFFICIAL_GROUPS.find((g) => g.name === field(form, "groupName", 100));
  const description = field(form, "description", 4000);
  const studentContact = field(form, "studentContact", 200);
  const lessonLink = field(form, "lessonLink", 500);
  const photo = form.get("photo");

  if (!group) return reply(400, "Выберите группу");
  if (!description) return reply(400, "Опишите проблему");
  if (!studentContact) return reply(400, "Укажите почту или телефон ученика");
  if (!lessonLink) return reply(400, "Укажите ссылку на урок или задание");
  if (!(photo instanceof File) || photo.size === 0) return reply(400, "Прикрепите фото");
  if (!photo.type.startsWith("image/")) return reply(400, "Прикрепить можно только фото");
  if (photo.size > MAX_PHOTO_BYTES) {
    return reply(413, "Фото слишком большое — сделайте скриншот экрана и прикрепите его");
  }

  // Порядок: описание → фото → тикет. Описание первым: обращение-мусор не
  // должно оставлять фото в служебном канале. own и contextual совпадают —
  // у формы нет цитаты, на которую отвечали.
  let cleaned = await buildDescription(description, description);
  if (cleaned === null) {
    if (isNoiseOnly(description)) {
      console.warn(`[miniapp] отклонено как мусор: user=${user.id}, ${description.length} симв.`);
      return reply(400, "Опишите проблему подробнее — по такому тексту тикет не заводится");
    }
    // ИИ ответил SKIP: его промпт настроен на переписку в группе, где SKIP —
    // "это разговор коллег, а не обращение". Обращение из формы — явный
    // запрос по определению, поэтому не отказываем, а берём regex-чистку.
    console.warn(`[miniapp] ИИ ответил SKIP на обращение из формы — беру regex-чистку: user=${user.id}`);
    cleaned = cleanTicketDescription(description);
  }

  // Фото до тикета: если Telegram его не принял, тикета без обязательного
  // вложения быть не должно.
  const storageChatId = process.env.TELEGRAM_STORAGE_CHAT_ID!;
  const upload = await uploadPhoto(
    storageChatId,
    photo,
    `${user.name} · ${group.name}\n${description.slice(0, 200)}`
  );
  if (!upload.ok) {
    if (upload.kind === "config") {
      // Форма мертва для всех, пока это не исправят, — ошибка, а не
      // предупреждение, и с тем, что именно проверить.
      console.error(
        `[miniapp] TELEGRAM_STORAGE_CHAT_ID=${storageChatId} не годится (${upload.description}) — проверьте, что бот админ канала с правом публиковать`
      );
      return reply(503, "Форма настроена неверно — сообщите дежурному, обращение пока отправьте в группу");
    }
    return reply(
      502,
      upload.kind === "photo"
        ? "Telegram не принял это фото — сделайте скриншот экрана и прикрепите его"
        : "Не получилось отправить фото — проверьте связь и отправьте ещё раз"
    );
  }

  const preset = await prisma.groupPreset.findUnique({
    where: { name: group.name },
    select: { emoji: true },
  });

  try {
    const issue = await insertSentIssue(group.name, preset?.emoji ?? group.emoji, cleaned, null, {
      clientSubmissionId,
      telegramUserId: user.id,
      authorName: user.name,
      rawText: description,
      studentContact,
      lessonLink,
      photoFileId: upload.fileId,
    });
    return NextResponse.json({ ok: true, issueId: issue.id });
  } catch (err) {
    // Два одинаковых запроса пришли одновременно: второй упёрся в
    // уникальный clientSubmissionId, тикет уже завёл первый.
    if (clientSubmissionId && isUniqueViolation(err)) {
      const existing = await findExisting(clientSubmissionId, user.id);
      if (existing) return NextResponse.json({ ok: true, issueId: existing, repeated: true });
    }
    // Тикет и заявка пишутся одним запросом — полутикета на доске нет. Фото
    // в служебном канале останется, это не страшно.
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    console.error(`[miniapp] обращение не записалось (${code}): ${String(err).slice(0, 300)}`);
    return reply(500, "Не удалось сохранить обращение — попробуйте ещё раз");
  }
}

async function findExisting(clientSubmissionId: string, telegramUserId: bigint) {
  const existing = await prisma.issueSubmission.findUnique({
    where: { clientSubmissionId },
    select: { issueId: true, telegramUserId: true },
  });
  // Чужой id повтора не даёт ничего: тикет другого куратора не отдаём.
  return existing && existing.telegramUserId === telegramUserId ? existing.issueId : null;
}
