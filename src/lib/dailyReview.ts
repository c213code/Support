import { prisma } from "@/lib/prisma";
import { dayRangeUtc } from "@/lib/date";
import { STATUS_META } from "@/lib/status";
import { agentTelegramEntries } from "@/lib/agentTelegram";
import { sendTelegramMessage, escapeHtml, type InlineKeyboard } from "@/lib/telegram";
import { generateReportText } from "@/lib/report";
import {
  ISSUE_STATUS_PREFIX,
  ISSUE_ESCALATE_PREFIX,
  ISSUE_NOTE_PREFIX,
  REFRESH_LIST_PREFIX,
  REPORT_SEND_PREFIX,
} from "@/lib/telegramCallbacks";

const UNRESOLVED_TICKET_CAP = 15;
const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "PENDING", "ESCALATED"]);
// Лимит длины сообщения в Telegram — 4096 символов.
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TRUNCATION_NOTE = "…\n\n(обрезано, полный текст — на сайте)";

export type DailyReviewResult =
  | { sent: true; recipientId: number }
  | { sent: false; reason: "no tickets" | "no recipient" };

// Общая логика для двух cron-эндпоинтов: вечерней сводки за сегодня
// (`/api/cron/evening-report`, ~22:00) и утреннего напоминания по
// вчерашнему репорту, если его вечером так и не отправили
// (`/api/cron/morning-report-check`, ~09:00). Обе дёргают одно и то же —
// разница только в том, для какой даты и при каком условии (см. каждый
// роут).
//
// Показывает не просто цифры, а сам текст будущего репорта
// (`generateReportText` — то же, что строится на сайте) — иначе "ревью"
// по кнопке было бы вслепую: агент видел бы только количество тикетов, а
// не то, что реально уйдёт в чат с боссами.
export async function sendDailyReviewMessage(
  reportDate: string
): Promise<DailyReviewResult> {
  const [issues, presets] = await Promise.all([
    prisma.issue.findMany({
      where: { reportDate },
      orderBy: { position: "asc" },
    }),
    prisma.groupPreset.findMany(),
  ]);

  if (issues.length === 0) {
    return { sent: false, reason: "no tickets" };
  }

  const recipientId = await pickRecipient(reportDate);
  if (!recipientId) {
    return { sent: false, reason: "no recipient" };
  }

  const sentCount = issues.filter((i) => i.status === "SENT").length;
  const activeCount = issues.filter((i) => ACTIVE_STATUSES.has(i.status)).length;
  const resolvedCount = issues.filter((i) => i.status === "RESOLVED").length;

  const reportText = generateReportText(issues, presets);
  const body =
    reportText ||
    "Пока нечего показать — все тикеты ещё «Отправлено», статус по ним не выставлен.";
  const header = [
    `🌙 Репорт — ${reportDate}`,
    `📨 Отправлено: ${sentCount} · 🔄 В работе/Пендинг/Передано: ${activeCount} · ✅ Решено: ${resolvedCount}`,
    "",
    "Вот что уйдёт в группу:",
    "",
  ].join("\n");

  let preview = header + body;
  if (preview.length > TELEGRAM_MESSAGE_LIMIT) {
    preview =
      preview.slice(0, TELEGRAM_MESSAGE_LIMIT - TRUNCATION_NOTE.length) +
      TRUNCATION_NOTE;
  }

  const summaryKeyboard: InlineKeyboard = [
    [{ text: "📤 Отправить в группу", callback_data: `${REPORT_SEND_PREFIX}${reportDate}` }],
  ];
  await sendTelegramMessage(recipientId, preview, summaryKeyboard);

  const listMessage = await buildUnresolvedListMessage(reportDate);
  if (listMessage) {
    await sendTelegramMessage(
      recipientId,
      listMessage.text,
      listMessage.keyboard,
      undefined,
      "HTML"
    );
  }

  return { sent: true, recipientId };
}

export type UnresolvedListMessage = { text: string; keyboard: InlineKeyboard };

