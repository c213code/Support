import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { submissionFormEnabled, verifyInitData } from "@/lib/miniapp";
import { requestFeedback } from "@/lib/feedbackRequest";

// «КБ сұрау» из «Менің өтініштерім»: бот спрашивает в группе реплаем на пост
// обращения, что с ним (см. lib/feedbackRequest.ts). Кто спрашивает — по
// подписи Telegram (initData) в теле; право и частоту проверяет
// requestFeedback.
export async function POST(request: NextRequest) {
  if (!submissionFormEnabled()) {
    return NextResponse.json({ error: "Форма әзірге өшірулі" }, { status: 503 });
  }
  const body = (await request.json().catch(() => null)) as {
    initData?: unknown;
    submissionId?: unknown;
  } | null;
  const check = verifyInitData(typeof body?.initData === "string" ? body.initData.slice(0, 8192) : "");
  if (!check.ok) {
    return NextResponse.json({ error: "Форманы боттан қайта ашыңыз" }, { status: 401 });
  }
  const submissionId = typeof body?.submissionId === "string" ? body.submissionId : "";
  const result = await requestFeedback(submissionId, check.user.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, via: result.via });
}
