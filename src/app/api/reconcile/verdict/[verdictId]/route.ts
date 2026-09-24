import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getCurrentIdentity } from "@/lib/auth";
import { verdictInput } from "@/lib/reconcileRun";

type Params = { params: Promise<{ verdictId: string }> };

// Что видела модель по одному решению «Авто-репорта» — описание и ленту
// переписки. Отдельно от журнала: это килобайты на тикет.
export async function GET(_request: NextRequest, { params }: Params) {
  const identity = await getCurrentIdentity();
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { verdictId } = await params;
  return NextResponse.json({ input: await verdictInput(verdictId) });
}
