import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFICIAL_GROUPS } from "@/lib/groups";
import { buildDescription } from "@/lib/ticketDescription";
import { cleanTicketDescription, isNoiseOnly } from "@/lib/textClean";
import { insertSentIssue } from "@/lib/webhook/acknowledge";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { uploadPhoto } from "@/lib/telegram";

// Сколько фото можно приложить к одному обращению. Больше пяти — это уже не
// «покажи, что на экране», а выгрузка галереи, и в лимит запроса она не
// влезет.
const MAX_PHOTOS = 5;
// Потолок на ВСЕ фото вместе — не 10 МБ Telegram, а меньше лимита Vercel на
// тело запроса (4.5 МБ): больший запрос платформа отбросит ещё до этого
// маршрута своим 413. Сжатые на телефоне фото весят сотни КБ, так что пять
// штук укладываются с запасом; лимит бьёт только по несжатым оригиналам.
const MAX_PHOTOS_BYTES = 4 * 1024 * 1024;
// Проверка по Content-Length отсекает честно объявленный большой запрос до
// чтения формы. Без заголовка (chunked) тело всё равно прочитается — от этого
// на Vercel спасает лимит платформы, а не этот код.
const MAX_REQUEST_BYTES = 4.5 * 1024 * 1024;
// Подать обращение может любой, кто открыл бота. Считаются ПОПЫТКИ, а не
// удачные подачи: иначе отклонённые как мусор тексты (каждый — запрос к ИИ)
// шли бы без предела и могли выжечь дневную квоту Groq всем ИИ-функциям.
const MAX_ATTEMPTS_PER_HOUR = 20;
// Сколько держать журнал попыток — лимиту нужен только последний час.
const ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;

// Тексты для куратора — на казахском, как и вся форма: их показывает она
// (SubmissionForm.tsx). Логи — по-русски, их читает команда.
const T = {
  disabled: "Форма әзірге өшірулі",
  photoTooBig: "Фото тым үлкен — экранның скриншотын жасап, соны тіркеңіз",
  tooManyPhotos: `Фото тым көп — ${MAX_PHOTOS} суретке дейін тіркеуге болады`,
  unreadable: "Форманы оқу мүмкін болмады",
  expired: "Форма бір тәуліктен бұрын ашылған — оны жауып, боттан қайта ашыңыз",
  reopen: "Форманы боттан қайта ашыңыз",
  tooManyAttempts: "Бір сағатта тым көп әрекет — кейінірек қайталаңыз",
  noGroup: "Топты таңдаңыз",
  noDescription: "Мәселені сипаттаңыз",
  noContact: "Оқушының поштасын немесе телефонын көрсетіңіз",
  // Урок принимается и ссылкой, и «ай-аптой» (3-ай 2-апта) — по ней дежурный
  // найдёт занятие сам, а ссылка есть не всегда.
  noLink: "Сабақтың сілтемесін немесе ай-аптасын көрсетіңіз",
  noPhoto: "Фото тіркеңіз",
  notImage: "Тек фото тіркеуге болады",
  noise: "Мәселені толығырақ жазыңыз — мұндай мәтін бойынша өтініш ашылмайды",
  misconfigured: "Форма дұрыс бапталмаған — кезекшіге хабарлаңыз, өтінішті әзірге топқа жазыңыз",
  photoRejected: "Telegram бұл фотоны қабылдамады — экранның скриншотын жасап, соны тіркеңіз",
  photoNetwork: "Фотоны жіберу мүмкін болмады — байланысты тексеріп, қайта жіберіңіз",
  saveFailed: "Өтінішті сақтау мүмкін болмады — қайталап көріңіз",
};

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
  if (!submissionFormEnabled()) return reply(503, T.disabled);

  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) {
    return reply(413, T.photoTooBig);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return reply(400, T.unreadable);

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
    return reply(401, check.reason === "expired" ? T.expired : T.reopen);
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
    return reply(429, T.tooManyAttempts);
  }
  await prisma.miniAppAttempt.deleteMany({
    where: { createdAt: { lt: new Date(now - ATTEMPT_RETENTION_MS) } },
  });

  const group = OFFICIAL_GROUPS.find((g) => g.name === field(form, "groupName", 100));
  const description = field(form, "description", 4000);
  const studentContact = field(form, "studentContact", 200);
  const lessonLink = field(form, "lessonLink", 500);
  const photos = form.getAll("photo").filter((p): p is File => p instanceof File && p.size > 0);

  if (!group) return reply(400, T.noGroup);
  if (!description) return reply(400, T.noDescription);
  if (!studentContact) return reply(400, T.noContact);
  if (!lessonLink) return reply(400, T.noLink);
  if (photos.length === 0) return reply(400, T.noPhoto);
  if (photos.length > MAX_PHOTOS) return reply(400, T.tooManyPhotos);
  if (photos.some((photo) => !photo.type.startsWith("image/"))) return reply(400, T.notImage);
  if (photos.reduce((sum, photo) => sum + photo.size, 0) > MAX_PHOTOS_BYTES) {
    return reply(413, T.photoTooBig);
  }

  // Порядок: описание → фото → тикет. Описание первым: обращение-мусор не
  // должно оставлять фото в служебном канале. own и contextual совпадают —
  // у формы нет цитаты, на которую отвечали.
  let cleaned = await buildDescription(description, description);
  if (cleaned === null) {
    if (isNoiseOnly(description)) {
      console.warn(`[miniapp] отклонено как мусор: user=${user.id}, ${description.length} симв.`);
      return reply(400, T.noise);
    }
    // ИИ ответил SKIP: его промпт настроен на переписку в группе, где SKIP —
    // "это разговор коллег, а не обращение". Обращение из формы — явный
    // запрос по определению, поэтому не отказываем, а берём regex-чистку.
    console.warn(`[miniapp] ИИ ответил SKIP на обращение из формы — беру regex-чистку: user=${user.id}`);
    cleaned = cleanTicketDescription(description);
  }

  // Фото до тикета: если Telegram хоть одно не принял, тикета без полного
  // набора вложений быть не должно — куратор повторит отправку целиком.
  const storageChatId = process.env.TELEGRAM_STORAGE_CHAT_ID!;
  const photoFileIds: string[] = [];
  for (const [index, photo] of photos.entries()) {
    const caption =
      index === 0
        ? `${user.name} · ${group.name}\n${description.slice(0, 200)}`
        : `${user.name} · ${group.name} · фото ${index + 1}`;
    const upload = await uploadPhoto(storageChatId, photo, caption);
    if (!upload.ok) {
      if (upload.kind === "config") {
        // Форма мертва для всех, пока это не исправят, — ошибка, а не
        // предупреждение, и с тем, что именно проверить.
        console.error(
          `[miniapp] TELEGRAM_STORAGE_CHAT_ID=${storageChatId} не годится (${upload.description}) — проверьте, что бот админ канала с правом публиковать`
        );
        return reply(503, T.misconfigured);
      }
      return reply(502, upload.kind === "photo" ? T.photoRejected : T.photoNetwork);
    }
    photoFileIds.push(upload.fileId);
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
      photoFileId: photoFileIds[0],
      photoFileIds,
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
    // в служебном канале останутся, это не страшно.
    const code = typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
    console.error(`[miniapp] обращение не записалось (${code}): ${String(err).slice(0, 300)}`);
    return reply(500, T.saveFailed);
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
