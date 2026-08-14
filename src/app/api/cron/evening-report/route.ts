import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { todayDateString } from "@/lib/date";
import { sendDailyReviewMessage } from "@/lib/dailyReview";

// Вечерняя сводка дня — Vercel Cron бьёт сюда ~22:00 по Алматы (см.
// vercel.json, "0 17 * * *" в UTC, Алматы — фиксированный UTC+5). Получателя
// вычисляем не по расписанию (его в системе нет), а по факту: им становится
// тот из агентов, кто сегодня больше всех писал в привязанных чатах (см.
// pickRecipient в lib/dailyReview.ts) — обычно это и есть дежурный.
//
// Если дежурный так и не нажмёт "Отправить в группу" сегодня вечером — это
// не потеряется: утренний cron (/api/cron/morning-report-check, ~09:00)
// напомнит про вчерашний репорт, если ReportSendLog за эту дату всё ещё
// пуст.
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reportDate = todayDateString();
  const result = await sendDailyReviewMessage(reportDate);

  if (!result.sent) {
    return NextResponse.json({ ok: true, skipped: result.reason });
  }
  return NextResponse.json({ ok: true, recipientId: result.recipientId });
}
