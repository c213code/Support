import { prisma } from "@/lib/prisma";
import { sendTelegramMessage } from "@/lib/telegram";
import { generateReportText } from "@/lib/report";

export type SendReportResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no-target" }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "already-sent"; sentAt: Date };

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

  const [issues, presets] = await Promise.all([
    prisma.issue.findMany({ where: { reportDate } }),
    prisma.groupPreset.findMany(),
  ]);
  const text = generateReportText(issues, presets);
  if (!text) {
    return { ok: false, reason: "empty" };
  }

  // Тема (форум-топик) внутри группы — опционально: если чат без "Тем"
  // или репорт должен идти в общий поток, переменную просто не задают.
  const targetThreadId = process.env.REPORT_TARGET_THREAD_ID
    ? Number(process.env.REPORT_TARGET_THREAD_ID)
    : undefined;
  await sendTelegramMessage(targetChatId, text, undefined, targetThreadId);

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
