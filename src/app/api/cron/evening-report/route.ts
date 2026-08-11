import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString, dayRangeUtc } from "@/lib/date";
import { STATUS_META } from "@/lib/status";
import { agentTelegramEntries } from "@/lib/agentTelegram";
import { sendTelegramMessage, type InlineKeyboard } from "@/lib/telegram";

const UNRESOLVED_TICKET_CAP = 15;
const ACTIVE_STATUSES = new Set(["IN_PROGRESS", "PENDING", "ESCALATED"]);

// Вечерняя сводка дня — Vercel Cron бьёт сюда ~22:00 по Алматы (см.
// vercel.json, "0 17 * * *" в UTC, Алматы — фиксированный UTC+5).
// Получателя вычисляем не по расписанию (его в системе нет), а по факту:
// им становится тот из агентов, кто сегодня больше всех писал в
// привязанных чатах (см. pickRecipient) — обычно это и есть дежурный.
//
// Кнопка "Отправить в группу" внутри сводки шлёт готовый текст репорта в
// REPORT_TARGET_CHAT_ID — какой это чат, пока не решили, поэтому
// переменная не задана; когда появится значение, отправка заработает
// сама, менять код не нужно (см. REPORT_SEND_PREFIX в вебхуке).
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reportDate = todayDateString();
  const issues = await prisma.issue.findMany({
    where: { reportDate },
    orderBy: { position: "asc" },
  });

  if (issues.length === 0) {
    return NextResponse.json({ ok: true, skipped: "no tickets today" });
  }

  const recipientId = await pickRecipient(reportDate);
  if (!recipientId) {
    return NextResponse.json({ ok: true, skipped: "AGENT_TELEGRAM_IDS not configured" });
  }

  const sentCount = issues.filter((i) => i.status === "SENT").length;
  const activeCount = issues.filter((i) => ACTIVE_STATUSES.has(i.status)).length;
  const resolvedCount = issues.filter((i) => i.status === "RESOLVED").length;

  const summary = [
    `🌙 Вечерний срез — ${reportDate}`,
    "",
    `📨 Отправлено: ${sentCount}`,
    `🔄 В работе/Пендинг/Передано: ${activeCount}`,
    `✅ Решено: ${resolvedCount}`,
    "",
    `Всего тикетов: ${issues.length}`,
  ].join("\n");

  const summaryKeyboard: InlineKeyboard = [
    [{ text: "📤 Отправить в группу", callback_data: `report_send:${reportDate}` }],
  ];
  await sendTelegramMessage(recipientId, summary, summaryKeyboard);

  // Быстрые кнопки статуса под каждым ещё не решённым тикетом — чтобы
  // закрыть очевидное можно было сразу тут, не открывая сайт. Капаем
  // список, а не шлём все: на насыщенный день сообщений на 30+ штук в
  // личку — уже спам, а не сводка.
  const unresolved = issues.filter((i) => i.status !== "RESOLVED");
  for (const issue of unresolved.slice(0, UNRESOLVED_TICKET_CAP)) {
    const meta = STATUS_META[issue.status];
    const text = `${meta.emoji} ${issue.groupName}: ${issue.description}`;
    const row: InlineKeyboard[number] = [];
    if (issue.status !== "IN_PROGRESS") {
      row.push({
        text: "🔄 В работе",
        callback_data: `issue_status:${issue.id}:IN_PROGRESS`,
      });
    }
    row.push({
      text: "✅ Решено",
      callback_data: `issue_status:${issue.id}:RESOLVED`,
    });
    await sendTelegramMessage(recipientId, text, [row]);
  }
  if (unresolved.length > UNRESOLVED_TICKET_CAP) {
    await sendTelegramMessage(
      recipientId,
      `… и ещё ${unresolved.length - UNRESOLVED_TICKET_CAP} тикет(ов) без быстрых кнопок — остальное на сайте.`
    );
  }

  return NextResponse.json({
    ok: true,
    recipientId,
    counts: { sent: sentCount, active: activeCount, resolved: resolvedCount },
    quickActionsSent: Math.min(unresolved.length, UNRESOLVED_TICKET_CAP),
  });
}

// "Кто сегодня дежурил" в системе нигде явно не записано, поэтому судим
// по факту — кто больше всех писал агентских сообщений в привязанные
// чаты сегодня. Это стало возможным только после того, как свои
// сообщения агентов начали сохраняться (archived) в TelegramMessage
// вместо полного отбрасывания (см. isOwnAgentMessage в вебхуке) — раньше
// посчитать было не по чему.
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
