import { prisma } from "@/lib/prisma";
import { sendTelegramMessage } from "@/lib/telegram";
import { buildReport } from "@/lib/reportExtras";
import { formatTimeAlmaty } from "@/lib/date";

export type SendReportResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no-target" }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "already-sent"; sentAt: Date }
  // Telegram не принял сообщение. sentParts > 0 — первые части уже в
  // группе, остальные нет: повторять целиком нельзя, будет дубль.
  | { ok: false; reason: "send-failed"; sentParts: number; totalParts: number };

export { splitReport } from "@/lib/reportSplit";

// Рассылка готового репорта в рабочую группу — общая логика между кнопкой
// "📤 Отправить в группу" (под вечерней сводкой и карточками разбора) и
// командой /send. Проверяет ReportSendLog ПЕРЕД отправкой (а не только
// пишет в него после): без этого повторный клик или случайный повтор
// команды дублировал бы репорт в чат с боссами — раньше это отдавалось на
// откуп получателю (не жать дважды), теперь бот сам не отправит второй раз.
export async function sendReportToGroup(reportDate: string): Promise<SendReportResult> {
  const targetChatId = process.env.REPORT_TARGET_CHAT_ID;
  if (!targetChatId) {
    return { ok: false, reason: "no-target" };
  }

  const already = await prisma.reportSendLog.findUnique({ where: { reportDate } });
  if (already) {
    return { ok: false, reason: "already-sent", sentAt: already.sentAt };
  }

  // HTML — ради ссылок «#4JQ9PW» на тикеты на доске; простой текст
  // возвращаем вызывающему (его показывают в личке как «вот что ушло»).
  const { text, messages } = await buildReport(reportDate);
  if (!text) {
    return { ok: false, reason: "empty" };
  }

  // Тема (форум-топик) внутри группы — опционально: если чат без "Тем"
  // или репорт должен идти в общий поток, переменную просто не задают.
  const targetThreadId = process.env.REPORT_TARGET_THREAD_ID
    ? Number(process.env.REPORT_TARGET_THREAD_ID)
    : undefined;
  for (const [index, message] of messages.entries()) {
    const sent = await sendTelegramMessage(targetChatId, message, undefined, targetThreadId, "HTML");
    if (!sent) {
      if (index > 0) {
        await prisma.reportSendLog.upsert({
          where: { reportDate }, update: { sentAt: new Date() }, create: { reportDate },
        });
      }
      return { ok: false, reason: "send-failed", sentParts: index, totalParts: messages.length };
    }
  }

  // upsert, не create: между "проверили ReportSendLog" и записью сюда
  // теоретически могла проскочить вторая параллельная отправка — тогда
  // просто обновится sentAt, вместо падения на уникальном ключе.
  await prisma.reportSendLog.upsert({
    where: { reportDate },
    update: { sentAt: new Date() },
    create: { reportDate },
  });

  return { ok: true, text };
}

// Человекочитаемая причина, почему /send (или кнопка «Отправить в группу»)
// не сработала. Живёт здесь, рядом с SendReportResult, потому что нужна и в
// колбэках вебхука, и в командах бота.
export function describeSendFailure(
  result: Extract<SendReportResult, { ok: false }>
): string {
  switch (result.reason) {
    case "no-target":
      return "Группа для отправки ещё не настроена (REPORT_TARGET_CHAT_ID)";
    case "empty":
      return "За этот день нечего отправлять";
    case "already-sent":
      return `Уже отправлено сегодня в ${formatTimeAlmaty(result.sentAt)}`;
    case "send-failed":
      return result.sentParts === 0
        ? "Telegram не принял репорт — в группу ничего не ушло, попробуйте ещё раз"
        : `Ушло ${result.sentParts} из ${result.totalParts} частей — остальное Telegram не принял, дошлите с сайта`;
  }
}
