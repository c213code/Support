import { prisma } from "@/lib/prisma";
import { sendTelegramMessage } from "@/lib/telegram";
import { generateReportText } from "@/lib/report";
import { formatTimeAlmaty } from "@/lib/date";

export type SendReportResult =
  | { ok: true; text: string }
  | { ok: false; reason: "no-target" }
  | { ok: false; reason: "empty" }
  | { ok: false; reason: "already-sent"; sentAt: Date }
  // Telegram не принял сообщение. sentParts > 0 — первые части уже в
  // группе, остальные нет: повторять целиком нельзя, будет дубль.
  | { ok: false; reason: "send-failed"; sentParts: number; totalParts: number };

// Лимит Telegram на одно сообщение — 4096 символов; берём с запасом.
const MAX_PART = 3900;

// Длинный репорт — частями. Режем по пустой строке между группами, а если
// одна группа сама длиннее лимита — по строкам: тикет не должен рваться
// посередине. 28.09 репорт вышел в 4582 символа, Telegram его отклонил, а
// бот записал «отправлено» и ответил ✅ — в группу не ушло ничего.
export function splitReport(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  const push = (piece: string, sep: string) => {
    if (!current) current = piece;
    else if (current.length + sep.length + piece.length <= MAX_PART) current += sep + piece;
    else {
      parts.push(current);
      current = piece;
    }
  };
  for (const block of text.split(/\n{2,}/)) {
    if (block.length <= MAX_PART) {
      push(block, "\n\n");
      continue;
    }
    for (const line of block.split("\n")) push(line.slice(0, MAX_PART), "\n");
  }
  if (current) parts.push(current);
  return parts;
}

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
  // Результат отправки проверяем: раньше его не смотрели, и отклонённый
  // Telegram репорт (длиннее 4096 символов) записывался как отправленный.
  const parts = splitReport(text);
  for (const [index, part] of parts.entries()) {
    const sent = await sendTelegramMessage(targetChatId, part, undefined, targetThreadId);
    if (!sent) {
      if (index > 0) {
        // Начало уже в группе — журнал пишем, чтобы повторное нажатие не
        // продублировало его; хвост человек дошлёт сам.
        await prisma.reportSendLog.upsert({
          where: { reportDate },
          update: { sentAt: new Date() },
          create: { reportDate },
        });
      }
      return { ok: false, reason: "send-failed", sentParts: index, totalParts: parts.length };
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
