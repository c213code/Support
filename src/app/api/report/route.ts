import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildReport } from "@/lib/reportExtras";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  // text — для превью и обычной вставки, html — для копирования со
  // ссылками (см. lib/copyReport.ts).
  const { text, html } = await buildReport(date);
  return NextResponse.json({ text, html });
}