// Пронумерованный список нерешённых тикетов дня + клавиатура под ним, по
// строке кнопок на тикет (номер строки = номер в списке). Раньше — по
// отдельному сообщению на тикет, но на насыщенный день это стена из 15
// одинаковых бабблов, в которых легко потеряться. Вынесено в отдельную
// функцию — её же дёргает кнопка "🔁 Обновить список" (REFRESH_LIST_PREFIX
// в вебхуке), чтобы пересобрать актуальную версию через editMessageText, а
// не слать новое сообщение поверх старого. Капаем список, а не показываем
// все: и сообщение, и клавиатура не бесконечны.
export async function buildUnresolvedListMessage(
  reportDate: string
): Promise<UnresolvedListMessage | null> {
  const unresolved = await prisma.issue.findMany({
    where: { reportDate, status: { not: "RESOLVED" } },
    orderBy: { position: "asc" },
  });
  if (unresolved.length === 0) return null;

  const capped = unresolved.slice(0, UNRESOLVED_TICKET_CAP);
  const listLines = capped.map((issue, idx) => {
    const meta = STATUS_META[issue.status];
    // Компактная кликабельная ссылка (🔗) вместо голого URL — тот на
    // отдельной длинной строке тратил бы половину списка на "буквы",
    // parse_mode "HTML" ниже требует экранировать пользовательский текст
    // (описание/группа), сама ссылка — доверенное значение из БД.
    const link = issue.telegramLink
      ? ` <a href="${escapeHtml(issue.telegramLink)}">🔗</a>`
      : "";
    return `${idx + 1}. ${meta.emoji} ${escapeHtml(issue.groupName)}: ${escapeHtml(issue.description)}${link}`;
  });
  if (unresolved.length > UNRESOLVED_TICKET_CAP) {
    listLines.push(
      `\n… и ещё ${unresolved.length - UNRESOLVED_TICKET_CAP} тикет(ов) без быстрых кнопок — остальное на сайте.`
    );
  }

  let listText = listLines.join("\n");
  if (listText.length > TELEGRAM_MESSAGE_LIMIT) {
    // Режем по целым строкам, не по символам — обрубить HTML-тег ссылки
    // посередине означало бы, что Telegram отклонит сообщение целиком
    // из-за незакрытого тега.
    const kept: string[] = [];
    let length = TRUNCATION_NOTE.length;
    for (const line of listLines) {
      if (length + line.length + 1 > TELEGRAM_MESSAGE_LIMIT) break;
      kept.push(line);
      length += line.length + 1;
    }
    listText = `${kept.join("\n")}\n${TRUNCATION_NOTE}`;
  }

  const statusKeyboard: InlineKeyboard = capped.map((issue, idx) => {
    const row: InlineKeyboard[number] = [];
    if (issue.status !== "IN_PROGRESS") {
      row.push({
        text: `${idx + 1} 🔄`,
        callback_data: `${ISSUE_STATUS_PREFIX}${issue.id}:IN_PROGRESS`,
      });
    }
    if (issue.status !== "ESCALATED") {
      row.push({
        text: `${idx + 1} ⚠️`,
        callback_data: `${ISSUE_ESCALATE_PREFIX}${issue.id}`,
      });
    }
    row.push({
      text: `${idx + 1} 📝`,
      callback_data: `${ISSUE_NOTE_PREFIX}${issue.id}`,
    });
    row.push({
      text: `${idx + 1} ✅`,
      callback_data: `${ISSUE_STATUS_PREFIX}${issue.id}:RESOLVED`,
    });
    return row;
  });
  // Отдельной строкой — не смешана с рядами тикетов, поэтому снятие одной
  // строки тикета (см. ISSUE_STATUS_PREFIX/ISSUE_ESCALATE_PREFIX в
  // вебхуке — они фильтруют по id конкретного тикета) её не заденет.
  statusKeyboard.push([
    { text: "🔁 Обновить список", callback_data: `${REFRESH_LIST_PREFIX}${reportDate}` },
  ]);

  return { text: listText, keyboard: statusKeyboard };
}

// "Кто дежурил в этот день" в системе нигде явно не записано, поэтому
// судим по факту — кто больше всех писал агентских сообщений в
// привязанные чаты в тот день (см. isOwnAgentMessage в вебхуке — только
// после того, как свои сообщения агентов начали сохраняться, это стало
// возможно посчитать).
async function pickRecipient(reportDate: string): Promise<number | null> {
  const entries = agentTelegramEntries();
  if (entries.length === 0) return null;

  const { start, end } = dayRangeUtc(reportDate);
  const ids = entries.map(([, id]) => BigInt(id));

  const counts = await prisma.telegramMessage.groupBy({
    by: ["fromId"],
    where: { fromId: { in: ids }, receivedAt: { gte: start, lt: end } },
    _count: { _all: true },
  });

  if (counts.length === 0) {
    // Тихий день без агентской переписки в привязанных чатах — шлём
    // первому из списка, чтобы сводка не потерялась молча.
    return entries[0][1];
  }

  const top = counts.reduce((best, row) =>
    row._count._all > best._count._all ? row : best
  );
  return top.fromId != null ? Number(top.fromId) : entries[0][1];
}
