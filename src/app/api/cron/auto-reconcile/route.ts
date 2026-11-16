import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { todayDateString } from "@/lib/date";
import { autoReconcileEnabled, runAutoReconcile } from "@/lib/autoReconcile";

// Вечерний авто-разбор дня с применением — 21:30 по Алматы ("30 16 * * *"
// в UTC, см. vercel.json), за полчаса до вечерней сводки в 22:00. Второй
// вызов в 21:45 доделывает запуск, если первый не уложился в maxDuration.
// Подробности — lib/autoReconcile.ts.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const reportDate = todayDateString();
  if (!autoReconcileEnabled()) {
    return NextResponse.json({ ok: true, skipped: "AUTO_RECONCILE=off", reportDate });
  }
  // 20 с запаса на применение и ответ.
  const deadline = Date.now() + (maxDuration - 20) * 1000;
  const result = await runAutoReconcile(reportDate, deadline);
  return NextResponse.json({ ok: true, reportDate, ...result });
}
