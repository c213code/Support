import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString, shiftDateString } from "@/lib/date";
import { sendDailyReviewMessage } from "@/lib/dailyReview";

// Утреннее напоминание — Vercel Cron бьёт сюда ~09:00 по Алматы (см.
// vercel.json, "0 4 * * *" в UTC). Часть дежурных не отправляет вечерний
// репорт сразу в 22:00, а разбирает вчерашний день с утра — досылает
// repeat вчерашней сводки, только если "📤 Отправить в группу" так и не
// нажали (см. ReportSendLog, пишется в report_send-обработчике вебхука).
// Если вчера уже отправили — тихо ничего не делаем, чтобы не задвоить
// репорт в чате с боссами.
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reportDate = shiftDateString(todayDateString(), -1);

  const alreadySent = await prisma.reportSendLog.findUnique({
    where: { reportDate },
  });
  if (alreadySent) {
    return NextResponse.json({ ok: true, skipped: "already sent" });
  }

  const result = await sendDailyReviewMessage(reportDate);

  if (!result.sent) {
    return NextResponse.json({ ok: true, skipped: result.reason });
  }
  return NextResponse.json({ ok: true, recipientId: result.recipientId });
}
