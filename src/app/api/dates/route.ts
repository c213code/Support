import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const rows = await prisma.issue.groupBy({
    by: ["reportDate"],
    _count: { _all: true },
    orderBy: { reportDate: "desc" },
  });

  const dates = rows.map((r) => ({
    date: r.reportDate,
    count: r._count._all,
  }));

  return NextResponse.json({ dates });
}
