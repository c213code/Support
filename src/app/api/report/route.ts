import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateReportText } from "@/lib/report";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  const [issues, groups] = await Promise.all([
    prisma.issue.findMany({
      where: { reportDate: date },
      orderBy: [{ position: "asc" }],
    }),
    prisma.groupPreset.findMany({ orderBy: { order: "asc" } }),
  ]);

  const text = generateReportText(issues, groups);

  return NextResponse.json({ text });
}
