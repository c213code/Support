import { NextResponse } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled } from "@/lib/platform";
import { logsServiceEnabled } from "@/lib/logsClient";

export async function GET() {
  const identity = await getCurrentIdentity();
  return NextResponse.json({
    agent: identity?.agent ?? null,
    name: identity?.name ?? null,
    // Инструмент смены почты в платформе — виден в меню только когда настроен
    // (заданы PLATFORM_* env). На проде выключен, пока их не пропишут.
    platformToolEnabled: platformEnabled(),
    // Вкладка логов — так же, видна только когда настроен сервис
    // juz40-vpn-logs (LOGS_SERVICE_URL/LOGS_SERVICE_TOKEN).
    logsToolEnabled: logsServiceEnabled(),
  });
}
