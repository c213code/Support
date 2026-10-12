import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { dayOfWeek, shiftDateString, todayDateString } from "@/lib/date";
import { sendReportToGroup } from "@/lib/reportSend";

// 11:00 по Алматы: вчерашний репорт уходит сам, если его не отправили кнопкой
// или командой. sendReportToGroup проверяет ReportSendLog и использует тот же
// текст, целевой чат и разбиение на части, что ручная отправка.
//
// Только со вторника по субботу — то есть репорты за понедельник–пятницу.
// Выходные сами в группу боссов не уходят: их отправляют руками, если нужно.
// Проверка здесь, а не в расписании cron: оно в UTC, а день недели нужен
// по Алматы — так в одном месте и без пересчёта часовых поясов.
const AUTO_SEND_DAYS = new Set([2, 3, 4, 5, 6]);
export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = todayDateString();
  const reportDate = shiftDateString(today, -1);
  if (!AUTO_SEND_DAYS.has(dayOfWeek(today))) {
    return NextResponse.json({ ok: true, skipped: "not-a-send-day", reportDate });
  }
  const result = await sendReportToGroup(reportDate);
  if (result.ok) return NextResponse.json({ ok: true, sent: true, reportDate });
  if (result.reason === "already-sent" || result.reason === "empty") {
    return NextResponse.json({ ok: true, skipped: result.reason, reportDate });
  }
  return NextResponse.json({ ok: false, error: result.reason, reportDate }, { status: 502 });
}
