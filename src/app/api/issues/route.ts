import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { AGENTS } from "@/lib/agents";

export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date is required" }, { status: 400 });
  }

  const issues = await prisma.issue.findMany({
    where: { reportDate: date },
    orderBy: [{ position: "asc" }],
  });

  return NextResponse.json({ issues });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (
    !body?.reportDate ||
    !body?.groupName ||
    !body?.description ||
    !body?.createdBy
  ) {
    return NextResponse.json(
      { error: "reportDate, groupName, description and createdBy are required" },
      { status: 400 }
    );
  }

  if (!AGENTS.includes(body.createdBy)) {
    return NextResponse.json({ error: "invalid createdBy" }, { status: 400 });
  }

  const last = await prisma.issue.findFirst({
    where: { reportDate: body.reportDate, groupName: body.groupName },
    orderBy: { position: "desc" },
  });

  const issue = await prisma.issue.create({
    data: {
      reportDate: body.reportDate,
      groupName: body.groupName,
      groupEmoji: body.groupEmoji ?? null,
      position: (last?.position ?? 0) + 1,
      description: body.description,
      telegramLink: body.telegramLink || null,
      status: body.status === "RESOLVED" ? "RESOLVED" : "PENDING",
      note: body.note || null,
      ticketLink: body.ticketLink || null,
      createdBy: body.createdBy,
    },
  });

  return NextResponse.json({ issue }, { status: 201 });
}
