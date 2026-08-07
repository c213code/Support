import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentIdentity } from "@/lib/auth";
import { isIssueStatus } from "@/lib/status";
import { cleanTicketDescription } from "@/lib/textClean";

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
  const identity = await getCurrentIdentity();
  if (!identity) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  if (!body?.reportDate || !body?.groupName || !body?.description) {
    return NextResponse.json(
      { error: "reportDate, groupName and description are required" },
      { status: 400 }
    );
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
      description: cleanTicketDescription(body.description),
      telegramLink: body.telegramLink || null,
      status: isIssueStatus(body.status) ? body.status : "SENT",
      note: body.note || null,
      ticketLink: body.ticketLink || null,
      createdBy: identity.name,
    },
  });

  return NextResponse.json({ issue }, { status: 201 });
}
