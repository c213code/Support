import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { todayDateString } from "@/lib/date";
import { sendDailyReviewMessage } from "@/lib/dailyReview";

// Вечерняя сводка дня — Vercel Cron бьёт сюда ~22:00 по Алматы (см.
// vercel.json, "0 17 * * *" в UTC, Алматы — фиксированный UTC+5). В будни
// обзор и вопрос получают Ерош и Алпа; в выходные — выбранный дежурный
// (см. pickRecipient в lib/dailyReview.ts).
//
// Если репорт не отправят вечером, в 09:00 бот напомнит, а в 11:00 сам
// отправит его при отсутствии ReportSendLog за эту дату.
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reportDate = todayDateString();
  const alreadySent = await prisma.reportSendLog.findUnique({ where: { reportDate } });
  if (alreadySent) return NextResponse.json({ ok: true, skipped: "already sent" });
  const result = await sendDailyReviewMessage(reportDate);

  if (!result.sent) {
    const failed = result.reason === "missing agents" || result.reason === "delivery failed";
    return NextResponse.json(
      { ok: !failed, skipped: result.reason, deliveredCount: result.recipientIds?.length ?? 0 },
      { status: failed ? 502 : 200 }
    );
  }
  return NextResponse.json({ ok: true, recipientCount: result.recipientIds.length });
}
