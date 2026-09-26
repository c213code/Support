import { after, NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { OFFICIAL_GROUPS } from "@/lib/groups";
import { cleanTicketDescription, isNoiseOnly } from "@/lib/textClean";
import {
  buildDetails,
  buildSummary,
  extractContact,
  extractLessonLink,
  findLabel,
  missingFields,
} from "@/lib/submissionLabels";
import { insertSentIssue } from "@/lib/webhook/acknowledge";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { uploadPhotos, type PhotoUpload } from "@/lib/telegram";
import { postSubmissionToGroup } from "@/lib/submissionGroupPost";
import { rewriteSubmissionDescription } from "@/lib/ticketDescription";

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
  noLabel: "Мәселе түрін таңдаңыз",
  incomplete: "Барлық қажетті өрістерді толтырыңыз",
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

// Ответы на поля ярлыка приходят одним JSON. Берём только строки и массивы
// строк: всё остальное (числа, вложенные объекты) — не то, что отправляет
// форма, и в базу такому попадать незачем. null — сломанный JSON.
function parseValues(raw: string): Record<string, string | string[]> | null {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const values: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") values[key] = value.slice(0, 4000);
    else if (Array.isArray(value)) {
      values[key] = value
        .filter((v): v is string => typeof v === "string")
        .slice(0, 20)
        .map((v) => v.slice(0, 4000));
    }
  }
  return values;
}

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
  await prisma.miniAppAttempt.create({ data: { telegramUserId: user.id, kind: "submit" } });
  const attempts = await prisma.miniAppAttempt.count({
    where: {
      telegramUserId: user.id,
      kind: "submit",
      createdAt: { gte: new Date(now - 60 * 60 * 1000) },
    },
  });
  if (attempts > MAX_ATTEMPTS_PER_HOUR) {
    console.warn(`[miniapp] лимит попыток: user=${user.id}, ${attempts} за час`);
    return reply(429, T.tooManyAttempts);
  }
  await prisma.miniAppAttempt.deleteMany({
    where: { createdAt: { lt: new Date(now - ATTEMPT_RETENTION_MS) } },
  });

  const group = OFFICIAL_GROUPS.find((g) => g.name === field(form, "groupName", 100));
  if (!group) return reply(400, T.noGroup);

  // Какую типовую проблему выбрал куратор и что ответил в её полях. Состав
  // полей задаёт тот же справочник, что рисует форму (lib/submissionLabels.ts),
  // поэтому проверка здесь и подсветка на телефоне не могут разойтись.
  const label = findLabel(group.name, field(form, "labelId", 64));
  if (!label) return reply(400, T.noLabel);

  const values = parseValues(field(form, "labelFields", 8000));
  if (values === null) return reply(400, T.unreadable);

  const photos = form.getAll("photo").filter((p): p is File => p instanceof File && p.size > 0);

  // Фото из пересланной переписки уже лежат в Telegram: их file_id пришли в
  // черновик (см. lib/forwardDraft.ts), и грузить их второй раз незачем —
  // ни телефону, ни нам. Берём их до проверки полноты: для ярлыка со
  // обязательным скрином они такие же приложенные фото, как и выбранные.
  const useForward = field(form, "useForward", 4) === "1";
  const forwardDraft = useForward
    ? await prisma.forwardDraft.findUnique({
        where: { telegramUserId: user.id },
        select: { id: true, photoFileIds: true },
      })
    : null;
  const forwardPhotoIds = forwardDraft?.photoFileIds ?? [];

  if (missingFields(label, values, photos.length + forwardPhotoIds.length).length > 0) {
    return reply(400, T.incomplete);
  }
  if (photos.length > MAX_PHOTOS) return reply(400, T.tooManyPhotos);
  if (photos.some((photo) => !photo.type.startsWith("image/"))) return reply(400, T.notImage);
  if (photos.reduce((sum, photo) => sum + photo.size, 0) > MAX_PHOTOS_BYTES) {
    return reply(413, T.photoTooBig);
  }

  // Порядок: описание → фото → тикет. Описание первым: обращение-мусор не
  // должно оставлять фото в служебном канале.
  //
  // Описание тикета — короткая суть: название проблемы и пояснение куратора.
  // Оно уходит в репорт руководству, поэтому почты, номера и пароли из полей
  // сюда не попадают — они в rawText, который видит только дежурный.
  //
  // Сразу — regex-чистка (на случай, если куратор вписал контакты прямо в
  // пояснение); суть пояснения ИИ допишет после ответа куратору (ниже,
  // rewriteSubmissionDescription), если куратор что-то написал сам.
  const summary = buildSummary(label, values);
  const details = buildDetails(label, values);
  const own = typeof values.description === "string" ? values.description : "";
  // Мусор ловим только у свободного «Басқа мәселе»: у остальных ярлыков суть
  // задана названием, и пустым обращение быть не может.
  if (label.id === "other" && isNoiseOnly(own)) {
    console.warn(`[miniapp] отклонено как мусор: user=${user.id}, ${own.length} симв.`);
    return reply(400, T.noise);
  }
  const cleaned = cleanTicketDescription(summary) || summary;

  // Фото до тикета: если Telegram их не принял, тикета без вложений быть не
  // должно — куратор повторит отправку целиком. Все фото уходят одним
  // альбомом, поэтому в служебном канале это одно сообщение с подписью.
  //
  // Фото может не быть вовсе: у «Ұсыныс», «Басқа мәселе» и прочих скрин
  // необязателен. Тогда в Telegram идти незачем — раньше шли всё равно и
  // получали «нет фото», которое куратор читал как «Telegram бұл фотоны
  // қабылдамады» и отправить обращение не мог совсем.
  const storageChatId = process.env.TELEGRAM_STORAGE_CHAT_ID!;
  const noPhotos: PhotoUpload = { ok: true, fileIds: [] };
  const upload = photos.length === 0
    ? noPhotos
    : await uploadPhotos(
    storageChatId,
    photos,
    // Подпись к фото в служебном канале — с полями целиком: по одному
    // названию ярлыка («Номер өзгерту») там ничего не понять, а это тот же
    // канал, куда дежурный заглядывает за скриншотом. Caption у Telegram —
    // до 1024 символов, поэтому с запасом обрезаем.
    `${user.name} · ${group.name}\n${details.slice(0, 900)}`
  );
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
  // Пересланные фото идут первыми: в цепочке скрин обычно и есть суть, а
  // то, что куратор доснял в форме, — уточнение.
  const photoFileIds = [...forwardPhotoIds, ...upload.fileIds].slice(0, MAX_PHOTOS);

  const preset = await prisma.groupPreset.findUnique({
    where: { name: group.name },
    select: { emoji: true },
  });

  try {
    const issue = await insertSentIssue(group.name, preset?.emoji ?? group.emoji, cleaned, null, {
      clientSubmissionId,
      telegramUserId: user.id,
      authorName: user.name,
      rawText: details,
      studentContact: extractContact(values),
      lessonLink: extractLessonLink(values),
      // Без фото — пустая строка: колонка обязательная, а undefined Prisma
      // не принимает. Отличать «нет фото» от «одно фото» по ней нельзя,
      // для этого есть photoFileIds (см. photoCount в /api/issues).
      photoFileId: photoFileIds[0] ?? "",
      photoFileIds,
      labelId: label.id,
      labelFields: values,
    });
    // Черновик пересылки своё отработал: оставить его — значит подставить
    // ту же переписку в следующее обращение.
    if (forwardDraft) {
      await prisma.forwardDraft.delete({ where: { id: forwardDraft.id } }).catch(() => {});
    }

    // Обращение — в ту рабочую группу, которую куратор выбрал первым
    // экраном (если рубильник включён). После тикета, а не вместо: отправка
    // может не удаться, и терять из-за этого само обращение нельзя.
    const link = await postSubmissionToGroup({
      issueId: issue.id,
      groupName: group.name,
      authorName: user.name,
      telegramUserId: user.id,
      label,
      values,
      photoFileIds,
    }).catch((err) => {
      console.warn(`[miniapp] обращение не ушло в группу: ${String(err).slice(0, 200)}`);
      return null;
    });
    // Ссылка на сообщение в группе — это «Открыть в Telegram» на карточке.
    // У тикетов из формы её раньше не было вовсе.
    if (link) {
      await prisma.issue.update({ where: { id: issue.id }, data: { telegramLink: link } });
    }
    if (own.trim()) {
      after(() =>
        rewriteSubmissionDescription(issue.id, summary, cleaned).catch((err) =>
          console.warn(`[miniapp] ИИ-описание не записалось: ${String(err).slice(0, 200)}`)
        )
      );
    }

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
