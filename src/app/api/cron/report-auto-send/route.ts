import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { shiftDateString, todayDateString } from "@/lib/date";
import { sendReportToGroup } from "@/lib/reportSend";

// 11:00 по Алматы: вчерашний репорт уходит сам, если его не отправили кнопкой
// или командой. sendReportToGroup проверяет ReportSendLog и использует тот же
// текст, целевой чат и разбиение на части, что ручная отправка.
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const reportDate = shiftDateString(todayDateString(), -1);
  const result = await sendReportToGroup(reportDate);
  if (result.ok) return NextResponse.json({ ok: true, sent: true, reportDate });
  if (result.reason === "already-sent" || result.reason === "empty") {
    return NextResponse.json({ ok: true, skipped: result.reason, reportDate });
  }
  return NextResponse.json({ ok: false, error: result.reason, reportDate }, { status: 502 });
}
