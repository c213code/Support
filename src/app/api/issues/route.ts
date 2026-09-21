import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { isIssueStatus } from "@/lib/status";
import { isEscalationTeam } from "@/lib/escalation";
import { cleanTicketDescription } from "@/lib/textClean";
import { extractTicketHints } from "@/lib/ticketHints";
import { detectEmailChangeRequest } from "@/lib/emailChangeRequest";
import { mentionsUntTest } from "@/lib/untResetRequest";
import { platformEnabled } from "@/lib/platform";
import { unreadReplyCounts } from "@/lib/submissionChat";
import { describeFields, findLabel } from "@/lib/submissionLabels";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate: date },
    orderBy: [{ position: "asc" }],
  });

  // Что бот успел написать в рабочие группы по этим тикетам — приезжает
  // вместе со списком, одним запросом на всю доску: иначе карточкам
  // пришлось бы ходить за этим по одной, а их за активный день несколько
  // десятков.
  const botReplies = await prisma.botReply.findMany({
    where: { issueId: { in: issues.map((i) => i.id) }, deleted: false },
    orderBy: { sentAt: "asc" },
  });
  const byIssue = new Map<string, typeof botReplies>();
  for (const reply of botReplies) {
    const list = byIssue.get(reply.issueId) ?? [];
    list.push(reply);
    byIssue.set(reply.issueId, list);
  }

  // Почта/телефон ученика и факт вложения — то, что чистка описания
  // намеренно выкидывает (в репорт боссам это не нужно), но без чего
  // агенту не за что зацепиться, чтобы начать работу. Тянем сырые тексты
  // всех привязанных к тикету сообщений одним запросом.
  //
  // Ищем по usedForIssueId, а не по списку ссылок: уточнения (присланная
  // почта, дописанные подробности) привязываются к тикету, но ссылку на
  // карточку намеренно не добавляют — она там значит "ещё одно отдельное
  // обращение по той же проблеме" (см. ATTACH_LINK_POLICY в вебхуке). По
  // ссылкам такие сообщения не нашлись бы, и присланная почта пропала бы с
  // карточки. telegramLink добавлен к запросу отдельно: у тикета, заведённого
  // руками по вставленной ссылке, привязанного сообщения может не быть.
  const issueIds = issues.map((i) => i.id);
  const allLinks = issues.flatMap((i) => [i.telegramLink, ...i.extraLinks]).filter(
    (l): l is string => l != null
  );
  const sources = await prisma.telegramMessage.findMany({
    where: {
      OR: [
        { usedForIssueId: { in: issueIds } },
        ...(allLinks.length ? [{ messageLink: { in: allLinks } }] : []),
      ],
    },
    select: { messageLink: true, text: true, usedForIssueId: true },
  });

  const textByLink = new Map(sources.map((s) => [s.messageLink, s.text]));
  const textsByIssue = new Map<string, Array<string | null>>();
  for (const source of sources) {
    if (!source.usedForIssueId) continue;
    const list = textsByIssue.get(source.usedForIssueId) ?? [];
    list.push(source.text);
    textsByIssue.set(source.usedForIssueId, list);
  }

  // Распознавание «смените почту» считаем только когда инструмент включён —
  // иначе кнопка на карточке вела бы в никуда (см. platformEnabled).
  const platformOn = platformEnabled();

  // Обращения из формы мини-аппа: у них нет сообщения в Telegram, и сырой
  // текст с контактом ученика лежит в заявке — без неё карточка осталась бы
  // без почты/телефона, а кнопки «Логи»/«Обнулить ДТ» не появились бы.
  const submissions = await prisma.issueSubmission.findMany({
    where: { issueId: { in: issueIds } },
    select: {
      issueId: true,
      authorName: true,
      rawText: true,
      labelId: true,
      labelFields: true,
      studentContact: true,
      lessonLink: true,
      photoFileId: true,
      photoFileIds: true,
    },
    orderBy: { createdAt: "asc" },
  });
  // После склейки у тикета может быть несколько заявок: контакты для
  // подсказок берём из всех, а на карточке показываем первую (самую раннюю).
  const submissionsByIssue = new Map<string, typeof submissions>();
  for (const s of submissions) {
    submissionsByIssue.set(s.issueId, [...(submissionsByIssue.get(s.issueId) ?? []), s]);
  }

  // Сколько ответов куратора дежурный ещё не открывал — метка на карточке.
  // Без неё ответ на уточнение было бы видно, только если зайти в тикет, а
  // заходят в него как раз потому, что заметили метку.
  const unreadByIssue = await unreadReplyCounts(issueIds);

  return NextResponse.json({
    issues: issues.map((issue) => {
      const issueSubmissions = submissionsByIssue.get(issue.id) ?? [];
      const submission = issueSubmissions[0];
      const label =
        submission?.labelId ? findLabel(issue.groupName, submission.labelId) : null;
      const labelValues = (submission?.labelFields ?? {}) as Record<
        string,
        string | string[]
      >;
      const labelText = (id: string) =>
        typeof labelValues[id] === "string" ? (labelValues[id] as string).trim() : "";

      // Ярлык прямо сказал, что менять на что, — распознавать это регуляркой
      // из текста больше незачем (она и ошибалась, когда почт в обращении
      // было больше двух). Регулярка остаётся для обращений без ярлыка.
      const labelEmailChange =
        submission?.labelId === "email-change" &&
        labelText("oldEmail").includes("@") &&
        labelText("newEmail").includes("@")
          ? { oldEmail: labelText("oldEmail"), newEmail: labelText("newEmail") }
          : null;
      // Исходные (сырые) тексты обращения: и в hints, и в распознавании смены
      // почты нужен именно сырой текст — в description почты уже вычищены.
      // Ссылку на урок из формы сюда намеренно не кладём: длинный числовой id
      // в ней регулярка подсказок приняла бы за номер телефона.
      const rawTexts = [
        ...(textsByIssue.get(issue.id) ?? []),
        ...[issue.telegramLink, ...issue.extraLinks].map((l) =>
          l ? (textByLink.get(l) ?? null) : null
        ),
        ...issueSubmissions.flatMap((s) => [s.rawText, s.studentContact]),
      ];
      return {
        ...issue,
        botReplies: byIssue.get(issue.id) ?? [],
        // Одно и то же сообщение может попасть в оба списка (привязано и
        // указано ссылкой) — extractTicketHints складывает почты/телефоны в
        // Set, поэтому дубликаты безвредны.
        hints: extractTicketHints(rawTexts),
        emailChange: platformOn
          ? (labelEmailChange ?? detectEmailChangeRequest(rawTexts.filter(Boolean).join("\n")))
          : null,
        // Ярлык «ҰБТ / ДТ» — это и есть заявка про уровневый тест: кнопка
        // сброса нужна независимо от того, какие слова в тексте.
        untReset:
          platformOn &&
          (submission?.labelId === "unt-dt" ||
            mentionsUntTest(rawTexts.filter(Boolean).join("\n"))),
        submission: submission
          ? {
              authorName: submission.authorName,
              studentContact: submission.studentContact,
              lessonLink: submission.lessonLink,
              // У обращений, поданных до появления нескольких фото,
              // photoFileIds пуст, а фото ровно одно (в photoFileId).
              // Старые обращения (до нескольких фото) держат единственное фото в
              // photoFileId, а photoFileIds у них пуст — отсюда запасной вариант.
              // Но «ни одного фото» — это ноль: у ярлыков, где скрин необязателен
              // («Ұсыныс», «Басқа мәселе»), раньше выходила единица, карточка
              // просила несуществующее фото и показывала «не загрузилось».
              photoCount: submission.photoFileIds.length || (submission.photoFileId ? 1 : 0),
              unreadReplies: unreadByIssue.get(issue.id) ?? 0,
              // Что за типовая проблема и что куратор заполнил в её полях.
              // Дежурному это заменяет переспрашивание: форма уже собрала
              // почту, номер и остальное (см. lib/submissionLabels.ts).
              labelTitle: label?.title ?? null,
              // Поля парами «подпись — значение»: карточке нужно показать,
              // какой номер старый, а какой новый, иначе они неразличимы.
              fields: label
                ? describeFields(
                    label,
                    (submission.labelFields ?? {}) as Record<string, string | string[]>
                  )
                : [],
            }
          : null,
      };
    }),
  });
}

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  if (!body?.reportDate || !body?.groupName || !body?.description) {
    return NextResponse.json(
      { error: "reportDate, groupName and description are required" },
      { status: 400 }
    );
  }

  const last = await prisma.issue.findFirst({
    where: { reportDate: body.reportDate, groupName: body.groupName },
    orderBy: { position: "desc" },
  });

  const issue = await prisma.issue.create({
    data: {
      reportDate: body.reportDate,
      groupName: body.groupName,
      groupEmoji: body.groupEmoji ?? null,
      position: (last?.position ?? 0) + 1,
      description: cleanTicketDescription(body.description),
      telegramLink: body.telegramLink || null,
      status: isIssueStatus(body.status) ? body.status : "SENT",
      note: body.note || null,
      ticketLink: body.ticketLink || null,
      escalatedTeam: isEscalationTeam(body.escalatedTeam)
        ? body.escalatedTeam
        : null,
      escalatedAssignee: body.escalatedAssignee || null,
      createdBy: identity.name,
    },
  });

  return NextResponse.json({ issue }, { status: 201 });
}
