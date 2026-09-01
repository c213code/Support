import { NextResponse } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { platformEnabled } from "@/lib/platform";

export async function GET() {
  const identity = await getCurrentIdentity();
  return NextResponse.json({
    agent: identity?.agent ?? null,
    name: identity?.name ?? null,
    // Инструмент смены почты в платформе — виден в меню только когда настроен
    // (заданы PLATFORM_* env). На проде выключен, пока их не пропишут.
    platformToolEnabled: platformEnabled(),
  });
}
