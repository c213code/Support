import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import {
  VpnServiceError,
  getVpnServiceStatus,
  startVpnService,
  stopVpnService,
  vpnServiceConfigured,
} from "@/lib/vpnService";

// SSH-выполнение — не Edge-совместимо, нужен Node runtime.
export const runtime = "nodejs";

function errorStatus(code: VpnServiceError["code"]): number {
  if (code === "not_configured") return 501;
  return 502;
}

export async function GET() {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!vpnServiceConfigured()) {
    return NextResponse.json({ configured: false, status: null });
  }
  try {
    const status = await getVpnServiceStatus();
    return NextResponse.json({ configured: true, status });
  } catch (err) {
    const code = err instanceof VpnServiceError ? err.code : "command_failed";
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Не удалось получить статус" },
      { status: errorStatus(code) }
    );
  }
}

export async function POST(request: NextRequest) {
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (body?.action !== "start" && body?.action !== "stop") {
    return NextResponse.json({ error: "action должен быть start или stop" }, { status: 400 });
  }

  try {
    if (body.action === "start") {
      await startVpnService();
    } else {
      await stopVpnService();
    }
    const status = await getVpnServiceStatus();
    return NextResponse.json({ ok: true, status });
  } catch (err) {
    const code = err instanceof VpnServiceError ? err.code : "command_failed";
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Команда не выполнена" },
      { status: errorStatus(code) }
    );
  }
}
